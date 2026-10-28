import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256hex = (s: unknown): string => createHash("sha256").update(String(s)).digest("hex");

export const sha256base64url = (s: string): string => createHash("sha256").update(s).digest("base64url");

export const rand = (n = 32): string => randomBytes(n).toString("base64url");

/** Perbandingan string constant-time (dihash dulu agar panjang sama). */
export const safeEq = (a: unknown, b: unknown): boolean =>
  timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());
