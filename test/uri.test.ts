import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteBlockUris, rewriteToolMeta, unwrapUri, wrapUri } from "../src/gateway/uri.js";

test("wrapUri: skema dipertahankan, backend jadi host", () => {
  assert.equal(wrapUri("docs", "ui://app/widget"), "ui://docs/app/widget");
  assert.equal(wrapUri("docs", "file:///a.txt"), "file://docs//a.txt");
  assert.equal(wrapUri("docs", "https://ex.com/a?b=c#d"), "https://docs/ex.com/a?b=c#d");
  assert.equal(wrapUri("docs", "mailto:x@y.z"), "mailto://docs/@opaque/x@y.z");
});

test("wrapUri/unwrapUri: round-trip tepat untuk berbagai bentuk URI", () => {
  const uris = [
    "ui://app/widget",
    "file:///a.txt",
    "file:///docs/{name}",
    "https://ex.com/a?b=c#d",
    "mailto:x@y.z",
    "urn:isbn:123",
    "foo://",
    "x://@opaque/foo", // sisa hierarkis yang mirip penanda
    "x://@weird",
    "x://@@dua",
    "custom://a//b///c",
  ];
  for (const uri of uris) {
    const w = wrapUri("be_1", uri);
    assert.ok(w, uri);
    assert.deepEqual(unwrapUri(w), { backend: "be_1", uri }, `${uri} -> ${w}`);
  }
});

test("wrapUri: null untuk template yang tidak diawali skema konkret", () => {
  assert.equal(wrapUri("docs", "{scheme}://x"), null);
  assert.equal(wrapUri("docs", "tanpa-skema"), null);
});

test("unwrapUri: bentuk tak dikenal null; tanpa path tetap terbaca", () => {
  assert.equal(unwrapUri("bukan uri"), null);
  assert.equal(unwrapUri("ui:///kosong"), null);
  assert.deepEqual(unwrapUri("ui://docs"), { backend: "docs", uri: "ui://" });
});

test("rewriteToolMeta: _meta.ui.resourceUri dan bentuk lama ui/resourceUri ditulis ulang", () => {
  const nested = rewriteToolMeta("docs", { name: "t", _meta: { ui: { resourceUri: "ui://app/w", visibility: ["app"] }, x: 1 } });
  assert.deepEqual(nested._meta, { ui: { resourceUri: "ui://docs/app/w", visibility: ["app"] }, x: 1 });

  const flat = rewriteToolMeta("docs", { name: "t", _meta: { "ui/resourceUri": "ui://app/w" } });
  assert.deepEqual(flat._meta, { "ui/resourceUri": "ui://docs/app/w" });
});

test("rewriteToolMeta: tool tanpa penunjuk UI dikembalikan apa adanya (objek sama)", () => {
  const a = { name: "t" };
  const b = { name: "t", _meta: { lain: true } };
  assert.equal(rewriteToolMeta("docs", a), a);
  assert.equal(rewriteToolMeta("docs", b), b);
});

test("rewriteBlockUris: resource_link dan resource tertanam; teks tidak berubah", () => {
  assert.deepEqual(rewriteBlockUris("docs", { type: "resource_link", uri: "file:///a", name: "a" }), {
    type: "resource_link",
    uri: "file://docs//a",
    name: "a",
  });
  assert.deepEqual(
    rewriteBlockUris("docs", { type: "resource", resource: { uri: "ui://app/w", text: "<p/>", mimeType: "text/html" } }),
    { type: "resource", resource: { uri: "ui://docs/app/w", text: "<p/>", mimeType: "text/html" } },
  );
  const text = { type: "text", text: "halo" };
  assert.equal(rewriteBlockUris("docs", text), text);
});
