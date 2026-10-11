// PLAN.md §5: the serve entrypoint. Loads the config, wires the layers, starts the HTTP
// server, and shuts down cleanly.

import type { Server } from 'node:http';

import { loadConfig } from './config/load.js';
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
import { dirname, join, resolve } from 'node:path';
import { ConfigReloader } from './server/reload.js';

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
}

export async function startGateway(options: StartOptions = {}): Promise<RunningGateway> {
  const { config, path } = loadConfig(options.configPath === undefined ? {} : { path: options.configPath });

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
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const storePath =
    configured !== undefined && configured.length > 0
      ? resolve(configured)
      : join(dirname(configPath), 'data', 'tokens.enc.json');
  const store = new TokenStore({ path: storePath, key });
  logger.info({ tokenStore: store.path }, 'upstream OAuth configured; encrypted token store enabled');
  return new OAuthService({ config, store, logger, port });
}

async function main(): Promise<void> {
  try {
    const gateway = await startGateway();
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
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}

export { aggregateToolsList };