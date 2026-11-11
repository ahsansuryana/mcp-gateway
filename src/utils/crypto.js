import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");
export const rand = (n = 32) => randomBytes(n).toString("base64url");
export const safeEq = (a, b) =>
  timingSafeEqual(createHash("sha256").update(String(a)).digest(), createHash("sha256").update(String(b)).digest());
