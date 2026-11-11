import { sendJson } from "../io.js";

export function handleHealth(req, res, { pool, access }) {
  const names = Object.keys(pool.configs);
  const body = { backends: Object.fromEntries(names.map((n) => [n, pool.status(n)])) };
  // URL login hanya ditampilkan ke pemegang token gateway
  if (access.authorized(req)) {
    const urls = Object.fromEntries(names.map((n) => [n, pool.authUrl(n)]).filter(([, u]) => u));
    if (Object.keys(urls).length) body.auth_urls = urls;
  }
  return sendJson(res, 200, body);
}
