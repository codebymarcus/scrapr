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

test("resolveTargets: batch outputName fills in when there is no job.name", () => {
  const cfg = { listFile: "l.csv", out: "downloads" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: null }, { outputName: "Ultimate Hulk Annual" });
  assert.equal(t.outDir, path.join("downloads", "Ultimate Hulk Annual"));
  assert.equal(t.cbzPath, path.join("downloads", "Ultimate Hulk Annual.cbz"));
});

test("resolveTargets: explicit job.name wins over outputName", () => {
  const cfg = { listFile: "l.csv", out: "downloads" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: "Issue 5" }, { outputName: "Ignored Title" });
  assert.equal(t.outDir, path.join("downloads", "Issue 5"));
});

test("resolveTargets: outputName never changes the cache dir (resume stays stable)", () => {
  const cfg = { listFile: "l.csv", out: "downloads" };
  const without = resolveTargets(cfg, { url: "https://x/read", name: null });
  const withName = resolveTargets(cfg, { url: "https://x/read", name: null }, { outputName: "Different Title" });
  assert.equal(withName.cacheDir, without.cacheDir);
});

test("resolveTargets: single-URL mode ignores outputName", () => {
  const cfg = { listFile: null, out: "myout" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: null }, { outputName: "Title" });
  assert.equal(t.outDir, "myout");
});

test("resolveTargets: batch mdPath is the folder + .md, auto-named from outputName", () => {
  const cfg = { listFile: "l.csv", out: "downloads" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: null }, { outputName: "My Article" });
  assert.equal(t.mdPath, path.join("downloads", "My Article.md"));
});

test("resolveTargets: single-URL mdPath defaults to outDir + .md, or textName", () => {
  assert.equal(resolveTargets({ listFile: null, out: "myout" }, { url: "https://x/read", name: null }).mdPath, "myout.md");
  assert.equal(resolveTargets({ listFile: null, out: "myout", textName: "custom.md" }, { url: "https://x/read", name: null }).mdPath, "custom.md");
});

import { resolveRecordBase } from "../src/naming.mjs";
test("resolveRecordBase: single-URL uses out; batch uses out/results; textName overrides", () => {
  assert.equal(resolveRecordBase({ listFile: null, out: "myout" }), "myout");
  assert.equal(resolveRecordBase({ listFile: "l.csv", out: "downloads" }), path.join("downloads", "results"));
  assert.equal(resolveRecordBase({ listFile: "l.csv", out: "downloads", textName: "contacts" }), "contacts");
  assert.equal(resolveRecordBase({ listFile: null, out: null }), "results");
});

test("resolveTargets: config.batch (no listFile) names per job from job.name", () => {
  const cfg = { listFile: null, batch: true, out: "runs/4" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: "World War Hulk 1" });
  assert.equal(t.cbzPath, path.join("runs/4", "World War Hulk 1.cbz"));
});

test("resolveTargets: config.batch falls back to url slug without a name", () => {
  const cfg = { listFile: null, batch: true, out: "runs/4" };
  const t = resolveTargets(cfg, { url: "https://read.x.com/i/5", name: null });
  assert.notEqual(path.basename(t.cbzPath), "4.cbz"); // not named after the run dir
  assert.match(t.cbzPath, /read-x-com/);
});
