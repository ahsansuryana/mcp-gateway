#!/usr/bin/env node
/**
 * MCP Gateway: banyak MCP server dijadikan satu endpoint /mcp.
 *
 *   mcp-gateway                    # pakai ./gateway.json
 *   mcp-gateway -c /path/conf.json
 */
import { startGateway } from "./app.js";
import { ConfigError } from "./config/load.js";

function parseConfigPath(argv: string[]): string {
  const i = argv.findIndex((a) => a === "-c" || a === "--config");
  if (i === -1) return "gateway.json";
  const value = argv[i + 1];
  if (!value) {
    console.error("opsi -c/--config membutuhkan path file konfigurasi");
    process.exit(1);
  }
  return value;
}

try {
  startGateway(parseConfigPath(process.argv.slice(2)));
} catch (e) {
  console.error(e instanceof ConfigError || e instanceof Error ? e.message : e);
  process.exit(1);
}
