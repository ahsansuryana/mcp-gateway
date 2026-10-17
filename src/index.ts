// PLAN.md §5: the serve entrypoint. Loads the config, wires the layers, starts the HTTP
// server, and shuts down cleanly.

import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import { existsSync } from 'node:fs';

import { loadConfig } from './config/load.js';
import { legacyTokenStorePathFor, tokenStorePathFor } from './config/paths.js';
import { aggregateToolsList, type ToolsAggregatorDeps } from './aggregate/tools.js';
import { buildHttpApp } from './server/http.js';
import { createLogger, secretsFromConfig, type Logger } from './observability/logger.js';
import { configSummary } from './observability/redact.js';
import { UpstreamManager } from './upstream/manager.js';
import { EXIT_INVALID, EXIT_OK } from './cli.js';
import { ConfigErrorList } from './config/load.js';
import type { GatewayConfig } from './config/schema.js';
import { OAuthService } from './auth/oauth-client/service.js';
import { TokenStore, loadTokenKey } from './auth/oauth-client/token-store.js';
import { resolve } from 'node:path';
import { ConfigReloader } from './server/reload.js';
import { applyOverrides, type ServeFlags } from './serve-flags.js';

export interface RunningGateway {
  server: Server;
  manager: UpstreamManager;
  port: number;
  /** Exposed so the process-level signal handler can log its decisions. */
  logger: Logger;
  /** S7.1: the config watcher; `stop()` detaches its SIGHUP listener. */
  reloader: ConfigReloader;
  stop: () => Promise<void>;
}

/**
 * PLAN.md S4.5: how long a graceful stop may run before child processes are killed.
 * The SDK's own close() can already take ~4s per child, so this is a ceiling on the whole
 * shutdown, not a delay added to it.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * PLAN.md S7.3: how long in-flight requests may finish after the listener stops accepting.
 */
export const DRAIN_MS = 10_000;

/**
 * Stops accepting new connections, then waits for in-flight requests to finish.
 *
 * `server.close()` only stops the LISTENER; existing keep-alive connections and in-flight
 * responses must be given time, and the promise only settles once they are done. The
 * deadline is a backstop so a stuck request cannot hold the process open forever.
 *
 * verified: nodejs.org/api/http.html#serverclosecallback (server.close — "Stops the server
 *   from accepting new connections and closes all connections connected to this server
 *   which are not sending a request or waiting for a response"; the callback fires when
 *   all connections are ended).
 */
function closeServer(server: Server, drainMs: number, logger: Logger): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (how: string): void => {
      if (settled) return;
      settled = true;
      logger.info({ how }, 'http listener closed');
      resolve();
    };

    if (drainMs <= 0) {
      server.closeAllConnections?.();
      server.close(() => finish('immediate'));
      return;
    }

    const timer = setTimeout(() => {
      logger.warn({ drainMs }, 'drain deadline exceeded; closing remaining connections');
      // verified: nodejs.org/api/http.html#servercloseallconnections
      server.closeAllConnections?.();
      finish('drain-timeout');
    }, drainMs);
    timer.unref?.();

    server.close(() => {
      clearTimeout(timer);
      finish('drained');
    });
    // New connections are refused from this point on; existing ones keep their deadline.
  });
}

export interface StartOptions {
  /** Overrides the config path (tests pass a fixture). */
  configPath?: string;
  /** Overrides the logger (tests pass a silent one). */
  logger?: Logger;
  /** `silent` keeps the gateway's own logs out of a test's stdout. */
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /**
   * S5.2: overrides the encrypted token store path. Defaults to
   * `GATEWAY_TOKEN_STORE`, then `data/tokens.enc.json` beside the CONFIG file. Tests set
   * this so parallel gateways never share one file.
   */
  tokenStorePath?: string;
  /**
   * ADR 0013: `--hostname` / `--port` / `--public-url`. Applied to the parsed config
   * BEFORE the HTTP app is built, because the Origin allowlist, the RFC 9728 audience and
   * the CIMD client_id are all derived from the config at build time. Applied afterwards
   * they would change the banner while leaving the OAuth metadata pointing at the old
   * host, which surfaces as an `audience mismatch`.
   */
  flags?: ServeFlags;
}

export async function startGateway(options: StartOptions = {}): Promise<RunningGateway> {
  const loaded = loadConfig(options.configPath === undefined ? {} : { path: options.configPath });
  // Throws UsageError for a malformed --public-url, which the CLI turns into exit 2.
  const config =
    options.flags === undefined ? loaded.config : applyOverrides(loaded.config, options.flags);
  const { path } = loaded;

  const secrets = secretsFromConfig(config);
  // D9 / D14: register the literal secret values so no log line can ever carry one.
  const logger =
    options.logger ??
    createLogger({
      secrets,
      base: { app: 'mcp-gateway' },
      ...(options.logLevel === undefined ? {} : { level: options.logLevel }),
    });
  logger.info({ config: path, ...configSummary(config) }, 'gateway starting');

  // S5.4: `port` is assigned by `listen()` below, so the OAuth service reads it lazily.
  let port = config.gateway.port;
  const oauth = createOAuthServiceIfConfigured(config, logger, () => port, options.tokenStorePath, path);

  const manager = new UpstreamManager(config, {
    secrets,
    logger,
    ...(oauth === undefined
      ? {}
      : { authProviderFor: (name: string) => oauth.providerFor(name) }),
  });
  const aggregator: ToolsAggregatorDeps = {
    manager,
    logger,
    defaultTtlMs: config.gateway.defaultTtlMs,
  };

  const { app, startFanout, stopFanout } = buildHttpApp({
    config,
    aggregator,
    logger,
    ...(oauth === undefined ? {} : { oauth }),
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.gateway.port, config.gateway.host, () => resolve(s));
    s.on('error', reject);
  });

  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : config.gateway.port;

  // D8: a failure here never blocks startup; broken upstreams surface in /status.
  await manager.start();
  // S3.4: subscribe upstream and fan change events out. Never fatal.
  await startFanout().catch((err: unknown) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'subscriptions fan-out did not start');
  });
  logger.info({ port, upstreams: manager.reports() }, 'gateway listening');

  // S7.1: watch the config file and honour SIGHUP. An invalid new file keeps the running
  // configuration; the reload is applied through the manager so unchanged upstreams, and
  // therefore their OAuth credentials, are left alone.
  const reloader = new ConfigReloader(
    {
      path,
      logger,
      apply: async (next) => {
        await manager.reconfigure(next);
      },
    },
    config,
  );
  reloader.start();

  return {
    server,
    manager,
    port,
    logger,
    reloader,
    stop: async () => {
      reloader.stop();
      // PLAN.md S7.3: stop accepting first, then drain in flight, THEN tear down. A
      // caller mid-request when the process dies gets a truncated stream and no
      // explanation, so accepting stops before anything is dismantled.
      await closeServer(server, DRAIN_MS, logger);
      await stopFanout().catch(() => undefined);
      // A graceful stop gets SHUTDOWN_GRACE_MS in total. If it overruns, any child process
      // tree still alive is killed outright rather than being orphaned.
      let timedOut = false;
      const deadline = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS);
        // Do not hold the event loop open purely for the deadline.
        timer.unref?.();
      });
      await Promise.race([manager.stop().then(() => 'done' as const), deadline]).then(
        (outcome) => {
          timedOut = outcome === 'timeout';
        },
      );
      if (timedOut) {
        logger.warn('graceful shutdown deadline exceeded, killing child process trees');
        await manager.forceStopAll();
      }
      await closeServer(server, 0, logger);
      // S7.3: flush the token store. TokenStore writes through on every change today, so
      // this is a no-op that keeps the contract explicit: a future batching write must not
      // be forgotten here.
      await oauth?.store.flush().catch(() => undefined);
      logger.info('gateway stopped');
    },
  };
}

/**
 * S5.4: builds the OAuth service only when at least one remote upstream configures `oauth`.
 *
 * Requiring GATEWAY_TOKEN_KEY unconditionally would break every deployment that does not use
 * upstream OAuth, so the key is loaded only when the feature is actually configured. A
 * configured-but-unkeyed deployment is a startup error naming the VARIABLE, never its value.
 */
function createOAuthServiceIfConfigured(
  config: GatewayConfig,
  logger: Logger,
  port: () => number,
  tokenStorePath: string | undefined,
  configPath: string,
): OAuthService | undefined {
  const usesOAuth = Object.values(config.mcp).some(
    (upstream) => upstream.type === 'remote' && upstream.oauth !== undefined && upstream.oauth !== false,
  );
  if (!usesOAuth) return undefined;

  const key = loadTokenKey();
  // S5.2 names `data/tokens.enc.json`; where it resolves from is a real decision. Resolving
  // against the process CWD made two gateways started from different directories share one
  // file, and tests running in parallel collided on it — one instance's key could not
  // decrypt another's store, which surfaced as an upstream in `error`. It is anchored to
  // the CONFIG file's directory instead, and overridable per deployment.
  const configured = tokenStorePath ?? process.env['GATEWAY_TOKEN_STORE'];
  let storePath =
    configured !== undefined && configured.length > 0
      ? resolve(configured)
      : tokenStorePathFor(configPath);

  // ADR 0012 D3 — migration, not orphaning. Config that used to be ./gateway.json keeps
  // its store at ./data/tokens.enc.json; with the config now at ./.mcp-gateway/gateway.json
  // the default moved to ./.mcp-gateway/data/tokens.enc.json. If the old file exists and the
  // new one does not, keep USING the old one and say so. Making the user re-consent with
  // every upstream because a config file moved would be a self-inflicted outage, and
  // silently starting with an empty store would look like a working gateway that had
  // forgotten all its credentials.
  if (
    configured === undefined &&
    !existsSync(storePath) &&
    existsSync(legacyTokenStorePathFor(configPath))
  ) {
    storePath = resolve(legacyTokenStorePathFor(configPath));
    logger.warn(
      { tokenStore: storePath },
      'using the token store at its pre-.mcp-gateway location; move it next to the config to silence this',
    );
  }

  const store = new TokenStore({ path: storePath, key });
  logger.info({ tokenStore: store.path }, 'upstream OAuth configured; encrypted token store enabled');
  return new OAuthService({ config, store, logger, port });
}

/**
 * Process entry point.
 *
 * `flags` is what `cli.ts` parsed out of `-c` / `--hostname` / `--port` / `--public-url`.
 * The `-c` part was MISSING: `main()` called `startGateway()` with no options, so the flag
 * `cli.ts` rewrote into `process.argv` was never read and the gateway silently fell back
 * to `$GATEWAY_CONFIG` or `./gateway.json`.
 *
 * That went unnoticed twice over. `serve` itself did not exist until S7.6, so there was
 * nothing to pass the flag to; and when `GATEWAY_CONFIG` happens to hold the same value the
 * fallback is indistinguishable from working. The result was that `-c <path>` appeared to
 * work and quietly started the wrong config.
 */
export async function main(flags: ServeFlags = {}): Promise<void> {
  try {
    const gateway = await startGateway({
      ...(flags.configPath === undefined ? {} : { configPath: flags.configPath }),
      ...(flags.hostname === undefined &&
      flags.port === undefined &&
      flags.publicUrl === undefined
        ? {}
        : { flags }),
    });
    const { logger } = gateway;
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      // A second signal means "I am out of patience": kill the child trees now instead of
      // waiting out the grace period. Without this, an unresponsive child holds the process
      // open for the full deadline after the operator has already given up.
      if (shuttingDown) {
        logger.warn({ signal }, 'second signal, forcing child process kill');
        void gateway.manager.forceStopAll().finally(() => process.exit(EXIT_OK));
        return;
      }
      shuttingDown = true;
      logger.info({ signal }, 'shutdown signal received');
      void gateway.stop().then(() => process.exit(EXIT_OK));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    if (err instanceof ConfigErrorList) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = EXIT_INVALID;
      return;
    }
    throw err;
  }
}

// verified: https://nodejs.org/api/url.html#urlpathtofileurlpath-options (node:url pathToFileURL)
//
// `pathToFileURL` is imported at module scope rather than with `await import()`. A top-level
// await here made this module's evaluation suspend, so any OTHER module importing it --
// including `cli.ts` implementing `serve` -- waited forever and Node reported
// "unsettled top-level await". The static import costs nothing here and removes the hazard.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}

export { aggregateToolsList };