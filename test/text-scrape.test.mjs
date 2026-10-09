// test/text-scrape.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrapeText, resolveMode, toRecord } from "../src/text/scrape-text.mjs";

const noopLogger = { info() {}, warn() {}, error() {}, success() {}, verbose() {} };
async function tmp(fn) { const d = await mkdtemp(path.join(tmpdir(), "stxt-")); try { return await fn(d); } finally { await rm(d, { recursive: true, force: true }); } }

test("resolveMode: flag > profile > default article", () => {
  assert.equal(resolveMode({ textMode: "pattern" }, { text: { mode: "selector" } }), "pattern");
  assert.equal(resolveMode({ textMode: "article" }, { text: { mode: "selector" } }), "selector");
  assert.equal(resolveMode({ textMode: "article" }, {}), "article");
});

test("toRecord: pattern groups by type; selector spreads fields", () => {
  assert.deepEqual(toRecord("u", { kind: "pattern", matches: [{ type: "email", value: "a@b" }, { type: "email", value: "c@d" }] }),
    { url: "u", email: ["a@b", "c@d"] });
  assert.deepEqual(toRecord("u", { kind: "selector", fields: { title: "T", tags: ["x"] } }),
    { url: "u", title: "T", tags: ["x"] });
});

test("scrapeText article → writes .md, returns ok + via", async () => {
  await tmp(async (dir) => {
    const deps = { acquireAndExtract: async () => ({ status: "ok", via: "http", bytes: 10, requests: 1, payload: { kind: "article", empty: false, title: "T", byline: "J", excerpt: "e", markdown: "Body." } }) };
    const r = await scrapeText({}, { url: "https://x/a", name: null }, { listFile: null, out: path.join(dir, "art"), textMode: "article" }, noopLogger, {}, deps);
    assert.equal(r.ok, true); assert.equal(r.via, "http"); assert.equal(r.saved, 1);
    const md = await readFile(path.join(dir, "art.md"), "utf8");
    assert.match(md, /title: "T"/); assert.match(md, /Body\./);
  });
});

test("scrapeText records → appends to writer; saved = match count", async () => {
  const appended = [];
  const recordWriter = { append: async (rec) => appended.push(rec) };
  const deps = { recordWriter, acquireAndExtract: async () => ({ status: "ok", via: "browser", bytes: 5, requests: 2, payload: { kind: "pattern", empty: false, matches: [{ type: "email", value: "a@b" }, { type: "email", value: "c@d" }] } }) };
  const r = await scrapeText({}, { url: "https://x/a" }, { textMode: "pattern" }, noopLogger, {}, deps);
  assert.equal(r.ok, true); assert.equal(r.saved, 2); assert.equal(r.via, "browser");
  assert.deepEqual(appended, [{ url: "https://x/a", email: ["a@b", "c@d"] }]);
});

test("scrapeText: zero matches is a clean success (saved:0), not a failure", async () => {
  const recordWriter = { append: async () => {} };
  const deps = { recordWriter, acquireAndExtract: async () => ({ status: "ok", via: "http", bytes: 1, requests: 1, payload: { kind: "pattern", empty: true, matches: [] } }) };
  const r = await scrapeText({}, { url: "https://x/a" }, { textMode: "pattern" }, noopLogger, {}, deps);
  assert.equal(r.ok, true); assert.equal(r.complete, true); assert.equal(r.saved, 0);
});

test("scrapeText: acquisition fail → failed result, code in attempts, NO top-level error", async () => {
  const deps = { acquireAndExtract: async () => ({ status: "fail", code: "NETWORK_ERROR", bytes: 0, requests: 1 }) };
  const r = await scrapeText({}, { url: "https://x/a" }, { textMode: "article" }, noopLogger, {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, undefined);
  assert.equal(r.attempts[0].code, "NETWORK_ERROR");
});
