export const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const sendHtml = (res, status, title, msg) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font-family:sans-serif;max-width:480px;margin:4rem auto"><h2>${esc(title)}</h2><p>${esc(msg)}</p></body>`,
  );
};

/** Body JSON-RPC untuk /mcp (tanpa batas ukuran, sama seperti sebelumnya). */
export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : undefined;
}

/** Body mentah dengan batas ukuran, untuk endpoint OAuth. */
export async function readRaw(req, limit = 65536) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error("body terlalu besar");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const parseBody = (req, raw) =>
  (req.headers["content-type"] ?? "").includes("json") ? (raw ? JSON.parse(raw) : {}) : Object.fromEntries(new URLSearchParams(raw));
