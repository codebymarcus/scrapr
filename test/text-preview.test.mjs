import { test } from "node:test";
import assert from "node:assert/strict";
import { previewText } from "../src/preview/text-preview.mjs";

const noopLogger = { info() {}, warn() {}, muted() {}, success() {}, error() {}, step() {}, progressBar() {} };

test("previewText returns normalized selector fields without writing", async () => {
  const fakeAcquire = async () => ({ status: "ok", via: "http", bytes: 1, requests: 1,
    payload: { kind: "selector", empty: false, fields: { title: "Hi", body: "Words" } } });
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "selector",
    fields: [{ name: "title", selector: "h1" }, { name: "body", selector: "article" }] } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: fakeAcquire } });
  assert.equal(res.status, "ok");
  assert.equal(res.mode, "selector");
  assert.deepEqual(res.fields, [{ name: "title", value: "Hi" }, { name: "body", value: "Words" }]);
});

test("previewText surfaces acquire failure", async () => {
  const fakeAcquire = async () => ({ status: "fail", code: "HTTP_ERROR" });
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "article" } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: fakeAcquire } });
  assert.equal(res.status, "fail");
  assert.equal(res.code, "HTTP_ERROR");
});

test("previewText orders selector fields by recipe declaration, extras follow in payload order", async () => {
  const fakeAcquire = async () => ({ status: "ok", via: "http", bytes: 1, requests: 1,
    payload: { kind: "selector", empty: false, fields: { body: "B", extra: "E", title: "T" } } });
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "selector",
    fields: [{ name: "title", selector: "h1" }, { name: "body", selector: "p" }] } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: fakeAcquire } });
  assert.deepEqual(res.fields, [
    { name: "title", value: "T" }, { name: "body", value: "B" }, { name: "extra", value: "E" }
  ]);
});

test("previewText groups pattern matches by type in declared order", async () => {
  let seen;
  const fakeAcquire = async (args) => { seen = args; return { status: "ok", via: "browser", bytes: 1, requests: 1,
    payload: { kind: "pattern", empty: false, matches: [
      { type: "url", value: "https://a" }, { type: "email", value: "a@b.co" }, { type: "url", value: "https://c" }
    ] } }; };
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "pattern",
    patterns: ["email", "url"] } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: fakeAcquire } });
  assert.equal(seen.mode, "pattern");
  assert.equal(res.via, "browser");
  assert.deepEqual(res.fields, [
    { name: "email", value: ["a@b.co"] }, { name: "url", value: ["https://a", "https://c"] }
  ]);
});

test("previewText returns article document fields", async () => {
  const fakeAcquire = async () => ({ status: "ok", via: "http", bytes: 1, requests: 1,
    payload: { kind: "article", empty: false, title: "T", byline: "By", excerpt: "Ex", markdown: "# T" } });
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "article" } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: fakeAcquire } });
  assert.equal(res.mode, "article");
  assert.deepEqual(res.fields, { title: "T", byline: "By", excerpt: "Ex", markdown: "# T" });
});

test("previewText returns a fail result for an invalid pattern spec", async () => {
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "pattern",
    patterns: ["bogus"] } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: async () => { throw new Error("unreachable"); } } });
  assert.equal(res.status, "fail");
  assert.equal(res.code, "INVALID_RECIPE");
});
