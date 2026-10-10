// PLAN.md S2.5: the HTTP surface — `POST /mcp`, `GET /healthz`, `GET /status`.
//
// ADR 0001: Express + `@modelcontextprotocol/express` middleware + `createMcpHandler`.

import express, { type Express, type Request, type Response } from 'express';
import { originValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { createBearerAuth } from './auth.js';
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

  // D9: `GET /status` requires auth.
  app.get('/status', (req: Request, res: Response) => {
    const outcome = auth.authorize(req.headers.authorization);
    if (!outcome.ok) {
      logger.warn({ reason: outcome.reason }, 'unauthenticated GET /status');
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
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
      if (!outcome.ok) {
        logger.warn({ reason: outcome.reason }, 'unauthenticated POST /mcp');
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
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

export { aggregateCallTool };