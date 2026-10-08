// test/text-scrape.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrapeText } from "../src/text/scrape-text.mjs";

const noopLogger = { info() {}, warn() {}, step() {}, success() {}, error() {}, verbose() {} };
const fakePage = () => ({ closed: false, on() {}, async close() { this.closed = true; } });
const fakeSession = (page) => ({ newPage: async () => page });
async function tmp(fn) { const d = await mkdtemp(path.join(tmpdir(), "scaper-txt-")); try { return await fn(d); } finally { await rm(d, { recursive: true, force: true }); } }

test("scrapeText: writes a .md with frontmatter + title + body and returns success", async () => {
  await tmp(async (dir) => {
    const page = fakePage();
    const deps = {
      openReader: async () => {},
      extractArticle: async () => ({ title: "Hello World", html: "<p>Body <strong>x</strong></p>", byline: "Jane", excerpt: "e" })
    };
    const config = { listFile: null, out: path.join(dir, "art") };
    const r = await scrapeText(fakeSession(page), { url: "https://x/a", name: null }, config, noopLogger, { name: "generic" }, deps);
    assert.equal(r.ok, true);
    assert.equal(r.complete, true);
    assert.equal(r.contentType, "text");
    const md = await readFile(path.join(dir, "art.md"), "utf8");
    assert.match(md, /title: "Hello World"/);
    assert.match(md, /source: "https:\/\/x\/a"/);
    assert.match(md, /^# Hello World/m);
    assert.match(md, /Body \*\*x\*\*/);
    assert.equal(page.closed, true);
  });
});

test("scrapeText: empty extraction → EMPTY_RESULT failure (no file)", async () => {
  const page = fakePage();
  const deps = { openReader: async () => {}, extractArticle: async () => null };
  const r = await scrapeText(fakeSession(page), { url: "https://x/a", name: null }, { listFile: null, out: "/tmp/does-not-exist-scaper/none" }, noopLogger, {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.attempts[0].code, "EMPTY_RESULT");
  assert.equal(page.closed, true);
});

test("scrapeText: a thrown openReader → failed result with mapped code, page closed", async () => {
  const page = fakePage();
  const deps = { openReader: async () => { const e = new Error("net::ERR_X"); throw e; }, extractArticle: async () => ({ html: "x" }) };
  const r = await scrapeText(fakeSession(page), { url: "https://x/a", name: null }, { listFile: null, out: "/tmp/none" }, noopLogger, {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.attempts[0].code, "NETWORK_ERROR");
  assert.equal(page.closed, true);
});
