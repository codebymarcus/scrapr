# Text Extraction v2 (HTTP-first + pluggable extractors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the `text` content type into three extraction modes — **pattern** (emails/phones/urls/custom regex), **selector** (CSS fields), **article** (Readability → Markdown) — over an **HTTP-first** acquisition layer that fetches statically and escalates to the browser only when needed.

**Architecture:** A new `src/text/acquire.mjs` fetches a URL over built-in `fetch`, normalizes the HTML to a single `linkedom` document, runs the selected extractor, and escalates to the existing browser `openReader` path only if the static fetch fails *or* extracts nothing. Extractors share one `extract(doc, html, opts)` contract via a registry. Article writes one `.md` per URL (existing `markdown.mjs`); pattern/selector accumulate records written incrementally to aggregate CSV + JSON. `scrapeText` is rewired onto this; the image pipeline is untouched.

**Tech Stack:** Node.js ESM (`.mjs`), built-in `fetch` (Node 22), `linkedom` (new), `@mozilla/readability` (existing, now run in Node), `turndown` (existing), `xlsx` (existing, for CSV), `node --test`.

**Spec:** [docs/superpowers/specs/2026-10-09-text-extraction-http-first-design.md](../specs/2026-10-09-text-extraction-http-first-design.md)

## Global Constraints

- ES modules only (`.mjs`). The ONLY new dependency is `linkedom` (already added to `package.json` during design probing — Task 1 just commits it). No `jsdom`. `fetch` is built-in; `xlsx` is reused for CSV.
- Text is a parallel path: do NOT change `ImageCapture`, `ImageProcessor`, the orchestrator, strategies, the validator, the image packagers, or `src/pipeline.mjs scrapeJob`'s image branch. The image path must behave exactly as before when not in text mode.
- Every source (static `fetch` body and browser `page.content()`) is parsed by the SAME `parseHtml` (linkedom) so extractors never branch on source.
- Extractors are pure and never throw; each returns `{ kind, empty, ...payload }`.
- `scrapeText`/`acquireAndExtract` never throw into the batch loop. Empty content after escalation → `EMPTY_RESULT`; non-2xx → `HTTP_ERROR`; transport throw → `mapError` code.
- Text result shape (so the breaker / status / `reason` column / summary work): success `{ ok:true, complete:true, saved, contentType:"text", bytes, requests, via }`; failure via `fail(code)` = `{ ok:false, complete:false, saved:0, contentType:"text", attempts:[{ name:"text", status:"failed", code }] }` spread with `{ bytes, requests }` — **NO top-level `error`** (so `failureCodeOf` reads the code from `attempts[]`).
- A page that loads but yields zero matches/fields is a **clean success** `{ ok:true, complete:true, saved:0 }` — NOT a failure; the breaker must not trip on it.
- The shipped `--text` (no mode/flags) behavior is unchanged: article → one `.md`.
- Tests use `node:test` + `node:assert/strict`, fixture HTML + fakes (fake `fetchFn`, fake `session`/page), NO real browser and NO network.
- Commit after each task; message ends with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Review Focus

- **`--pattern email` over a URL list** → aggregate CSV + JSON, one deduped row per URL, `saved` = match count, `via` recorded (Tasks 2, 6, 8, 9).
- **A page that loads with zero matches/fields** → `{ ok:true, complete:true, saved:0 }`, breaker NOT tripped (Tasks 2, 3, 8).
- **A JS-gated page (static fetch returns HTML but the extractor finds nothing)** → escalates to the browser and extracts there (Task 5).
- **A transport failure (non-2xx / DNS / timeout)** → mapped code (`HTTP_ERROR`/`NETWORK_ERROR`/`TIMEOUT`), feeds the breaker, written to `reason`, and the result carries NO top-level `error` (Tasks 5, 8).
- **`--text` with no mode/flags** → article → `.md`, exactly as shipped; image runs unaffected (Tasks 8, 9).

---

## File Structure

- **New:** `src/text/dom.mjs` (linkedom wrapper), `src/text/extractors/pattern.mjs`, `src/text/extractors/selector.mjs`, `src/text/extractors/article.mjs`, `src/text/extractors/registry.mjs`, `src/text/acquire.mjs`, `src/text/records.mjs`.
- **Changed:** `src/strategies/strategy.mjs` (extend `mapError` for `fetch`), `src/naming.mjs` (`resolveRecordBase`), `src/config.mjs` (repeatable args + text-mode flags/keys), `src/profiles/profile.mjs` (doc), `src/text/scrape-text.mjs` (rewired), `src/pipeline.mjs` (RecordWriter wiring, dry-run, `via` tally), `README.md`, `scraper.config.example.json`.
- **Removed:** `src/text/extract.mjs` + `test/text-extract.test.mjs` (replaced by `extractors/article.mjs`).
- **Tests:** `test/text-dom.test.mjs`, `test/text-pattern.test.mjs`, `test/text-selector.test.mjs`, `test/text-article.test.mjs`, `test/text-acquire.test.mjs`, `test/text-records.test.mjs`, appends to `test/naming.test.mjs`, `test/config.test.mjs`, rewrite of `test/text-scrape.test.mjs`, appends to `test/pipeline.test.mjs`.

---

## Task 1: `linkedom` dependency + DOM wrapper (`src/text/dom.mjs`)

**Files:**
- Modify: `package.json`, `package-lock.json` (commit the already-installed `linkedom`)
- Create: `src/text/dom.mjs`
- Test: `test/text-dom.test.mjs`

**Interfaces:**
- Consumes: `linkedom`.
- Produces: `parseHtml(html) → { document }` (a DOM Document for querying; linkedom, no jsdom).

- [ ] **Step 1: Confirm the dependency is present**

Run: `node -e "console.log(require('./package.json').dependencies.linkedom)"`
Expected: a version (e.g. `^0.18.13`). If it prints `undefined`, run `npm install linkedom`.

- [ ] **Step 2: Write the failing test**

```js
// test/text-dom.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";

test("parseHtml: returns a queryable Document", () => {
  const { document } = parseHtml('<html><body><h1>Hi</h1><p class="a">x</p><p class="a">y</p></body></html>');
  assert.equal(document.querySelector("h1").textContent, "Hi");
  assert.equal([...document.querySelectorAll("p.a")].map((e) => e.textContent).join(","), "x,y");
});

test("parseHtml: empty/garbage input still yields a Document (no throw)", () => {
  const { document } = parseHtml("");
  assert.ok(document);
  assert.equal(document.querySelector("nope"), null);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/text-dom.test.mjs`
Expected: FAIL — cannot find module `../src/text/dom.mjs`.

- [ ] **Step 4: Write the implementation**

```js
// src/text/dom.mjs
// Parse an HTML string into a queryable DOM Document using linkedom (pure JS, no
// jsdom). One wrapper used for BOTH the static-fetch body and the browser's
// page.content(), so every extractor sees the same Document type.
import { parseHTML } from "linkedom";

export function parseHtml(html) {
  const { document } = parseHTML(String(html || "<html><body></body></html>"));
  return { document };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/text-dom.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/text/dom.mjs test/text-dom.test.mjs
git commit -m "feat(text): add linkedom + parseHtml DOM wrapper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pattern extractor + registry (`src/text/extractors/pattern.mjs`, `registry.mjs`)

**Files:**
- Create: `src/text/extractors/pattern.mjs`, `src/text/extractors/registry.mjs`
- Test: `test/text-pattern.test.mjs`

**Interfaces:**
- Consumes: `parseHtml` (Task 1, in tests).
- Produces:
  - `resolvePatterns(specs) → [{ name, regex }]` (presets `email`/`phone`/`url`, or `name=/regex/flags`).
  - `extractPattern(doc, html, { patterns }) → { kind:"pattern", empty, matches:[{ type, value }] }`.
  - `registry.mjs`: `EXTRACTORS = { pattern: extractPattern }` (selector/article added in Tasks 3/4).

- [ ] **Step 1: Write the failing test**

```js
// test/text-pattern.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";
import { extractPattern, resolvePatterns } from "../src/text/extractors/pattern.mjs";

const html = `<html><body>
<p>Email a@b.com and A@B.COM again, plus c@d.org.</p>
<a href="mailto:hidden@site.io">mail</a>
<p>Call +1-555-123-4567 or visit https://example.com/x</p>
</body></html>`;

test("extractPattern: email preset finds + dedups (case-insensitive), incl. mailto", () => {
  const { document } = parseHtml(html);
  const r = extractPattern(document, html, { patterns: resolvePatterns(["email"]) });
  assert.equal(r.kind, "pattern");
  assert.equal(r.empty, false);
  const emails = r.matches.filter((m) => m.type === "email").map((m) => m.value.toLowerCase());
  assert.ok(emails.includes("a@b.com"));
  assert.ok(emails.includes("c@d.org"));
  assert.ok(emails.includes("hidden@site.io"));
  // a@b.com and A@B.COM dedup to one
  assert.equal(emails.filter((v) => v === "a@b.com").length, 1);
});

test("extractPattern: url + phone presets", () => {
  const { document } = parseHtml(html);
  const r = extractPattern(document, html, { patterns: resolvePatterns(["url", "phone"]) });
  assert.ok(r.matches.some((m) => m.type === "url" && m.value === "https://example.com/x"));
  assert.ok(r.matches.some((m) => m.type === "phone"));
});

test("extractPattern: custom name=/regex/ spec", () => {
  const { document } = parseHtml('<body>SKU-123 and SKU-999</body>');
  const r = extractPattern(document, '<body>SKU-123 and SKU-999</body>', { patterns: resolvePatterns(["sku=/SKU-\\d+/"]) });
  const skus = r.matches.filter((m) => m.type === "sku").map((m) => m.value);
  assert.deepEqual(skus, ["SKU-123", "SKU-999"]);
});

test("extractPattern: no matches → empty:true", () => {
  const { document } = parseHtml("<body>nothing here</body>");
  const r = extractPattern(document, "<body>nothing here</body>", { patterns: resolvePatterns(["email"]) });
  assert.equal(r.empty, true);
  assert.deepEqual(r.matches, []);
});

test("resolvePatterns: rejects an unknown bare word", () => {
  assert.throws(() => resolvePatterns(["bogus"]), /unknown pattern/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/text-pattern.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```js
// src/text/extractors/pattern.mjs
// Targeted-data extraction by regex (emails, phones, urls, custom). Scans the
// page's visible text AND the raw HTML (to catch mailto:/tel: hrefs and
// attributes), then dedups per type (case-insensitive) preserving first-seen order.
// Pure; never throws.

const PRESETS = {
  email: () => /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  // +country, groups, separators -, ., space, (); 7+ digits overall.
  phone: () => /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g,
  url: () => /https?:\/\/[^\s"'<>)]+/gi
};

// specs: array of "email" | "phone" | "url" | "name=/regex/flags".
// Returns [{ name, regex }] with fresh (global) RegExp objects.
export function resolvePatterns(specs = []) {
  const out = [];
  for (const spec of specs) {
    const s = String(spec);
    if (PRESETS[s]) { out.push({ name: s, regex: PRESETS[s]() }); continue; }
    const eq = s.indexOf("=");
    const name = eq > 0 ? s.slice(0, eq) : "";
    const body = eq > 0 ? s.slice(eq + 1) : "";
    const m = /^\/(.*)\/([a-z]*)$/i.exec(body);
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !m) {
      throw new Error(`unknown pattern "${s}" (use a preset email|phone|url, or name=/regex/flags)`);
    }
    const flags = m[2].includes("g") ? m[2] : m[2] + "g"; // force global for matchAll
    out.push({ name, regex: new RegExp(m[1], flags) });
  }
  return out;
}

export function extractPattern(doc, html, { patterns = [] } = {}) {
  const text = (doc?.body?.textContent || "") + "\n" + String(html || "");
  const matches = [];
  for (const { name, regex } of patterns) {
    const seen = new Set();
    for (const m of text.matchAll(regex)) {
      const value = m[0];
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ type: name, value });
    }
  }
  return { kind: "pattern", empty: matches.length === 0, matches };
}
```

```js
// src/text/extractors/registry.mjs
// name → extractor(doc, html, opts). Mirrors strategies/registry.mjs. Adding a
// mode = create its file + one line here.
import { extractPattern } from "./pattern.mjs";

export const EXTRACTORS = {
  pattern: extractPattern
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/text-pattern.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/text/extractors/pattern.mjs src/text/extractors/registry.mjs test/text-pattern.test.mjs
git commit -m "feat(text): pattern extractor (email/phone/url/custom) + extractor registry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Selector extractor (`src/text/extractors/selector.mjs`)

**Files:**
- Create: `src/text/extractors/selector.mjs`
- Modify: `src/text/extractors/registry.mjs` (add `selector`)
- Test: `test/text-selector.test.mjs`

**Interfaces:**
- Produces: `extractSelector(doc, html, { fields }) → { kind:"selector", empty, fields:{ [name]: value|value[]|null } }`. `fields` spec entries: `{ name, selector, attr?, many? }`.

- [ ] **Step 1: Write the failing test**

```js
// test/text-selector.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";
import { extractSelector } from "../src/text/extractors/selector.mjs";

const html = `<html><body>
<h1 class="title">Hello</h1>
<a class="site" href="https://x/">link</a>
<ul><li class="tag">a</li><li class="tag">b</li></ul>
</body></html>`;

test("extractSelector: textContent (first match) + attr + many", () => {
  const { document } = parseHtml(html);
  const r = extractSelector(document, html, { fields: [
    { name: "title", selector: ".title" },
    { name: "href", selector: ".site", attr: "href" },
    { name: "tags", selector: ".tag", many: true }
  ] });
  assert.equal(r.kind, "selector");
  assert.equal(r.empty, false);
  assert.equal(r.fields.title, "Hello");
  assert.equal(r.fields.href, "https://x/");
  assert.deepEqual(r.fields.tags, ["a", "b"]);
});

test("extractSelector: missing field → null; all missing → empty:true", () => {
  const { document } = parseHtml("<body><p>x</p></body>");
  const r = extractSelector(document, "<body><p>x</p></body>", { fields: [
    { name: "title", selector: ".nope" },
    { name: "tags", selector: ".none", many: true }
  ] });
  assert.equal(r.fields.title, null);
  assert.deepEqual(r.fields.tags, []);
  assert.equal(r.empty, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/text-selector.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```js
// src/text/extractors/selector.mjs
// Named-field extraction by CSS selector. attr → element attribute, else trimmed
// textContent; many:true → array of all matches, else first (or null). Pure.
export function extractSelector(doc, html, { fields = [] } = {}) {
  const read = (el, attr) => {
    if (!el) return null;
    const v = attr ? el.getAttribute(attr) : el.textContent;
    return v == null ? null : String(v).trim();
  };
  const out = {};
  let any = false;
  for (const f of fields) {
    if (f.many) {
      const vals = [...doc.querySelectorAll(f.selector)].map((el) => read(el, f.attr)).filter((v) => v != null && v !== "");
      out[f.name] = vals;
      if (vals.length) any = true;
    } else {
      const v = read(doc.querySelector(f.selector), f.attr);
      out[f.name] = v && v !== "" ? v : null;
      if (out[f.name] != null) any = true;
    }
  }
  return { kind: "selector", empty: !any, fields: out };
}
```

Add to `src/text/extractors/registry.mjs`:
```js
import { extractSelector } from "./selector.mjs";
// ... in EXTRACTORS:
  selector: extractSelector,
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/text-selector.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/text/extractors/selector.mjs src/text/extractors/registry.mjs test/text-selector.test.mjs
git commit -m "feat(text): selector extractor (css fields, attr/many)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Article extractor — Node-side Readability (`src/text/extractors/article.mjs`); remove in-page `extract.mjs`

**Files:**
- Create: `src/text/extractors/article.mjs`
- Modify: `src/text/extractors/registry.mjs` (add `article`)
- Remove: `src/text/extract.mjs`, `test/text-extract.test.mjs`
- Test: `test/text-article.test.mjs`

**Interfaces:**
- Consumes: `@mozilla/readability` (Node, on a linkedom doc), `htmlToMarkdown` (`src/text/markdown.mjs`).
- Produces: `extractArticle(doc, html, { selector } = {}, deps = {}) → { kind:"article", empty, title, byline, excerpt, markdown }`. `deps.runReadability` injectable.

- [ ] **Step 1: Write the failing test**

```js
// test/text-article.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";
import { extractArticle } from "../src/text/extractors/article.mjs";

const article = `<!doctype html><html><head><title>Doc Title</title>
<meta name="author" content="Jane"></head><body><header>nav</header>
<article><h1>Heading</h1>
<p>First paragraph with <strong>bold</strong>, long enough for the readability scorer to keep this article node in the output of the parse call here.</p>
<p>Second paragraph also sufficiently long so the scorer treats this article element as the page's main content instead of discarding the node.</p>
</article><footer>junk</footer></body></html>`;

test("extractArticle: Readability → markdown with title/byline", () => {
  const { document } = parseHtml(article);
  const r = extractArticle(document, article);
  assert.equal(r.kind, "article");
  assert.equal(r.empty, false);
  assert.match(r.title, /Doc Title|Heading/);
  assert.match(r.markdown, /\*\*bold\*\*/);
});

test("extractArticle: selector override wins", () => {
  const html = '<body><div class="main"><p>Just <em>this</em> block.</p></div><p>other</p></body>';
  const { document } = parseHtml(html);
  const r = extractArticle(document, html, { selector: ".main" });
  assert.match(r.markdown, /_this_|\*this\*/);
});

test("extractArticle: fallback to body when readability yields nothing", () => {
  const html = "<body><p>tiny</p></body>";
  const { document } = parseHtml(html);
  const r = extractArticle(document, html, {}, { runReadability: () => null });
  assert.equal(r.empty, false);
  assert.match(r.markdown, /tiny/);
});

test("extractArticle: truly empty → empty:true", () => {
  const { document } = parseHtml("<body></body>");
  const r = extractArticle(document, "<body></body>", {}, { runReadability: () => null });
  assert.equal(r.empty, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/text-article.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```js
// src/text/extractors/article.mjs
// Clean-prose extraction: @mozilla/readability run in Node on a linkedom doc
// (the design probe confirmed this works), with a selector/article/main/body
// fallback, converted to Markdown by the existing turndown helper. Pure; never
// throws. Replaces the old in-page (page.evaluate) extractor.
import { Readability } from "@mozilla/readability";
import { htmlToMarkdown } from "../markdown.mjs";

// Readability mutates its document, so parse returns { title, html, byline, excerpt }
// or null. Injectable for tests.
function defaultRunReadability(doc) {
  try {
    const a = new Readability(doc).parse();
    return a && a.content ? { title: a.title || null, html: a.content, byline: a.byline || null, excerpt: a.excerpt || null } : null;
  } catch { return null; }
}

function fallbackHtml(doc, selector) {
  const el =
    (selector && doc.querySelector(selector)) ||
    doc.querySelector("article") ||
    doc.querySelector("main") ||
    doc.body;
  return el ? { title: doc.title || null, html: el.innerHTML || el.textContent || "", byline: null, excerpt: null } : null;
}

export function extractArticle(doc, html, { selector } = {}, deps = {}) {
  const runReadability = deps.runReadability || defaultRunReadability;
  // Selector override first (profile-provided), else Readability, else body fallback.
  let a = null;
  if (selector) {
    const el = doc.querySelector(selector);
    if (el) a = { title: doc.title || null, html: el.innerHTML || "", byline: null, excerpt: null };
  }
  if (!a || !a.html) a = runReadability(doc);
  if (!a || !a.html) a = fallbackHtml(doc, selector);
  const markdown = a && a.html ? htmlToMarkdown(a.html) : "";
  return {
    kind: "article",
    empty: !markdown,
    title: a?.title || null,
    byline: a?.byline || null,
    excerpt: a?.excerpt || null,
    markdown
  };
}
```

Add to `src/text/extractors/registry.mjs`:
```js
import { extractArticle } from "./article.mjs";
// ... in EXTRACTORS:
  article: extractArticle,
```

- [ ] **Step 4: Remove the obsolete in-page extractor**

```bash
git rm src/text/extract.mjs test/text-extract.test.mjs
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/text-article.test.mjs`
Expected: PASS (4 tests).
Run: `node --test test/text-markdown.test.mjs`
Expected: still PASS (markdown helper unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/text/extractors/article.mjs src/text/extractors/registry.mjs test/text-article.test.mjs
git commit -m "feat(text): Node-side Readability article extractor; drop in-page extract.mjs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: HTTP-first acquisition + escalation (`src/text/acquire.mjs`); extend `mapError`

**Files:**
- Create: `src/text/acquire.mjs`
- Modify: `src/strategies/strategy.mjs` (extend `mapError` for `fetch`)
- Test: `test/text-acquire.test.mjs`

**Interfaces:**
- Consumes: `EXTRACTORS` (Task 2–4), `parseHtml` (Task 1), `openReader` (`src/navigation.mjs`), `mapError`/`FailureCode` (`src/strategies/strategy.mjs`).
- Produces: `acquireAndExtract({ url, mode, opts, session, config, logger, deps = {} }) → { status:"ok", payload, via, bytes, requests } | { status:"fail", code, bytes, requests }`. `deps` injects `fetchFn`, `openReader`, `parseHtml`, `extractors`.

- [ ] **Step 1: Write the failing test**

```js
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

test("static loads but extractor empty → escalate to browser (via:browser)", async () => {
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: fakeSession("<body>HIT</body>"),
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => okResp("<body>nope</body>"), openReader: async () => {}, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "ok");
  assert.equal(r.via, "browser");
});

test("non-2xx → escalate; browser empty too → EMPTY_RESULT", async () => {
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: fakeSession("<body>nope</body>"),
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => ({ ok: false, status: 503, headers: { get: () => "text/html" }, text: async () => "" }), openReader: async () => {}, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.code, "EMPTY_RESULT");
});

test("static network throw → escalates; browser empty → EMPTY_RESULT", async () => {
  const r = await acquireAndExtract({
    url: "https://x/a", mode: "echo", opts: {}, session: fakeSession("<body>nope</body>"),
    config: { httpFirst: true, navTimeout: 1000 }, logger: noopLogger,
    deps: { fetchFn: async () => { throw new TypeError("fetch failed"); }, openReader: async () => {}, extractors, parseHtml: (h) => ({ document: { body: { textContent: h } } }) }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.code, "EMPTY_RESULT");
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/text-acquire.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Extend `mapError` in `src/strategies/strategy.mjs`**

In `mapError`, add `fetch`-specific network detection to the existing network branch:
```js
  if (msg.includes("net::") || msg.includes("econn") || msg.includes("socket") || msg.includes("dns") ||
      msg.includes("network") || msg.includes("fetch failed") || msg.includes("enotfound") || msg.includes("getaddrinfo"))
    return FailureCode.NETWORK_ERROR;
```
(Leave the `TimeoutError`/`timeout` branch above it — `AbortSignal.timeout` throws a `TimeoutError`, already mapped.)

- [ ] **Step 4: Write the implementation**

```js
// src/text/acquire.mjs
// HTTP-first acquisition with extraction-aware escalation. Fetch the URL over
// built-in fetch; parse to a linkedom doc; run the chosen extractor. Escalate to
// the browser (existing openReader) only when the static path fails OR the
// extractor finds nothing. Never throws into the caller.
import { parseHtml as defaultParseHtml } from "./dom.mjs";
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { EXTRACTORS as defaultExtractors } from "./extractors/registry.mjs";
import { mapError, FailureCode } from "../strategies/strategy.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export async function acquireAndExtract({ url, mode, opts, session, config, logger, deps = {} }) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const openReader = deps.openReader || defaultOpenReader;
  const parseHtml = deps.parseHtml || defaultParseHtml;
  const extractors = deps.extractors || defaultExtractors;
  const extract = extractors[mode];
  if (!extract) return { status: "fail", code: FailureCode.PARSER_ERROR, bytes: 0, requests: 0 };

  let bytes = 0, requests = 0;

  // 1) STATIC
  if (config.httpFirst !== false) {
    try {
      const res = await fetchFn(url, {
        redirect: "follow",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(config.navTimeout || 45000)
      });
      requests += 1;
      const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
      if (res.ok && (ctype === "" || ctype.includes("html") || ctype.includes("xml"))) {
        const html = await res.text();
        bytes += Buffer.byteLength(html || "", "utf8");
        const { document } = parseHtml(html);
        const payload = extract(document, html, opts);
        if (!payload.empty) return { status: "ok", payload, via: "http", bytes, requests };
        logger.verbose?.(`static fetch yielded nothing for ${url} — escalating to browser`);
      } else {
        logger.verbose?.(`static fetch not usable (status=${res.status} type=${ctype || "?"}) — escalating`);
      }
    } catch (e) {
      logger.verbose?.(`static fetch failed for ${url} (${e?.message || e}) — escalating`);
    }
  }

  // 2) ESCALATE → browser
  let page;
  try {
    page = await session.newPage();
    const BandwidthMeter = deps.BandwidthMeter; // optional in tests
    const meter = BandwidthMeter ? new BandwidthMeter() : null;
    meter?.attach?.(page);
    await openReader(page, url, config, logger);
    const html = await page.content();
    if (meter) { bytes += meter.bytes; requests += meter.count; }
    const { document } = parseHtml(html);
    const payload = extract(document, html, opts);
    if (!payload.empty) return { status: "ok", payload, via: "browser", bytes, requests };
    return { status: "fail", code: FailureCode.EMPTY_RESULT, bytes, requests };
  } catch (e) {
    logger.error?.(`browser acquisition failed for ${url}: ${e?.message || e}`);
    return { status: "fail", code: mapError(e), bytes, requests };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/text-acquire.test.mjs`
Expected: PASS (6 tests).
Run: `node --test test/strategy.test.mjs` (if present) or the strategies tests
Expected: still PASS (mapError change is additive).

- [ ] **Step 6: Commit**

```bash
git add src/text/acquire.mjs src/strategies/strategy.mjs test/text-acquire.test.mjs
git commit -m "feat(text): HTTP-first acquisition with browser escalation; fetch-aware mapError

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Record writer — aggregate CSV + JSON (`src/text/records.mjs`)

**Files:**
- Create: `src/text/records.mjs`
- Test: `test/text-records.test.mjs`

**Interfaces:**
- Consumes: `xlsx` (CSV), `node:fs/promises`.
- Produces: `class RecordWriter { constructor(base, deps = {}); async append(record); get count; get jsonPath; get csvPath; }`. `record` is a plain object (must include `url`). Writes `<base>.json` and `<base>.csv` after every append (incremental persistence). Array-valued cells are joined with `"; "` in CSV; JSON keeps arrays. CSV columns = `url` first, then the union of all other keys in first-seen order.

- [ ] **Step 1: Write the failing test**

```js
// test/text-records.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordWriter } from "../src/text/records.mjs";

async function tmp(fn) { const d = await mkdtemp(path.join(tmpdir(), "rec-")); try { return await fn(d); } finally { await rm(d, { recursive: true, force: true }); } }

test("RecordWriter: writes JSON + CSV, incremental, union columns, ; join", async () => {
  await tmp(async (dir) => {
    const w = new RecordWriter(path.join(dir, "out"));
    await w.append({ url: "https://a", email: ["x@a.com", "y@a.com"] });
    // after first append, file already exists (incremental)
    const j1 = JSON.parse(await readFile(path.join(dir, "out.json"), "utf8"));
    assert.equal(j1.length, 1);
    await w.append({ url: "https://b", phone: ["555"] });
    const j2 = JSON.parse(await readFile(path.join(dir, "out.json"), "utf8"));
    assert.equal(j2.length, 2);
    assert.deepEqual(j2[0].email, ["x@a.com", "y@a.com"]);
    const csv = await readFile(path.join(dir, "out.csv"), "utf8");
    assert.match(csv.split("\n")[0], /url/);
    assert.match(csv, /email/);
    assert.match(csv, /phone/);
    assert.match(csv, /x@a.com; y@a.com/); // array joined with "; "
    assert.equal(w.count, 2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/text-records.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```js
// src/text/records.mjs
// Aggregate record output for pattern/selector modes: one row per URL, written
// incrementally to <base>.json (arrays preserved) and <base>.csv (array cells
// joined with "; "). Rewrites both files after every append so a mid-run crash
// keeps completed URLs. CSV via the already-present xlsx dep.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import xlsx from "xlsx";

export class RecordWriter {
  constructor(base, deps = {}) {
    this.jsonPath = `${base}.json`;
    this.csvPath = `${base}.csv`;
    this._records = [];
    this._writeFile = deps.writeFile || writeFile;
    this._ensured = false;
  }

  get count() { return this._records.length; }

  async append(record) {
    this._records.push(record);
    await this._flush();
  }

  async _flush() {
    if (!this._ensured) { await mkdir(path.dirname(this.jsonPath), { recursive: true }); this._ensured = true; }
    await this._writeFile(this.jsonPath, JSON.stringify(this._records, null, 2));
    // Union of keys, url first, first-seen order after.
    const header = ["url"];
    for (const r of this._records) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
    const rows = this._records.map((r) => {
      const row = {};
      for (const k of header) {
        const v = r[k];
        row[k] = Array.isArray(v) ? v.join("; ") : (v == null ? "" : v);
      }
      return row;
    });
    const ws = xlsx.utils.json_to_sheet(rows, { header });
    await this._writeFile(this.csvPath, xlsx.utils.sheet_to_csv(ws));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/text-records.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/text/records.mjs test/text-records.test.mjs
git commit -m "feat(text): RecordWriter — incremental aggregate CSV + JSON

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Naming `resolveRecordBase` + config flags/keys + profile doc

**Files:**
- Modify: `src/naming.mjs`, `src/config.mjs`, `src/profiles/profile.mjs`
- Test: `test/naming.test.mjs` (append), `test/config.test.mjs` (append)

**Interfaces:**
- Produces: `resolveRecordBase(config) → string` (no extension); `config.textMode` (string), `config.textSelect` (string[]), `config.textPatterns` (string[]), `config.httpFirst` (bool); repeatable `--select`/`--pattern`.

- [ ] **Step 1: Write the failing tests**

Append to `test/naming.test.mjs`:
```js
import { resolveRecordBase } from "../src/naming.mjs";
test("resolveRecordBase: single-URL uses out; batch uses out/results; textName overrides", () => {
  assert.equal(resolveRecordBase({ listFile: null, out: "myout" }), "myout");
  assert.equal(resolveRecordBase({ listFile: "l.csv", out: "downloads" }), path.join("downloads", "results"));
  assert.equal(resolveRecordBase({ listFile: "l.csv", out: "downloads", textName: "contacts" }), "contacts");
  assert.equal(resolveRecordBase({ listFile: null, out: null }), "results");
});
```

Append to `test/config.test.mjs`:
```js
import { parseArgs } from "../src/config.mjs";
test("text modes: --text-mode, repeatable --select/--pattern, --no-http-first", () => {
  const a = parseArgs(["--select", ".a", "--select", "price=.p", "--pattern", "email", "--no-http-first"]);
  assert.deepEqual(a.select, [".a", "price=.p"]);
  assert.deepEqual(a.pattern, ["email"]);
  const c = buildConfig({ _: ["https://x"], select: [".a", "price=.p"] }, {});
  assert.equal(c.textMode, "selector");
  assert.deepEqual(c.textSelect, [".a", "price=.p"]);
  const p = buildConfig({ _: ["https://x"], pattern: ["email"] }, {});
  assert.equal(p.textMode, "pattern");
  assert.equal(buildConfig({ _: ["https://x"], "no-http-first": true }, {}).httpFirst, false);
  assert.equal(buildConfig({ _: ["https://x"] }, {}).httpFirst, true);
});
test("text mode default is article when --text with no select/pattern", () => {
  assert.equal(buildConfig({ _: ["https://x"], text: true }, {}).textMode, "article");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/naming.test.mjs test/config.test.mjs`
Expected: the new tests FAIL.

- [ ] **Step 3: Add `resolveRecordBase` in `src/naming.mjs`**

Append:
```js
// Run-level base path (no extension) for aggregate record output (.json/.csv).
// Single-URL: --out (or "results"); batch: <out>/results; --text-name overrides.
export function resolveRecordBase(config) {
  if (config.textName) return config.textName;
  if (config.listFile) return path.join(config.out || "downloads", "results");
  return config.out || "results";
}
```

- [ ] **Step 4: Repeatable args + text keys in `src/config.mjs`**

In `parseArgs`, add a repeatable set and branch (keep `FLAGS` handling first):
```js
const REPEATABLE = new Set(["select", "pattern"]);
```
```js
      if (FLAGS.has(key)) { args[key] = true; continue; }
      if (REPEATABLE.has(key)) { (args[key] ||= []).push(argv[++i]); continue; }
      args[key] = argv[++i];
```
Add `"no-http-first"` to the `FLAGS` set.

In `DEFAULTS`, next to the existing `text`/`textName`:
```js
  // text extraction mode + its inputs; httpFirst = try a static fetch before the browser.
  textMode: "article", textSelect: [], textPatterns: [], httpFirst: true,
```

In `buildConfig`, after the existing `text`/`text-name` lines:
```js
  if (has("text-mode")) cfg.textMode = String(args["text-mode"]);
  const selects = Array.isArray(args.select) ? args.select : (has("select") ? [args.select] : []);
  const patterns = Array.isArray(args.pattern) ? args.pattern : (has("pattern") ? [args.pattern] : []);
  if (selects.length) { cfg.textSelect = selects; cfg.textMode = "selector"; cfg.text = true; }
  if (patterns.length) { cfg.textPatterns = patterns; cfg.textMode = "pattern"; cfg.text = true; }
  if (args["no-http-first"]) cfg.httpFirst = false;
```
(Order: a later `--pattern` after `--select` would flip mode to `pattern`; documented as last-wins. `--text` alone leaves `textMode:"article"`.)

- [ ] **Step 5: Update the profile doc in `src/profiles/profile.mjs`**

Extend the profile shape comment: `contentType: "image" | "text"`; add
`text?: { mode?: "article"|"pattern"|"selector", selector?: string, fields?: [{name,selector,attr?,many?}], patterns?: string[] }`.

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/naming.test.mjs test/config.test.mjs`
Expected: PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add src/naming.mjs src/config.mjs src/profiles/profile.mjs test/naming.test.mjs test/config.test.mjs
git commit -m "feat(text): resolveRecordBase + --text-mode/--select/--pattern/--no-http-first config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Rewire `scrapeText` onto acquisition + extractors + writers

**Files:**
- Modify: `src/text/scrape-text.mjs`
- Test: `test/text-scrape.test.mjs` (rewrite)

**Interfaces:**
- Consumes: `acquireAndExtract` (Task 5), `buildMarkdownDoc` (`markdown.mjs`), `resolveTargets` (`naming.mjs`), `resolvePatterns` (Task 2), `FailureCode` (strategy).
- Produces: `scrapeText(session, job, config, logger, profile, deps = {}) → result` where `deps.recordWriter` is the per-run writer (for pattern/selector), `deps.acquireAndExtract` injectable. Resolves mode, builds opts, calls acquisition, writes output, returns the text result shape with `via`.
- Helpers (exported for tests): `resolveMode(config, profile)`, `buildOpts(mode, config, profile)`, `toRecord(url, payload)`.

- [ ] **Step 1: Rewrite the test**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/text-scrape.test.mjs`
Expected: FAIL (new signature/helpers/imports not present).

- [ ] **Step 3: Rewrite the implementation**

```js
// src/text/scrape-text.mjs
// The text content path: resolve the extraction mode, acquire the page (HTTP-first,
// escalating to the browser), run the extractor, and write output — a .md for
// article mode, or a record appended to the run's aggregate CSV/JSON for
// pattern/selector. Returns the batch loop's result shape (with `via`).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireAndExtract as defaultAcquire } from "./acquire.mjs";
import { buildMarkdownDoc } from "./markdown.mjs";
import { resolveTargets } from "../naming.mjs";
import { resolvePatterns } from "./extractors/pattern.mjs";
import { FailureCode } from "../strategies/strategy.mjs";
import { BandwidthMeter } from "../bandwidth.mjs";

const fail = (code, bytes = 0, requests = 0) => ({ ok: false, complete: false, saved: 0, contentType: "text", attempts: [{ name: "text", status: "failed", code }], bytes, requests });

export function resolveMode(config, profile) {
  if (config.textMode && config.textMode !== "article") return config.textMode;
  if (profile?.text?.mode) return profile.text.mode;
  return config.textMode || "article";
}

// Build the extractor opts for a mode from CLI config + profile.
export function buildOpts(mode, config, profile) {
  const pt = profile?.text || {};
  if (mode === "pattern") {
    return { patterns: resolvePatterns(config.textPatterns?.length ? config.textPatterns : (pt.patterns || [])) };
  }
  if (mode === "selector") {
    const fromCli = (config.textSelect || []).map((s) => {
      const eq = s.indexOf("=");
      const name = eq > 0 && /^[A-Za-z0-9_-]+$/.test(s.slice(0, eq)) ? s.slice(0, eq) : null;
      return name ? { name, selector: s.slice(eq + 1) } : { name: "text", selector: s };
    });
    return { fields: fromCli.length ? fromCli : (pt.fields || (pt.selector ? [{ name: "text", selector: pt.selector }] : [])) };
  }
  // article
  return { selector: pt.selector };
}

// Shape a non-empty extractor payload into one aggregate record for the URL.
export function toRecord(url, payload) {
  if (payload.kind === "pattern") {
    const rec = { url };
    for (const m of payload.matches) (rec[m.type] ||= []).push(m.value);
    return rec;
  }
  return { url, ...payload.fields };
}

export async function scrapeText(session, job, config, logger, profile, deps = {}) {
  const acquireAndExtract = deps.acquireAndExtract || defaultAcquire;
  const recordWriter = deps.recordWriter || null;
  const mode = resolveMode(config, profile);
  let opts;
  try {
    opts = buildOpts(mode, config, profile);
  } catch (e) {
    logger.error?.(`text config error for ${job.url}: ${e?.message || e}`);
    return fail(FailureCode.PARSER_ERROR);
  }

  const acq = await acquireAndExtract({
    url: job.url, mode, opts, session, config, logger,
    deps: { BandwidthMeter }
  });
  if (acq.status !== "ok") {
    logger.error?.(`text scrape failed on ${job.url}: ${acq.code}`);
    return fail(acq.code, acq.bytes, acq.requests);
  }

  const { payload, via, bytes, requests } = acq;
  try {
    if (mode === "article") {
      const title = payload.title;
      const targets = resolveTargets(config, job, { outputName: title || undefined });
      const doc = buildMarkdownDoc({ title, source: job.url, date: new Date().toISOString().slice(0, 10), byline: payload.byline, excerpt: payload.excerpt, markdown: payload.markdown });
      await mkdir(path.dirname(targets.mdPath), { recursive: true });
      await writeFile(targets.mdPath, doc);
      logger.success?.(`wrote Markdown (${doc.length} bytes, via ${via}) → ${targets.mdPath}`);
      return { ok: true, complete: true, saved: 1, contentType: "text", bytes, requests, via };
    }
    // pattern / selector → record
    const record = toRecord(job.url, payload);
    const saved = mode === "pattern" ? payload.matches.length : Object.keys(payload.fields).filter((k) => { const v = payload.fields[k]; return Array.isArray(v) ? v.length : v != null; }).length;
    if (recordWriter) await recordWriter.append(record);
    logger.success?.(`extracted ${saved} ${mode} value(s) from ${job.url} (via ${via})`);
    return { ok: true, complete: true, saved, contentType: "text", bytes, requests, via };
  } catch (e) {
    logger.error?.(`text write failed on ${job.url}: ${e?.message || e}`);
    return fail(FailureCode.UNKNOWN_ERROR, bytes, requests);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/text-scrape.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/text/scrape-text.mjs test/text-scrape.test.mjs
git commit -m "feat(text): rewire scrapeText onto acquisition + extractors + record/md writers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Pipeline wiring (RecordWriter, dry-run, `via` tally) + docs

**Files:**
- Modify: `src/pipeline.mjs`, `README.md`, `scraper.config.example.json`
- Test: `test/pipeline.test.mjs` (append)

**Interfaces:**
- Consumes: `scrapeText` (Task 8), `RecordWriter` (Task 6), `resolveRecordBase` (Task 7).
- Produces: a per-run `RecordWriter` passed into `_scrapeText` via deps; dry-run shows mode + targets; summary reports the `via` tally.

- [ ] **Step 1: Write the failing tests**

Append to `test/pipeline.test.mjs`:
```js
test("_runJobs: records-mode text job appends to the run RecordWriter", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0, text: true, textMode: "pattern" }, noopLogger);
  const appended = [];
  runner._recordWriter = { append: async (r) => appended.push(r), count: 0 };
  runner._resolveProfile = () => ({ name: "generic", contentType: "text" });
  runner._scrapeText = async (s, job, config, logger, profile, deps) => { await deps.recordWriter.append({ url: job.url, email: ["a@b"] }); return { ok: true, complete: true, saved: 1, contentType: "text", via: "http" }; };
  const source = { hasStatus: false, setStatus() {}, setReason() {} };
  await runner._runJobs({ jobs: [{ url: "https://x/a", status: "" }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.deepEqual(appended, [{ url: "https://x/a", email: ["a@b"] }]);
});

test("_runJobs: article text job still routes to _scrapeText (no record writer needed)", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0, text: true, textMode: "article" }, noopLogger);
  const calls = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "text" });
  runner._scrapeText = async (s, job) => { calls.push(job.url); return { ok: true, complete: true, saved: 1, contentType: "text", via: "browser" }; };
  const source = { hasStatus: false, setStatus() {}, setReason() {} };
  await runner._runJobs({ jobs: [{ url: "https://x/a", status: "" }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.deepEqual(calls, ["https://x/a"]);
});
```
(`CircuitBreaker` already imported in `test/pipeline.test.mjs`.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pipeline.test.mjs`
Expected: new tests FAIL (deps.recordWriter not passed).

- [ ] **Step 3: Create the RecordWriter for the run and pass it through**

In `src/pipeline.mjs`, import:
```js
import { RecordWriter } from "./text/records.mjs";
import { resolveRecordBase } from "./naming.mjs";   // add to the existing naming import if present
import { resolveMode } from "./text/scrape-text.mjs"; // add to the existing scrape-text import
```
In the `BatchRunner` constructor, add:
```js
    this._recordWriter = null; // created lazily on the first records-mode text job
```
In `_runJobs`, in the text branch, resolve the mode, lazily create the shared
writer for records modes (handles both `--pattern/--select` and profile-driven
modes, and mixed batches), pass it through, and capture `via`:
```js
        if (contentType === "text") {
          const mode = resolveMode(this.config, profile);
          this.logger.verbose(`profile=${profile.name} contentType=text mode=${mode}`);
          if ((mode === "pattern" || mode === "selector") && !this._recordWriter) {
            this._recordWriter = new RecordWriter(resolveRecordBase(this.config));
          }
          const r = await this._scrapeText(session, job, this.config, this.logger, profile, { recordWriter: this._recordWriter });
          complete = r.complete;
          rec = { ...job, ...r, ok: complete };
        } else {
```

- [ ] **Step 4: Dry-run + summary**

In `describeDryRun`, replace the `if (config.text)` block so it reflects the mode:
```js
    if (config.text) {
      const mode = config.textMode || "article";
      lines.push(`    will scrape (text: ${mode})`);
      if (mode === "article") lines.push(`    md → ${targets.mdPath}`);
      else { const base = resolveRecordBase(config); lines.push(`    records → ${base}.json, ${base}.csv`); }
      return;
    }
```
In `_summary`, after the bandwidth line (batch branch), add a `via` tally over text results:
```js
      const viaHttp = attempted.filter((r) => r.via === "http").length;
      const viaBrowser = attempted.filter((r) => r.via === "browser").length;
      if (viaHttp || viaBrowser) this.logger.info(`text acquisition: ${viaHttp} via http, ${viaBrowser} via browser`);
```
After the loop in `run()` (records mode), log where records went:
```js
    if (this._recordWriter && this._recordWriter.count) this.logger.info(`wrote ${this._recordWriter.count} record(s) → ${this._recordWriter.jsonPath}, ${this._recordWriter.csvPath}`);
```

- [ ] **Step 5: Docs**

- `scraper.config.example.json`: add `"textMode": "article",` with a comment (article|pattern|selector) and `"httpFirst": true,` (static-fetch first; or `--no-http-first`).
- `README.md`: extend the "Text scraping" section — the three modes (`--text` article → `.md`; `--pattern email|phone|url|name=/regex/` → records; `--select "css"` or `--select "name=css"` → records), aggregate `.json`+`.csv` output, HTTP-first with browser escalation (`--no-http-first` to force the browser), and that a profile can set `text:{ mode, selector|fields, patterns }`.

- [ ] **Step 6: Run the pipeline tests + full suite**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — new + existing (image branch unchanged).

Run: `npm test`
Expected: PASS — every file green.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline.mjs README.md scraper.config.example.json test/pipeline.test.mjs
git commit -m "feat(text): wire RecordWriter + via tally + dry-run modes into the batch loop; docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite:** `npm test` → all green.
- [ ] **Dry-run smoke (pattern):** `node scrape.mjs https://example.com --pattern email --out out --dry-run` → shows `text: pattern` and `records → out.json, out.csv`, exits 0.
- [ ] **Live smoke (optional, network):** `node scrape.mjs https://example.com --pattern email,url --out out` (or two `--pattern` flags) → `out.json`/`out.csv` exist; run summary shows `via http` for a static page.
- [ ] **Article regression:** `node scrape.mjs <article-url> --text --out art` → `art.md` with frontmatter + body (via http when the page is static).
- [ ] **Image regression:** a normal image run (no `--text`/`--pattern`/`--select`) behaves exactly as before.
