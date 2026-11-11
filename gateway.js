#!/usr/bin/env node
/**
 * MCP Gateway: banyak MCP server dijadikan satu endpoint /mcp.
 *
 * Entry point tipis. Kode ada di ./src (lihat README bagian "Struktur proyek").
 *
 *   node gateway.js                    # pakai ./gateway.json
 *   node gateway.js -c /path/conf.json
 */
import { main } from "./src/main.js";

main();
