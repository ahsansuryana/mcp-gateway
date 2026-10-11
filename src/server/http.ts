// PLAN.md S2.5: the HTTP surface — `POST /mcp`, `GET /healthz`, `GET /status`.
//
// ADR 0001: Express + `@modelcontextprotocol/express` middleware + `createMcpHandler`.

import express, { type Express, type Request, type Response } from 'express';
import { originValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { createBearerAuth } from './auth.js';
import { OAuthService } from '../auth/oauth-client/service.js';
import { ResourceServer } from '../auth/oauth-resource/resource-server.js';
import { RateLimiter } from './rate-limit.js';
import { buildGatewayMcp } from './mcp.js';
import { aggregateCallTool, type ToolsAggregatorDeps } from '../aggregate/tools.js';
import type { Logger } from '../observability/logger.js';
import type { GatewayConfig } from '../config/schema.js';

/** PLAN.md S2.5: request body size limit, 1 MiB. */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export interface BuildHttpOptions {
  config: GatewayConfig;
  aggregator: ToolsAggregatorDeps;
  logger: Logger;
  /** Origin allowlist; defaults to the publicUrl host plus localhost-class names. */
  allowedOriginHostnames?: readonly string[];
  /** Injectable for tests. */
  now?: () => number;
  /**
   * PLAN.md S5.4. Absent when no upstream configures `oauth`, in which case the two OAuth
   * routes are not registered at all rather than answering 404 for a feature nobody uses.
   */
  oauth?: OAuthService;
}

export interface HttpApp {
  app: Express;
  /** Hostnames the Origin header is validated against. */
  allowedOrigins: readonly string[];
  /** S3.4: the `subscriptions/listen` fan-out bound to this handler. */
  startFanout: () => Promise<void>;
  stopFanout: () => Promise<void>;
}

/**
 * Origin allowlist (PLAN.md §8: "Origin validation per the Streamable HTTP spec page").
 * verified: docs/ref/spec-2026-07-28-basic-transports-streamable-http.md (Security &
 *   Endpoint: a present-but-invalid Origin MUST be answered 403)
 * verified: spikes/node_modules/@modelcontextprotocol/express/dist/index.d.mts
 *   (originValidation takes HOSTNAMES only, port-agnostic)
 */
export function resolveAllowedOrigins(config: GatewayConfig): string[] {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  if (config.gateway.publicUrl !== undefined) {
    hosts.add(new URL(config.gateway.publicUrl).hostname);
  }
  return [...hosts];
}

export function buildHttpApp(options: BuildHttpOptions): HttpApp {
  const { config, aggregator, logger } = options;
  const allowedOrigins = options.allowedOriginHostnames ?? resolveAllowedOrigins(config);

  // `createMcpExpressApp` defaults to 127.0.0.1 and only auto-enables DNS-rebinding
  // protection for localhost-class binds; this app is plain Express so the allowlist is
  // explicit for every bind (docs/adr/0001-http-layer.md).
  const app = express();

  // The limit is set at BOTH layers on purpose: Express rejects first so an oversized body
  // never reaches the SDK, and the SDK's own bound is the backstop.
  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));

  // D9: `GET /healthz` is unauthenticated and returns ONLY {"ok":true}.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  const auth = createBearerAuth(config.gateway.auth.keys);

  // PLAN.md S7.2. Keyed by the authenticated identity, never by IP: behind a proxy every
  // caller shares one, and D9 forbids revealing anything about the presented key.
  const rateLimitConfig = config.gateway.rateLimit;
  const rateLimiter = new RateLimiter({
    limit: rateLimitConfig?.requests ?? 0,
    windowMs: rateLimitConfig?.windowMs ?? 60_000,
  });

  /** Applies the bucket once the caller is identified. */
  const enforceRateLimit = (res: Response, subject: string): boolean => {
    if (!rateLimiter.enabled) return true;
    const decision = rateLimiter.check(subject);
    if (decision.allowed) return true;
    res.setHeader('Retry-After', String(decision.retryAfterSeconds ?? 1));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.status(429).json({ error: 'rate limited' });
    return false;
  };

  // --- PLAN.md S6.1: protected resource -------------------------------------------
  // Requires publicUrl: the metadata document and the audience are both derived from it,
  // and a gateway with no public URL has no canonical resource identifier to publish.
  const oauthConfig = config.gateway.authOAuth;
  // Hoisted so the /mcp handler below can consult it.
  let resourceServer: ResourceServer | undefined = undefined;
  if (oauthConfig !== undefined) {
    if (config.gateway.publicUrl === undefined) {
      throw new Error(
        'gateway.authOAuth requires gateway.publicUrl: the token audience and the ' +
          'protected-resource metadata URL are both derived from it',
      );
    }
    const instance = new ResourceServer({
      issuer: oauthConfig.issuer,
      audience: oauthConfig.audience ?? new URL('/mcp', config.gateway.publicUrl).href,
      ...(oauthConfig.jwksUri === undefined ? {} : { jwksUri: oauthConfig.jwksUri }),
      ...(oauthConfig.scope === undefined ? {} : { scope: oauthConfig.scope }),
      logger,
    });
    resourceServer = instance;
    const publicUrl = config.gateway.publicUrl;

    // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md line 74-75 — MCP
    //   servers MUST implement RFC 9728 protected resource metadata, and clients MUST use it
    //   for authorization server discovery.
    app.get('/.well-known/oauth-protected-resource/mcp', (_req: Request, res: Response) => {
      res.setHeader('cache-control', 'public, max-age=300');
      res.status(200).json(instance.protectedResourceMetadata(publicUrl, '/mcp', 'mcp-gateway'));
    });
    // The root form the spec lists as the alternative discovery location.
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
      res.setHeader('cache-control', 'public, max-age=300');
      res.status(200).json(instance.protectedResourceMetadata(publicUrl, '/mcp', 'mcp-gateway'));
    });

    logger.info(
      { issuer: resourceServer.issuer, audience: resourceServer.audience },
      'OAuth protected resource enabled',
    );
  }

  // --- PLAN.md P6-1: the Client ID Metadata Document -------------------------------
  // Only registered when publicUrl is set. A gateway with no public URL has no identity to
  // publish, and serving a document whose client_id cannot be validated would be worse than
  // 404: an authorization server fetches it and rejects it.
  if (options.oauth !== undefined && options.oauth.clientMetadataUrl !== undefined) {
    const metadataPath = OAuthService.CLIENT_METADATA_PATH;
    // Unauthenticated on purpose. An authorization server fetches this document BEFORE any
    // user credential exists; requiring the gateway bearer key would make CIMD impossible.
    // The document contains no secret: client_id, client_name and redirect_uris only.
    app.get(metadataPath, (_req: Request, res: Response) => {
      const document = options.oauth!.clientMetadataDocument();
      // verified: docs/ref/spec-2026-07-28-basic-authorization-client-registration.md
      //   line 43 — "Clients MUST ensure the client_id value in the metadata matches the
      //   document URL exactly". That holds because `client_id` is derived from
      //   gateway.publicUrl, which is where this document is actually published, rather
      //   than from the request, whose Host header is caller-controlled.
      res.setHeader('cache-control', 'public, max-age=300');
      res.status(200).json(document);
    });
  }

  // --- PLAN.md S5.4: upstream OAuth routes -------------------------------------
  // Both sit behind the gateway's own bearer key: an unauthenticated caller must not be
  // able to start or complete an authorization for an operator's upstream.
  if (options.oauth !== undefined) {
    const oauth = options.oauth;

    app.get('/admin/oauth/:name/start', (req: Request, res: Response) => {
      const outcome = auth.authorize(req.headers.authorization);
      if (!outcome.ok) {
        logger.warn({ reason: outcome.reason }, 'unauthenticated GET /admin/oauth/:name/start');
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const name = String(req.params['name'] ?? '');
      if (!oauth.isOAuthUpstream(name)) {
        res.status(404).json({ error: `upstream '${name}' has no oauth configuration` });
        return;
      }
      void oauth
        .start(name)
.then((result) => {
          if (result.authorized) {
            res.status(200).json({ upstream: name, authorized: true, method: result.method });
            return;
          }
          // 302 to the authorization server. The URL carries `state`, `code_challenge` and
          // `resource`; none of them is a secret the gateway must keep to itself, and none
          // is logged here.
          res.redirect(302, result.url ?? '/status');
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // OAuthServiceError messages are written to never contain a token, code or
          // client secret (src/auth/oauth-client/service.ts).
          logger.warn({ upstream: name, reason: message }, 'could not start upstream authorization');
          res.status(502).json({ error: message });
        });
    });

    app.get('/oauth/callback', (req: Request, res: Response) => {
      const query = req.query as Record<string, string | undefined>;
      const errorDescription = typeof query['error_description'] === 'string' ? query['error_description'] : undefined;
      void oauth
        .callback({
          ...(typeof query['code'] === 'string' ? { code: query['code'] } : {}),
          ...(typeof query['state'] === 'string' ? { state: query['state'] } : {}),
          ...(typeof query['iss'] === 'string' ? { iss: query['iss'] } : {}),
          ...(typeof query['error'] === 'string' ? { error: query['error'] } : {}),
          ...(errorDescription === undefined ? {} : { errorDescription }),
        })
.then((result) => {
          res.status(200).json({ upstream: result.upstreamName, authorized: true });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ reason: message }, 'upstream OAuth callback failed');
          res.status(400).json({ error: message });
        });
    });
  }

  // D9: `GET /status` requires auth.
  app.get('/status', (req: Request, res: Response) => {
    const outcome = auth.authorize(req.headers.authorization);
    if (!outcome.ok) {
      logger.warn({ reason: outcome.reason }, 'unauthenticated GET /status');
      // A static-key failure gets a bare challenge; the full RFC 9728 pointer is only
      // meaningful to a client that can act on it, and `auth` here is the static path.
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!enforceRateLimit(res, `status:${API_KEY_ID}`)) return;
    res.status(200).json({
      gateway: {
        host: config.gateway.host,
        port: config.gateway.port,
        publicUrl: config.gateway.publicUrl ?? null,
        legacyEra: config.gateway.legacyEra,
        defaultTimeoutMs: config.gateway.defaultTimeoutMs,
        defaultTtlMs: config.gateway.defaultTtlMs,
        // The COUNT only: PLAN.md rule 9 forbids the values in /status.
        inboundAuthKeys: config.gateway.auth.keys.length,
        configuredUpstreams: Object.keys(config.mcp).length,
        // S6.1: the ISSUER is not a secret (it is published in the metadata document), so
        // it is safe and useful to report. No token, key or JWKS content ever appears here.
        ...(oauthConfig === undefined
          ? {}
          : {
              oauthIssuer: oauthConfig.issuer,
              oauthAudience: resourceServer?.audience ?? null,
            }),
      },
      upstreams: aggregator.manager.reports(),
    });
  });

  const built = buildGatewayMcp({
    config,
    aggregator,
    logger,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  const nodeHandler = toNodeHandler(built.handler, { maxRequestBodySize: MAX_REQUEST_BODY_BYTES });

  app.post(
    '/mcp',
    originValidation([...allowedOrigins]),
    (req: Request, res: Response, next: (err?: unknown) => void) => {
      const outcome = auth.authorize(req.headers.authorization);

      if (!outcome.ok && resourceServer !== undefined) {
        // PLAN.md S6.1 / ADR 0009: either credential is sufficient, and a failed OAuth check
        // never falls back to being read as a static key (nor the reverse).
        //
        // `auth.authorize` has already consumed the header for the static path; re-extract
        // it verbatim for the JWT. The token itself never reaches a log line.
        void resourceServer
          .verify(bearerOf(req.headers.authorization))
  .then((result) => {
            if (result.ok) {
              nodeHandler(req, res, req.body as unknown).catch(next);
              return;
            }
            // verified: docs/ref/spec-2026-07-28-basic-authorization-index.md lines 323 —
            //   401 means "Authorization required or token invalid".
            // verified: docs/ref/claude-connector-requirements.md — a 401 carrying
            //   WWW-Authenticate is REQUIRED; the header is ignored on a 200.
            res.setHeader(
              'WWW-Authenticate',
              resourceServer.challenge(config.gateway.publicUrl ?? '', '/mcp', result.reason),
            );
            logger.warn({ reason: result.reason }, 'rejected POST /mcp: OAuth');
            res.status(401).json({ error: 'unauthorized' });
          })
          .catch(next);
        return;
      }

      if (!outcome.ok) {
        logger.warn({ reason: outcome.reason }, 'unauthenticated POST /mcp');
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (!enforceRateLimit(res, `mcp:${API_KEY_ID}`)) return;
      nodeHandler(req, res, req.body as unknown).catch(next);
    },
  );

  logger.debug({ allowedOrigins }, 'http app configured');
  return {
    app,
    allowedOrigins,
    startFanout: built.startFanout,
    stopFanout: built.stopFanout,
  };
}

/**
 * Extracts the bearer token from an Authorization header.
 *
 * verified: docs/ref/spec-2026-07-28-basic-authorization-index.md line 273 — access tokens
 *   MUST NOT be included in the URI query string, so the header is the only place to look.
 */
/**
 * Identity for rate-limit bucketing.
 *
 * The static-key path has one shared identity, which is correct: those callers are
 * anonymous as far as the gateway is concerned, and distinguishing them by IP would make
 * a proxy collapse everyone into one bucket. The OAuth path is not yet wired into the
 * bucket key; a subject-aware key is the obvious next step and is recorded in BACKLOG.
 */
const API_KEY_ID = 'static-bearer';

function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export { aggregateCallTool };