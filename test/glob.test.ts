import assert from "node:assert/strict";
import { test } from "node:test";
import { globMatch } from "../src/utils/glob.js";

test("globMatch: wildcard dan literal", () => {
  assert.ok(globMatch("write_*", "write_file"));
  assert.ok(globMatch("*", "apa_saja"));
  assert.ok(globMatch("move_file", "move_file"));
  assert.ok(!globMatch("move_file", "move_file2"));
  assert.ok(!globMatch("get_*", "list_files"));
});

test("globMatch: karakter regex diperlakukan literal", () => {
  assert.ok(globMatch("a.b", "a.b"));
  assert.ok(!globMatch("a.b", "axb"));
});
