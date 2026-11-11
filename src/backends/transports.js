import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Buat transport klien sesuai `type` backend: http (default) | sse | stdio. */
export function createTransport(cfg, provider) {
  const kind = cfg.type ?? "http";
  const headers = cfg.headers ?? {};
  if (kind === "http") {
    return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers }, authProvider: provider });
  }
  if (kind === "sse") {
    return new SSEClientTransport(new URL(cfg.url), {
      requestInit: { headers },
      eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, ...headers } }) },
      authProvider: provider,
    });
  }
  if (kind === "stdio") {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...(cfg.env ?? {}) }).filter(([, v]) => v !== undefined),
    );
    return new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env });
  }
  throw new Error(`type tidak dikenal: ${kind}`);
}
