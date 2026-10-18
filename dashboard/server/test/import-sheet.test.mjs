import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { importSheet } from "../src/import-sheet.mjs";

const fixture = fileURLToPath(new URL("./fixtures/links.csv", import.meta.url));

test("importSheet reads http(s) URLs with their name column and skips non-URLs", async () => {
  const rows = await importSheet(fixture);
  assert.deepEqual(rows, [
    { url: "https://example.com/a", name: "Alpha" },
    { url: "https://example.com/b", name: "Beta" },
  ]);
});

test("importSheet rejects when the file does not exist", async () => {
  await assert.rejects(() => importSheet("/nonexistent/links.csv"));
});
