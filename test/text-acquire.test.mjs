// test/text-acquire.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireAndExtract } from "../src/text/acquire.mjs";

const noopLogger = { info() {}, warn() {}, error() {}, success() {}, verbose() {} };
const okResp = (html) => ({ ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => html });
const extractors = {
  // echo extractor: empty unless the html contains "HIT"
  echo: (doc, html) => ({ kind: "echo", empty: !/HIT/.test(html), value: /HIT/.test(html) ? "x" : null })
};
const fakePage = (html) => ({ content: async () => html, on() {}, async close() {}, });
const fakeSession = (html) => ({ newPage: async () => fakePage(html) });

test("static success → via:http, no browser", async () => {
  let opened = false;
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: { newPage: async () => { opened = true; } },
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => okResp("<body>HIT</body>"), extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "ok");
  assert.equal(r.via, "http");
  assert.equal(opened, false);
});

test("article: static loads but extractor empty → escalate to browser (via:browser)", async () => {
  const articleExtractors = { article: extractors.echo };
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "article", opts: {}, session: fakeSession("<body>HIT</body>"),
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => okResp("<body>nope</body>"), openReader: async () => {}, extractors: articleExtractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "ok");
  assert.equal(r.via, "browser");
});

test("records modes: static loads with zero matches → clean ok via:http, NO browser", async () => {
  let opened = false;
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: { newPage: async () => { opened = true; return fakePage("<body>HIT</body>"); } },
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => okResp("<body>nope</body>"), openReader: async () => {}, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(opened, false);
  assert.equal(r.status, "ok");
  assert.equal(r.via, "http");
  assert.equal(r.payload.empty, true);
});

test("non-2xx → escalate; browser nav fails (null) → HTTP_ERROR", async () => {
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: fakeSession("<body>nope</body>"),
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => ({ ok: false, status: 503, headers: { get: () => "text/html" }, text: async () => "" }), openReader: async () => null, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.code, "HTTP_ERROR");
});

test("static network throw → escalates; browser nav fails (null) → NETWORK_ERROR", async () => {
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: fakeSession("<body>nope</body>"),
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => { throw new TypeError("fetch failed"); }, openReader: async () => null, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.code, "NETWORK_ERROR");
});

test("NON-throwing failed nav (real openReader behavior) feeds NETWORK_ERROR, not EMPTY_RESULT", async () => {
  const r = await acquireAndExtract({
    url: "https://dead.example/a", mode: "echo", opts: {}, session: fakeSession(""),
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => { throw new TypeError("fetch failed"); }, openReader: async () => null, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.code, "NETWORK_ERROR");
});

test("records mode, --no-http-first: nav ok + zero matches via browser → clean ok via:browser", async () => {
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: fakeSession("<body>nope</body>"),
    config: { httpFirst: false, navTimeout: 1000 }, logger: noopLogger,
    deps: { openReader: async () => ({ status: () => 200, ok: () => true }), extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "ok");
  assert.equal(r.via, "browser");
  assert.equal(r.payload.empty, true);
});

test("both paths fail with a network error → mapped NETWORK_ERROR", async () => {
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {},
    session: { newPage: async () => ({ content: async () => "", on() {}, async close() {} }) },
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: {
      fetchFn: async () => { throw new TypeError("fetch failed"); },
      openReader: async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); },
      extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } })
    }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.code, "NETWORK_ERROR"); // mapError on the browser throw
});

test("--no-http-first goes straight to browser", async () => {
  let fetched = false;
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: fakeSession("<body>HIT</body>"),
    config: { httpFirst: false, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => { fetched = true; return okResp("<body>HIT</body>"); }, openReader: async () => {}, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(fetched, false);
  assert.equal(r.via, "browser");
  assert.equal(r.status, "ok");
});
