export function validRedirect(u) {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === "https:") return true;
    if (x.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
    return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(x.protocol); // skema kustom app native
  } catch {
    return false;
  }
}

export function redirectWith(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}
