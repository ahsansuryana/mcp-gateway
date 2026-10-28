import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { esc } from "../utils/html.js";

export const sendJson = (res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export const sendHtml = (res: ServerResponse, status: number, title: string, msg: string): void => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font-family:sans-serif;max-width:480px;margin:4rem auto"><h2>${esc(title)}</h2><p>${esc(msg)}</p></body>`,
  );
};
