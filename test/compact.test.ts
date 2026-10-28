import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompactor, shorten, stripSchema } from "../src/gateway/compact.js";

test("shorten: rapikan whitespace dan potong di batas kata", () => {
  assert.equal(shorten("  a   b\n c ", 0), "a b c");
  const out = shorten("satu dua tiga empat lima enam", 18);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length <= 18);
});

test("stripSchema: buang description/title tapi jaga enum, default, required", () => {
  const out = stripSchema({
    type: "object",
    title: "T",
    description: "D",
    required: ["description"],
    properties: {
      description: { type: "string", description: "nama field bernama description" },
      mode: { type: "string", enum: ["a", "b"], default: "a", description: "x" },
    },
  }) as any;
  assert.equal(out.title, undefined);
  assert.equal(out.description, undefined);
  assert.deepEqual(out.required, ["description"]);
  assert.deepEqual(Object.keys(out.properties), ["description", "mode"]);
  assert.equal(out.properties.description.description, undefined);
  assert.deepEqual(out.properties.mode.enum, ["a", "b"]);
  assert.equal(out.properties.mode.default, "a");
});

test("createCompactor: tanpa config tool tidak diubah; dengan config output schema dibuang", () => {
  const tool: any = { name: "t", description: "d", title: "x", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
  assert.equal(createCompactor(null).compactTool(tool), tool);
  const out: any = createCompactor({}).compactTool(tool);
  assert.equal(out.outputSchema, undefined);
  assert.equal(out.title, undefined);
  assert.equal(out.name, "t");
});
