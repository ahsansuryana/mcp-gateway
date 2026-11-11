/**
 * Nilai turunan dari config yang dipakai saat runtime:
 * host/port, public_url, redirect URI login backend, dan daftar issuer yang diterima.
 */
export function resolveRuntime(cfg) {
  const host = cfg.server.host ?? "0.0.0.0";
  const port = cfg.server.port ?? 8000;
  // Jika gateway di server remote, isi server.public_url (HTTPS), mis. https://gw.example.com
  const publicUrl = (cfg.server.public_url ?? `http://localhost:${port}`).replace(/\/$/, "");
  // Redirect URI untuk login ke backend OAuth (mis. Vercel). Terpisah dari public_url (issuer agen -> gateway):
  // sebagian provider hanya menyetujui redirect localhost. Default tetap <public_url>/oauth/callback.
  const redirectUrl = String(cfg.server.backend_redirect_url ?? `${publicUrl}/oauth/callback`);
  if (!/\/oauth\/callback$/.test(redirectUrl)) {
    console.error("server.backend_redirect_url harus berakhiran /oauth/callback (route callback gateway)");
    process.exit(1);
  }
  // Alamat yang boleh jadi issuer: public_url, loopback otomatis, dan server.extra_public_urls
  const norm = (u) => String(u).replace(/\/+$/, "");
  const bases = [
    ...new Set([
      publicUrl,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...(cfg.server.extra_public_urls ?? []).map(norm),
    ]),
  ];
  return { host, port, publicUrl, redirectUrl, bases };
}
