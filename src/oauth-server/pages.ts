import { esc } from "../utils/html.js";
import type { LoginInfo } from "./server.js";

export const pageHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

/** Halaman persetujuan: pemilik memasukkan password gateway. */
export const loginPage = ({ client, redirectHost, txn }: LoginInfo, msg?: string): string =>
  `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Izinkan akses</title>` +
  `<body style="font-family:sans-serif;max-width:420px;margin:4rem auto;padding:0 1rem"><h2>Izinkan akses ke gateway</h2>` +
  `<p><b>${esc(client.client_name)}</b> (${esc(redirectHost)}) meminta akses ke semua tool MCP di gateway ini.</p>` +
  (msg ? `<p style="color:#b00">${esc(msg)}</p>` : "") +
  `<form method="post" action="/authorize"><input type="hidden" name="txn" value="${esc(txn)}">` +
  `<label>Password gateway<br><input type="password" name="password" autofocus required style="width:100%;padding:.5rem;margin:.5rem 0"></label>` +
  `<button style="padding:.5rem 1rem">Izinkan</button></form></body></html>`;
