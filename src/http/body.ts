import type { IncomingMessage } from "node:http";

/** Baca body mentah dengan batas ukuran (untuk endpoint OAuth). */
export async function readRaw(req: IncomingMessage, limit = 65536): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error("body terlalu besar");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Parse body JSON atau form-urlencoded sesuai Content-Type. */
export const parseBody = (req: IncomingMessage, raw: string): Record<string, any> =>
  (req.headers["content-type"] ?? "").includes("json")
    ? raw
      ? JSON.parse(raw)
      : {}
    : Object.fromEntries(new URLSearchParams(raw));

/** Baca body JSON untuk /mcp (undefined bila kosong). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : undefined;
}
