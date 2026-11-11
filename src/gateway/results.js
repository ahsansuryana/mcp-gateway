import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

export const isAuthError = (e) => e instanceof UnauthorizedError || e?.code === 401;

export const errorResult = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });
export const text = (t) => ({ content: [{ type: "text", text: t }] });
