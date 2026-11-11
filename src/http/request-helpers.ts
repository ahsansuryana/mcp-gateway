import type { IncomingMessage } from "node:http";

export interface RequestHelpers {
  /** Issuer yang cocok dengan host yang dipakai klien (RFC 8414 §3.3). */
  baseOf(req: IncomingMessage): string;
  ipOf(req: IncomingMessage): string;
}

export interface RequestHelperOptions {
  publicUrl: string;
  /** Hanya host dalam daftar ini yang diterima sebagai issuer (anti Host-header spoofing). */
  bases: string[];
  trustProxy: boolean;
}

const hostOf = (b: string): string => new URL(b).host.toLowerCase();

export function createRequestHelpers({ publicUrl, bases, trustProxy }: RequestHelperOptions): RequestHelpers {
  return {
    baseOf(req) {
      const h = String((trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "")
        .split(",")[0]
        .trim()
        .toLowerCase();
      return bases.find((b) => hostOf(b) === h) ?? publicUrl;
    },
    ipOf(req) {
      return trustProxy && req.headers["x-forwarded-for"]
        ? String(req.headers["x-forwarded-for"]).split(",").pop()!.trim()
        : (req.socket.remoteAddress ?? "?");
    },
  };
}
