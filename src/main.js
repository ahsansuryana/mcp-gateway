import { createApp } from "./app.js";
import { log } from "./utils/logger.js";

/**
 * Jalankan:
 *   node gateway.js                    # pakai ./gateway.json
 *   node gateway.js -c /path/conf.json
 */
export function main(argv = process.argv) {
  const i = argv.findIndex((a) => a === "-c" || a === "--config");
  const configPath = i > -1 ? argv[i + 1] : "gateway.json";

  const app = createApp(configPath);
  app.start();

  const shutdown = async () => {
    log("INFO", "shutdown...");
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return app;
}
