// PLAN.md S5.6: a fake authorization server, in-repo, for CI.
//
// It implements exactly the surface the SDK's `auth()` uses, and nothing more:
//
//   /.well-known/oauth-protected-resource/mcp   -> RFC 9728 protected resource metadata
//   /.well-known/oauth-authorization-server     -> RFC 8414 authorization server metadata
//   /authorize                                  -> issues a code + iss, requires PKCE S256
//   /token                                      -> code exchange and refresh
//
// D15: LOCAL only. No third-party service is contacted from CI.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeAuthServerOptions {
  port: number;
  /** Issuer identifier. Defaults to `http://127.0.0.1:<port>`. */
  issuer?: string;
  /** Advertise `client_id_metadata_document_supported` (the CIMD branch). */
  cimd?: boolean;
  /** Omit `registration_endpoint`, disabling Dynamic Client Registration. */
  noDynamicRegistration?: boolean;
  /** Advertise `authorization_response_iss_parameter_supported: true`. */
  issSupported?: boolean;
  /** Make every /token call fail, to exercise the refresh-failure path. */
  tokenEndpointFails?: boolean;
  /** Access token lifetime in seconds. */
  expiresIn?: number;
}

export interface FakeAuthServer {
  url: string;
  issuer: string;
  close: () => Promise<void>;
  // --- observations a test asserts on ---
  /** Every client_id the server issued or accepted, in order. */
  seenClientIds: string[];
  /** Every code_verifier presented at /token. */
  seenVerifiers: string[];
  /** Every `resource` parameter seen, from both authorize and token. */
  seenResources: string[];
  /** Every `iss` the server emitted on the redirect. */
  emittedIss: string[];
  /** Verifier for a code, so a test can prove PKCE actually bound. */
  verifierFor: (code: string) => string | undefined;
  /** Issues an authorization code directly, bypassing the browser hop. */
  issueCode: (opts: { codeChallenge?: string; redirectUri: string; resource?: string; iss?: string }) => string;
  /** A complete `?...` callback URL for a code, as the AS would redirect. */
  callbackUrl: (code: string, state: string, iss?: string) => string;
  server: Server;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Used only when a registration request omits redirect_uri entirely. */
const CALLBACK_FALLBACK = 'http://localhost:3000/oauth/callback';

function s256(verifier: string): string {
  // verified: tools.ietf.org/html/rfc7636#appendix-A (S256 = base64url(sha256(verifier)))
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function startFakeAuthServer(options: FakeAuthServerOptions): Promise<FakeAuthServer> {
  const issuer = options.issuer ?? `http://127.0.0.1:${options.port}`;
  const base = `http://127.0.0.1:${options.port}`;
  const expiresIn = options.expiresIn ?? 3600;

  const seenClientIds: string[] = [];
  const seenVerifiers: string[] = [];
  const seenResources: string[] = [];
  const emittedIss: string[] = [];
  const verifiers = new Map<string, string>();
  const codes = new Set<string>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;

    // --- RFC 9728 protected resource metadata -----------------------------------
    if (path === '/.well-known/oauth-protected-resource/mcp') {
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [issuer] });
      return;
    }

    // --- RFC 8414 authorization server metadata ---------------------------------
    if (path === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        ...(options.noDynamicRegistration === true ? {} : { registration_endpoint: `${base}/register` }),
        ...(options.cimd === true ? { client_id_metadata_document_supported: true } : {}),
        ...(options.issSupported === true ? { authorization_response_iss_parameter_supported: true } : {}),
      });
      return;
    }

    // --- Dynamic Client Registration (deprecated branch) --------------------------
    if (path === '/register') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        // Echo the redirect_uri the client registered. Returning an empty one fails the
        // client's own metadata validation, which would hide the branch under test.
        const requested = form.get('redirect_uri');
        const redirectUris = requested === null || requested === '' ? [CALLBACK_FALLBACK] : [requested];
        const clientId = `dcr-client-${randomBytes(4).toString('hex')}`;
        seenClientIds.push(clientId);
        json(res, 201, {
          client_id: clientId,
          client_secret: 'dcr-secret',
          redirect_uris: redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
        });
      });
      return;
    }

    // --- authorization endpoint ---------------------------------------------------
    if (path === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const clientId = url.searchParams.get('client_id') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const method = url.searchParams.get('code_challenge_method') ?? '';
      const resource = url.searchParams.get('resource');
      if (resource !== null) seenResources.push(resource);
      seenClientIds.push(clientId);

      if (challenge === '' || method !== 'S256') {
        json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 is required' });
        return;
      }

      // The fake does not have a browser; the test drives the redirect itself.
      const code = `code-${randomBytes(8).toString('hex')}`;
      codes.add(code);
      verifiers.set(code, challenge);
      json(res, 200, {
        code,
        state,
        redirect_uri: redirectUri,
        ...(resource === null ? {} : { resource }),
      });
      return;
    }

    // --- token endpoint ------------------------------------------------------------
    if (path === '/token') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const clientId = form.get('client_id') ?? '';
        const resource = form.get('resource');
        if (resource !== null) seenResources.push(resource);
        seenClientIds.push(clientId);

        if (options.tokenEndpointFails === true) {
          json(res, 400, { error: 'invalid_grant', error_description: 'refresh token is not valid' });
          return;
        }

        const grant = form.get('grant_type');

        if (grant === 'refresh_token') {
          const presented = form.get('refresh_token') ?? '';
          if (!refreshTokens.has(presented)) {
            json(res, 400, { error: 'invalid_grant' });
            return;
          }
          refreshTokens.delete(presented);
          const access = `access-${randomBytes(8).toString('hex')}`;
          // Rotate the refresh token and STORE THE ONE WE RETURN. Generating two different
          // strings here would issue the client a refresh token the server then rejects.
          const refresh = `refresh-${randomBytes(8).toString('hex')}`;
          accessTokens.add(access);
          refreshTokens.add(refresh);
          json(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: expiresIn,
            refresh_token: refresh,
          });
          return;
        }

        if (grant !== 'authorization_code') {
          json(res, 400, { error: 'unsupported_grant_type' });
          return;
        }

        const code = form.get('code') ?? '';
        const verifier = form.get('code_verifier') ?? '';
        seenVerifiers.push(verifier);
        if (!codes.has(code)) {
          json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
          return;
        }
        // RFC 7636 §4.6: the verifier must hash to the challenge the code was bound to.
        if (s256(verifier) !== verifiers.get(code)) {
          json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
        codes.delete(code);

        const access = `access-${randomBytes(8).toString('hex')}`;
        const refresh = `refresh-${randomBytes(8).toString('hex')}`;
        accessTokens.add(access);
        refreshTokens.add(refresh);
        json(res, 200, {
          access_token: access,
          token_type: 'Bearer',
          expires_in: expiresIn,
          refresh_token: refresh,
          scope: form.get('scope') ?? '',
        });
      });
      return;
    }

    json(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((r) => server.listen(options.port, '127.0.0.1', () => r()));
  const actualPort = (server.address() as AddressInfo).port;
  const actualBase = `http://127.0.0.1:${actualPort}`;

  return {
    url: actualBase,
    issuer,
    server,
    seenClientIds,
    seenVerifiers,
    seenResources,
    emittedIss,
    verifierFor: (code) => verifiers.get(code),
    issueCode: ({ codeChallenge, redirectUri, resource, iss }) => {
      const code = `code-${randomBytes(8).toString('hex')}`;
      codes.add(code);
      if (codeChallenge !== undefined) verifiers.set(code, codeChallenge);
      if (resource !== undefined) seenResources.push(resource);
      if (iss !== undefined) emittedIss.push(iss);
      void redirectUri;
      return code;
    },
    callbackUrl: (code, state, iss) => {
      const params = new URLSearchParams({ code, state });
      const effectiveIss = iss ?? (options.issSupported === true ? issuer : undefined);
      if (effectiveIss !== undefined) {
        params.set('iss', effectiveIss);
        emittedIss.push(effectiveIss);
      }
      return `${actualBase}/callback?${params.toString()}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}