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

export interface RunningGateway {
  server: Server;
  manager: UpstreamManager;
  port: number;
  /** Exposed so the process-level signal handler can log its decisions. */
  logger: Logger;
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

  const manager = new UpstreamManager(config, { secrets, logger });
  const aggregator: ToolsAggregatorDeps = {
    manager,
    logger,
    defaultTtlMs: config.gateway.defaultTtlMs,
  };

  const { app, startFanout, stopFanout } = buildHttpApp({ config, aggregator, logger });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.gateway.port, config.gateway.host, () => resolve(s));
    s.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.gateway.port;

  // D8: a failure here never blocks startup; broken upstreams surface in /status.
  await manager.start();
  // S3.4: subscribe upstream and fan change events out. Never fatal.
  await startFanout().catch((err: unknown) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'subscriptions fan-out did not start');
  });
  logger.info({ port, upstreams: manager.reports() }, 'gateway listening');

  return {
    server,
    manager,
    port,
    logger,
    stop: async () => {
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