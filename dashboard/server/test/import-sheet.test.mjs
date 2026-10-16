import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { importSheet } from "../src/import-sheet.mjs";

const fixture = fileURLToPath(new URL("./fixtures/links.csv", import.meta.url));

test("importSheet reads http(s) URLs from a csv and skips non-URLs", async () => {
  const urls = await importSheet(fixture);
  assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"]);
});

test("importSheet rejects when the file does not exist", async () => {
  await assert.rejects(() => importSheet("/nonexistent/links.csv"));
});
