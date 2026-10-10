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
  stop: () => Promise<void>;
}

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

  const manager = new UpstreamManager(config, { secrets });
  const aggregator: ToolsAggregatorDeps = {
    manager,
    logger,
    defaultTtlMs: config.gateway.defaultTtlMs,
  };

  const { app } = buildHttpApp({ config, aggregator, logger });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.gateway.port, config.gateway.host, () => resolve(s));
    s.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.gateway.port;

  // D8: a failure here never blocks startup; broken upstreams surface in /status.
  await manager.start();
  logger.info({ port, upstreams: manager.reports() }, 'gateway listening');

  return {
    server,
    manager,
    port,
    stop: async () => {
      await manager.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('gateway stopped');
    },
  };
}

async function main(): Promise<void> {
  try {
    const gateway = await startGateway();
    const shutdown = (): void => {
      void gateway.stop().then(() => process.exit(EXIT_OK));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
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