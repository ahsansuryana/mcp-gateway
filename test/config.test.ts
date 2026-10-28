import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, expandEnv, loadConfig } from "../src/config/load.js";

const write = (obj: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const p = join(dir, "gateway.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

test("expandEnv: ganti ${VAR} secara rekursif, kosong bila tidak ada", () => {
  process.env.GW_TEST_X = "nilai";
  assert.deepEqual(expandEnv({ a: ["${GW_TEST_X}", "${GW_TEST_NONE}"], b: { c: "pre-${GW_TEST_X}" } }), {
    a: ["nilai", ""],
    b: { c: "pre-nilai" },
  });
});

test("loadConfig: default terisi dan path relatif ke folder config", () => {
  const p = write({});
  const cfg = loadConfig(p);
  assert.equal(cfg.separator, "__");
  assert.ok(cfg.server.token_store.endsWith("tokens.json"));
  assert.equal(cfg.server.oauth, null);
});

test("loadConfig: expose tidak valid ditolak", () => {
  assert.throws(() => loadConfig(write({ servers: { a: { expose: "x" } } })), ConfigError);
});

test("loadConfig: oauth aktif tanpa password ditolak, dan fallback ke auth_token", () => {
  assert.throws(() => loadConfig(write({ server: { oauth: {} } })), ConfigError);
  const cfg = loadConfig(write({ server: { auth_token: "t", oauth: {} } }));
  assert.equal(cfg.server.oauth?.password, "t");
});

test("loadConfig: nama profil tidak valid ditolak", () => {
  assert.throws(() => loadConfig(write({ profiles: { "bad name": [] } })), ConfigError);
});
