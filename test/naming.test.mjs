// Naming + output-path resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { slugFromUrl, sanitizeName, resolveTargets } from "../src/naming.mjs";

test("slugFromUrl: host+path to a safe slug", () => {
  assert.equal(slugFromUrl("https://read.example.com/comic/issue-5/"), "read-example-com-comic-issue-5");
});

test("slugFromUrl: invalid URL falls back to 'output'", () => {
  assert.equal(slugFromUrl("not a url"), "output");
});

test("sanitizeName: strips path-hostile chars, collapses spaces, caps length", () => {
  assert.equal(sanitizeName('X-Men: Days/Future?*'), "X-Men- Days-Future-");
  assert.equal(sanitizeName("   ...leading"), "leading");
  assert.equal(sanitizeName("a".repeat(200)).length, 120);
  assert.equal(sanitizeName(""), "output");
});

test("resolveTargets: single-URL mode uses --out as exact dir", () => {
  const cfg = { listFile: null, out: "myout" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: null });
  assert.equal(t.outDir, "myout");
  assert.equal(t.cbzPath, "myout.cbz");
  assert.equal(t.pdfPath, "myout.pdf");
});

test("resolveTargets: cacheDir sits beside outDir, not inside it", () => {
  const single = resolveTargets({ listFile: null, out: "myout" }, { url: "https://x/read", name: null });
  assert.equal(single.cacheDir, path.join(".scaper-cache", "myout"));
  const batch = resolveTargets({ listFile: "l.csv", out: "downloads" }, { url: "https://x/read", name: "Issue 5" });
  assert.equal(batch.cacheDir, path.join("downloads", ".scaper-cache", "Issue 5"));
});

test("resolveTargets: batch mode uses --out as parent, name as subfolder", () => {
  const cfg = { listFile: "list.csv", out: "downloads" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: "Issue 5" });
  assert.equal(t.outDir, path.join("downloads", "Issue 5"));
  assert.equal(t.cbzPath, path.join("downloads", "Issue 5.cbz"));
});

test("resolveTargets: batch mode without name derives folder from url", () => {
  const cfg = { listFile: "list.csv", out: null };
  const t = resolveTargets(cfg, { url: "https://read.x.com/i/5", name: null });
  assert.equal(t.outDir, path.join("downloads", "read-x-com-i-5"));
});
