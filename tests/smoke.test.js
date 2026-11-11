import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/echo-server.js", import.meta.url));
const TOKEN = "test-token";

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let app;
let base;

/** Panggil JSON-RPC ke /mcp; respons bisa JSON biasa atau SSE. */
async function rpc(path, method, params, token = TOKEN) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await res.text();
  const data = raw.startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  return { status: res.status, body: data ? JSON.parse(data) : null };
}

const toolNames = async (path = "/mcp") => (await rpc(path, "tools/list", {})).body.result.tools.map((t) => t.name);
const callText = async (name, args, path = "/mcp") =>
  (await rpc(path, "tools/call", { name, arguments: args })).body.result.content[0].text;

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "mcp-gw-test-"));
  const backend = { type: "stdio", command: process.execPath, args: [fixture] };
  writeFileSync(
    join(dir, "gateway.json"),
    JSON.stringify({
      server: { host: "127.0.0.1", port, public_url: base, auth_token: TOKEN, oauth: { password: "pw" } },
      servers: {
        full: { ...backend, expose: "full", deny_tools: ["secret"] },
        lazy: { ...backend, expose: "lazy" },
      },
      profiles: { only_full: ["full"] },
    }),
  );
  app = createApp(join(dir, "gateway.json"));
  app.start();

  // tunggu kedua backend up
  for (let i = 0; i < 100; i++) {
    try {
      const h = await (await fetch(`${base}/health`)).json();
      if (Object.values(h.backends).every((s) => s === "up")) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`backend tidak up dalam 10 detik. Log:\n${output}`);
});

after(async () => {
  await app?.stop();
  app?.http.closeAllConnections?.();
});

describe("entry point gateway.js", () => {
  test("shim boot dan menjawab /health (tanpa backend)", async () => {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), "mcp-gw-shim-"));
    writeFileSync(join(dir, "gateway.json"), JSON.stringify({ server: { host: "127.0.0.1", port }, servers: {} }));
    const child = spawn(process.execPath, [join(root, "gateway.js"), "-c", join(dir, "gateway.json")], { cwd: root });
    try {
      let h;
      for (let i = 0; i < 50 && !h; i++) {
        try {
          h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.deepEqual(h, { backends: {} });
    } finally {
      child.kill();
    }
  });
});

describe("gateway smoke test", () => {
  test("/health menampilkan status backend", async () => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(h.backends, { full: "up", lazy: "up" });
  });

  test("/mcp tanpa token -> 401 dengan resource_metadata", async () => {
    const r = await rpc("/mcp", "tools/list", {}, null);
    assert.equal(r.status, 401);
  });

  test("tools/list: status, meta-tool (ada backend lazy), tool full berawalan, deny_tools bekerja", async () => {
    const names = await toolNames();
    assert.ok(names.includes("gateway__status"));
    for (const n of ["search_tools", "describe_tool", "call_tool"]) assert.ok(names.includes(`gateway__${n}`), n);
    assert.ok(names.includes("full__echo"));
    assert.ok(!names.includes("full__secret"), "deny_tools harus menyembunyikan secret");
    assert.ok(!names.some((n) => n.startsWith("lazy__")), "backend lazy tidak boleh tampil di daftar");
  });

  test("panggil tool backend full langsung", async () => {
    assert.equal(await callText("full__echo", { text: "halo" }), "echo: halo");
  });

  test("tool yang di-deny ditolak saat dipanggil", async () => {
    const r = await rpc("/mcp", "tools/call", { name: "full__secret", arguments: {} });
    assert.equal(r.body.result.isError, true);
  });

  test("lazy: search -> describe -> call_tool", async () => {
    assert.match(await callText("gateway__search_tools", { query: "echo" }), /lazy__echo/);
    assert.match(await callText("gateway__describe_tool", { name: "lazy__echo" }), /inputSchema/);
    assert.equal(await callText("gateway__call_tool", { name: "lazy__echo", arguments: { text: "lazy" } }), "echo: lazy");
  });

  test("profil membatasi server", async () => {
    const names = await toolNames("/mcp/only_full");
    assert.ok(names.includes("full__echo"));
    assert.ok(!names.includes("gateway__search_tools"), "tidak ada server lazy di profil ini");
    assert.equal((await rpc("/mcp/tidak_ada", "tools/list", {})).status, 404);
  });

  test("GET /mcp -> 405 (stateless)", async () => {
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
  });

  test("OAuth gateway: metadata, registrasi client, PKCE wajib", async () => {
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(meta.issuer, base);
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);

    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "test", redirect_uris: ["http://localhost:9999/cb"] }),
    });
    assert.equal(reg.status, 201);
    const client = await reg.json();

    const noPkce = await fetch(
      `${base}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("http://localhost:9999/cb")}`,
      { redirect: "manual" },
    );
    assert.equal(noPkce.status, 302);
    assert.match(noPkce.headers.get("location"), /error=invalid_request/);
  });
});
