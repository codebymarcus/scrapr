// test/text-extract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractArticle } from "../src/text/extract.mjs";

const fakePage = {}; // extractArticle orchestration is tested via injected deps

test("extractArticle: selector path returns that element's html", async () => {
  const deps = { readSelector: async () => ({ title: "T", html: "<p>sel</p>" }), runReadability: async () => null, readFallback: async () => null };
  const r = await extractArticle(fakePage, { selector: ".x" }, deps);
  assert.deepEqual(r, { title: "T", html: "<p>sel</p>", byline: null, excerpt: null });
});

test("extractArticle: readability path when no selector", async () => {
  const deps = { readSelector: async () => null, runReadability: async () => ({ title: "R", html: "<p>read</p>", byline: "Jane", excerpt: "e" }), readFallback: async () => null };
  const r = await extractArticle(fakePage, {}, deps);
  assert.equal(r.title, "R");
  assert.equal(r.html, "<p>read</p>");
  assert.equal(r.byline, "Jane");
});

test("extractArticle: falls back to body when readability yields nothing", async () => {
  const deps = { readSelector: async () => null, runReadability: async () => null, readFallback: async () => ({ title: "B", html: "<p>body</p>" }) };
  const r = await extractArticle(fakePage, {}, deps);
  assert.equal(r.html, "<p>body</p>");
  assert.equal(r.byline, null);
});

test("extractArticle: null when nothing usable", async () => {
  const deps = { readSelector: async () => null, runReadability: async () => null, readFallback: async () => null };
  assert.equal(await extractArticle(fakePage, {}, deps), null);
});

test("extractArticle: a selector that returns no html still falls through to readability", async () => {
  const deps = { readSelector: async () => ({ title: "x", html: "" }), runReadability: async () => ({ title: "R", html: "<p>r</p>" }), readFallback: async () => null };
  const r = await extractArticle(fakePage, { selector: ".x" }, deps);
  assert.equal(r.html, "<p>r</p>");
});
