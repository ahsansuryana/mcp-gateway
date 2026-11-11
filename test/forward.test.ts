import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BackendPool } from "../src/backend/pool.js";
import { TokenStore } from "../src/backend/token-store.js";
import type { BackendConfig, GatewayConfig } from "../src/config/types.js";
import { createGatewayServerFactory } from "../src/gateway/server.js";

const fixture = fileURLToPath(new URL("./fixtures/backend.ts", import.meta.url));

interface Session {
  client: Client;
  close(): Promise<void>;
}

/** Jalankan backend palsu lewat BackendPool asli, lalu sambungkan Client ke server gateway (in-memory). */
async function open(
  over: Partial<BackendConfig> = {},
  scope: Set<string> | null = null,
  extra: string[] = [],
): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "gw-fwd-"));
  const servers: Record<string, BackendConfig> = {
    fx: { type: "stdio", command: process.execPath, args: ["--import", "tsx", fixture], ...over },
  };
  for (const n of extra) servers[n] = { ...servers.fx };
  const cfg: GatewayConfig = {
    server: { oauth: null, token_store: join(dir, "tokens.json") },
    separator: "__",
    servers,
    profiles: {},
  };
  const pool = new BackendPool(servers, {
    store: new TokenStore(cfg.server.token_store),
    redirectUrl: "http://localhost:8000/oauth/callback",
  });
  pool.start();
  const t0 = Date.now();
  while (!["fx", ...extra].every((n) => pool.clients.has(n))) {
    if (Date.now() - t0 > 20_000) throw new Error("backend palsu tidak terhubung dalam 20 detik");
    await new Promise((r) => setTimeout(r, 50));
  }

  const server = createGatewayServerFactory(cfg, pool)(scope);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tes", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    async close() {
      await client.close();
      await pool.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let s: Session;
before(async () => {
  s = await open();
});
after(async () => {
  await s.close();
});

test("gateway mengumumkan capability resources dan prompts", () => {
  const caps = s.client.getServerCapabilities();
  assert.ok(caps?.tools && caps.resources && caps.prompts);
});

test("tools: _meta.ui.resourceUri ditulis ulang, tool biasa tidak diubah", async () => {
  const { tools } = await s.client.listTools();
  const show = tools.find((t) => t.name === "fx__show");
  const plain = tools.find((t) => t.name === "fx__plain");
  assert.deepEqual(show?._meta, { ui: { resourceUri: "ui://fx/app/widget" } });
  assert.equal(plain?._meta, undefined);
});

test("resources/list: URI diberi awalan backend, skema ui:// tetap", async () => {
  const { resources } = await s.client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, ["file://fx//notes.txt", "file://fx//secret.txt", "ui://fx/app/widget"]);
  assert.equal(resources.find((r) => r.uri.startsWith("ui://"))?.mimeType, "text/html;profile=mcp-app");
});

test("resources/templates/list: template ditulis ulang", async () => {
  const { resourceTemplates } = await s.client.listResourceTemplates();
  assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate), ["file://fx//docs/{name}"]);
});

test("resources/read: UI dibaca lewat URI gateway, isi dan _meta utuh", async () => {
  const res = await s.client.readResource({ uri: "ui://fx/app/widget" });
  assert.equal(res.contents.length, 1);
  const c = res.contents[0] as { uri: string; mimeType?: string; text?: string; _meta?: unknown };
  assert.equal(c.uri, "ui://fx/app/widget");
  assert.equal(c.mimeType, "text/html;profile=mcp-app");
  assert.equal(c.text, "<h1>widget</h1>");
  assert.deepEqual(c._meta, { ui: { csp: {} } });
});

test("resources/read: file biasa dan hasil ekspansi template", async () => {
  const notes = await s.client.readResource({ uri: "file://fx//notes.txt" });
  assert.equal((notes.contents[0] as { text?: string }).text, "isi catatan");
  assert.equal(notes.contents[0].uri, "file://fx//notes.txt");

  const doc = await s.client.readResource({ uri: "file://fx//docs/a.txt" });
  assert.equal((doc.contents[0] as { text?: string }).text, "doc a.txt");
});

test("resources/read: backend tidak dikenal ditolak", async () => {
  await assert.rejects(() => s.client.readResource({ uri: "file://tidak-ada//x" }), /tidak ditemukan/);
  await assert.rejects(() => s.client.readResource({ uri: "bukan uri" }), /tidak ditemukan/);
});

test("hasil tool: resource_link ikut ditulis ulang dan bisa dibaca lewat gateway", async () => {
  const res = (await s.client.callTool({ name: "fx__link", arguments: {} })) as {
    content: { type: string; uri: string }[];
  };
  assert.equal(res.content[0].uri, "file://fx//notes.txt");
  const read = await s.client.readResource({ uri: res.content[0].uri });
  assert.equal((read.contents[0] as { text?: string }).text, "isi catatan");
});

test("prompts/list dan prompts/get: nama diberi awalan, URI tertanam ditulis ulang", async () => {
  const { prompts } = await s.client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["fx__greet", "fx__hidden"]);
  assert.equal(prompts.find((p) => p.name === "fx__greet")?.arguments?.[0].name, "name");

  const got = await s.client.getPrompt({ name: "fx__greet", arguments: { name: "Dina" } });
  assert.equal((got.messages[0].content as { text: string }).text, "Halo Dina");
  const embedded = got.messages[1].content as { type: string; resource: { uri: string } };
  assert.equal(embedded.resource.uri, "file://fx//notes.txt");
});

test("prompts/get: nama salah ditolak", async () => {
  await assert.rejects(() => s.client.getPrompt({ name: "greet" }), /tidak ditemukan/);
  await assert.rejects(() => s.client.getPrompt({ name: "fx__nope" }), /nope|tidak/);
});

test("deny_prompts dan deny_resources: disembunyikan dari daftar dan ditolak saat diakses", async () => {
  const d = await open({ deny_prompts: ["hidden"], deny_resources: ["file:///secret*"] });
  try {
    const { prompts } = await d.client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ["fx__greet"]);
    await assert.rejects(() => d.client.getPrompt({ name: "fx__hidden" }), /tidak diizinkan/);

    const { resources } = await d.client.listResources();
    assert.ok(!resources.some((r) => r.uri.includes("secret")));
    await assert.rejects(() => d.client.readResource({ uri: "file://fx//secret.txt" }), /tidak diizinkan/);
    // yang tidak di-deny tetap bisa
    await d.client.readResource({ uri: "file://fx//notes.txt" });
  } finally {
    await d.close();
  }
});

test("allow_resources: hanya yang cocok yang tampil", async () => {
  const d = await open({ allow_resources: ["ui://*"] });
  try {
    const { resources } = await d.client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), ["ui://fx/app/widget"]);
  } finally {
    await d.close();
  }
});

test("scope profil: backend di luar profil tidak terlihat dan tidak bisa dibaca", async () => {
  const d = await open({}, new Set(["lain"]));
  try {
    assert.deepEqual((await d.client.listPrompts()).prompts, []);
    assert.deepEqual((await d.client.listResources()).resources, []);
    await assert.rejects(() => d.client.readResource({ uri: "ui://fx/app/widget" }), /tidak ditemukan/);
    await assert.rejects(() => d.client.getPrompt({ name: "fx__greet" }), /tidak ditemukan/);
  } finally {
    await d.close();
  }
});

// ---- MCP Apps, completion, dan routing nama asli ------------------------------------

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;

test("gateway mengumumkan ekstensi MCP Apps dan completions", () => {
  const caps = s.client.getServerCapabilities();
  const ext = caps?.extensions as Record<string, unknown> | undefined;
  assert.ok(ext && "io.modelcontextprotocol/ui" in ext);
  assert.ok(caps?.completions);
});

test("gateway mengumumkan dukungan Apps ke backend (client capability)", async () => {
  const caps = JSON.parse(textOf(await s.client.callTool({ name: "fx__caps", arguments: {} })));
  assert.deepEqual(caps.extensions, { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } });
});

test("apps: false tidak mengumumkan dukungan ke backend", async () => {
  const d = await open({ apps: false });
  try {
    const caps = JSON.parse(textOf(await d.client.callTool({ name: "fx__caps", arguments: {} })));
    assert.equal(caps.extensions, undefined);
  } finally {
    await d.close();
  }
});

test("lazy: tool dengan UI tetap tampil, tool lain tersembunyi tetapi bisa dipanggil", async () => {
  const d = await open({ expose: "lazy" });
  try {
    const { tools } = await d.client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("gateway__call_tool"));
    assert.ok(names.includes("fx__show"), "tool dengan resourceUri harus tampil");
    assert.ok(names.includes("fx__app_only"), "tool khusus-aplikasi harus tampil");
    assert.ok(!names.includes("fx__plain"));
    assert.ok(!names.includes("fx__caps"));
    assert.deepEqual(tools.find((t) => t.name === "fx__show")?._meta, { ui: { resourceUri: "ui://fx/app/widget" } });

    const viaMeta = await d.client.callTool({
      name: "gateway__call_tool",
      arguments: { name: "fx__plain", arguments: {} },
    });
    assert.equal(textOf(viaMeta), "ok");

    // yang sudah dipromosikan tidak muncul lagi di pencarian
    const found = textOf(await d.client.callTool({ name: "gateway__search_tools", arguments: { query: "tool" } }));
    assert.ok(found.includes("fx__plain"));
    assert.ok(!found.includes("fx__show"));
  } finally {
    await d.close();
  }
});

test("tool dipanggil dengan nama asli (seperti dari UI Apps): diarahkan bila tak ambigu", async () => {
  assert.equal(textOf(await s.client.callTool({ name: "plain", arguments: {} })), "ok");
});

test("nama asli yang ada di beberapa server ditolak dengan petunjuk", async () => {
  const d = await open({}, null, ["fy"]);
  try {
    const r = (await d.client.callTool({ name: "plain", arguments: {} })) as { isError?: boolean };
    assert.equal(r.isError, true);
    assert.match(textOf(r), /beberapa server \(fx, fy\)/);
    // dengan awalan tetap jelas
    assert.equal(textOf(await d.client.callTool({ name: "fy__plain", arguments: {} })), "ok");
  } finally {
    await d.close();
  }
});

test("resource dibaca dengan URI asli (seperti dari UI Apps)", async () => {
  const res = await s.client.readResource({ uri: "ui://app/widget" });
  assert.equal(res.contents[0].uri, "ui://fx/app/widget");
  assert.equal((res.contents[0] as { text?: string }).text, "<h1>widget</h1>");
});

test("completion: argumen prompt dan variabel template resource diteruskan", async () => {
  const a = await s.client.complete({
    ref: { type: "ref/prompt", name: "fx__greet" },
    argument: { name: "name", value: "D" },
  });
  assert.deepEqual(a.completion.values, ["Dina", "Dewi"]);

  // context.arguments ikut diteruskan
  const b = await s.client.complete({
    ref: { type: "ref/prompt", name: "fx__greet" },
    argument: { name: "name", value: "" },
    context: { arguments: { lang: "id" } },
  });
  assert.deepEqual(b.completion.values, ["Halo"]);

  const c = await s.client.complete({
    ref: { type: "ref/resource", uri: "file://fx//docs/{name}" },
    argument: { name: "name", value: "a" },
  });
  assert.deepEqual(c.completion.values, ["a.txt"]);
});

test("completion: ref tidak dikenal ditolak, deny_prompts dihormati", async () => {
  await assert.rejects(
    () => s.client.complete({ ref: { type: "ref/prompt", name: "zz__greet" }, argument: { name: "name", value: "" } }),
    /tidak ditemukan/,
  );
  await assert.rejects(
    () =>
      s.client.complete({ ref: { type: "ref/resource", uri: "file://zz//docs/{name}" }, argument: { name: "name", value: "" } }),
    /tidak ditemukan/,
  );
  const d = await open({ deny_prompts: ["greet"] });
  try {
    await assert.rejects(
      () => d.client.complete({ ref: { type: "ref/prompt", name: "fx__greet" }, argument: { name: "name", value: "" } }),
      /tidak diizinkan/,
    );
  } finally {
    await d.close();
  }
});
