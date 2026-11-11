/** Redirect URI untuk klien yang mendaftar: https, http://localhost, atau skema kustom app native. */
export function validRedirect(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === "https:") return true;
    if (x.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
    return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(x.protocol);
  } catch {
    return false;
  }
}

export function redirectWith(base: string, params: Record<string, string | undefined | null>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}
