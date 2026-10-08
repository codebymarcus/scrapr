# Text Content Type (HTML → Markdown) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `text` content type: scrape a page, extract its main content (Readability, or a profile selector), convert to Markdown, and write a `.md` — selected by a profile's `contentType:"text"` or an ad-hoc `--text` flag.

**Architecture:** A parallel `scrapeText` path branched in `BatchRunner._runJobs`; the image mechanisms/orchestrator/capture/sharp/cbz machinery is untouched. Text results reuse the existing result shape so the circuit breaker, `status`/`reason` column, and summary work for text unchanged. Readability runs inside the Playwright page (no jsdom); turndown converts in Node.

**Tech Stack:** Node.js ESM (`.mjs`), Playwright, `turndown`, `@mozilla/readability`, `node --test`.

**Spec:** [docs/superpowers/specs/2026-10-08-text-content-type-design.md](../specs/2026-10-08-text-content-type-design.md)

## Global Constraints

- ES modules only (`.mjs`). The only NEW dependencies are `turndown` and `@mozilla/readability` (added where first used). No `jsdom`.
- Text is a parallel path: do NOT change `ImageCapture`, `ImageProcessor`, the orchestrator, strategies, validator, or the image packagers. The image path must be byte-for-byte unchanged when not in text mode.
- Text result shape (so the batch loop / breaker / reason column work): success `{ ok:true, complete:true, saved:1, bytes, requests, contentType:"text" }`; failure `{ ok:false, complete:false, contentType:"text", error?, attempts:[{ name:"text", status:"failed", code }] }`.
- `scrapeText` never throws into the loop; empty content → `EMPTY_RESULT`; nav/thrown errors → `mapError` code.
- One URL → one `.md`; no pagination, no Drive upload of `.md`, no text-PDF.
- Output `.md` = YAML frontmatter (present fields only: title/source/date/author/excerpt) + `# title` + Markdown body.
- Tests use `node:test` + `node:assert/strict`, fakes, no real browser.
- Commit after each task; message ends with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Review Focus

- **`--text` on an arbitrary URL with no profile** → scraped as text via Readability, writes a `.md` (Tasks 4 & 5).
- **No/empty content extracted** → `EMPTY_RESULT`, no broken `.md` written (Task 4).
- **A text domain-health failure (e.g. TIMEOUT)** → still trips the circuit breaker and writes the `reason` (Task 5).
- **Image path unchanged when not text mode** → the content-type branch is only taken for text; image runs behave exactly as before (Task 5).
- **Readability returns nothing** → falls back to `article`/`main`/`body`, then `null` (Task 2).

---

## Task 1: `turndown` + Markdown module (`src/text/markdown.mjs`)

**Files:**
- Modify: `package.json` (add `turndown`)
- Create: `src/text/markdown.mjs`
- Test: `test/text-markdown.test.mjs`

**Interfaces:**
- Consumes: `turndown`.
- Produces: `htmlToMarkdown(html) → string`; `buildMarkdownDoc({ title, source, date, byline, excerpt, markdown }) → string`.

- [ ] **Step 1: Add the dependency**

Run: `npm install turndown`
Expected: `turndown` appears in `package.json` `dependencies`; `npm test` still green.

- [ ] **Step 2: Write the failing test**

```js
// test/text-markdown.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, buildMarkdownDoc } from "../src/text/markdown.mjs";

test("htmlToMarkdown: converts common HTML to Markdown", () => {
  const md = htmlToMarkdown('<h1>Title</h1><p>Hello <strong>world</strong> and <a href="https://x/">link</a>.</p><ul><li>a</li><li>b</li></ul>');
  assert.match(md, /^# Title/m);
  assert.match(md, /\*\*world\*\*/);
  assert.match(md, /\[link\]\(https:\/\/x\/\)/);
  assert.match(md, /^- a$/m);
  assert.match(md, /^- b$/m);
});

test("htmlToMarkdown: empty/nullish input → empty string", () => {
  assert.equal(htmlToMarkdown(""), "");
  assert.equal(htmlToMarkdown(null), "");
});

test("buildMarkdownDoc: frontmatter has only present fields, H1 title, body", () => {
  const doc = buildMarkdownDoc({ title: 'A "quote"', source: "https://x/1", date: "2026-10-08", byline: "Jane", markdown: "Body here." });
  assert.match(doc, /^---\n/);
  assert.match(doc, /title: "A \\"quote\\""/);
  assert.match(doc, /source: "https:\/\/x\/1"/);
  assert.match(doc, /author: "Jane"/);
  assert.doesNotMatch(doc, /excerpt:/); // omitted when absent
  assert.match(doc, /\n# A "quote"\n/);
  assert.match(doc, /Body here\./);
});

test("buildMarkdownDoc: no fields → no frontmatter, just body", () => {
  const doc = buildMarkdownDoc({ markdown: "Only body." });
  assert.doesNotMatch(doc, /^---/);
  assert.match(doc, /Only body\./);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/text-markdown.test.mjs`
Expected: FAIL — cannot find module `../src/text/markdown.mjs`.

- [ ] **Step 4: Write the implementation**

```js
// src/text/markdown.mjs
// Pure HTML→Markdown conversion + .md document assembly. turndown bundles its own
// Node DOM (@mixmark-io/domino), so this needs no jsdom.
import TurndownService from "turndown";

export function htmlToMarkdown(html) {
  if (!html) return "";
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  return td.turndown(String(html)).trim();
}

// Assemble the final .md: YAML frontmatter (present fields only) + an H1 title +
// the Markdown body. String values are quoted and escaped for YAML.
export function buildMarkdownDoc({ title, source, date, byline, excerpt, markdown } = {}) {
  const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const fm = [];
  if (title) fm.push(`title: ${q(title)}`);
  if (source) fm.push(`source: ${q(source)}`);
  if (date) fm.push(`date: ${q(date)}`);
  if (byline) fm.push(`author: ${q(byline)}`);
  if (excerpt) fm.push(`excerpt: ${q(excerpt)}`);
  const front = fm.length ? `---\n${fm.join("\n")}\n---\n\n` : "";
  const head = title ? `# ${title}\n\n` : "";
  return `${front}${head}${markdown || ""}\n`;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/text-markdown.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/text/markdown.mjs test/text-markdown.test.mjs
git commit -m "feat(text): turndown-based htmlToMarkdown + buildMarkdownDoc

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `@mozilla/readability` + article extraction (`src/text/extract.mjs`)

**Files:**
- Modify: `package.json` (add `@mozilla/readability`)
- Create: `src/text/extract.mjs`
- Test: `test/text-extract.test.mjs`

**Interfaces:**
- Consumes: `@mozilla/readability` (its `Readability.js` source, injected into the page).
- Produces:
  - `readSelector(page, selector)`, `runReadability(page)`, `readFallback(page)` — page-touching helpers, each returns `{ title, html, byline?, excerpt? }|null` and never throws.
  - `extractArticle(page, { selector } = {}, deps = {}) → { title, html, byline, excerpt }|null` — orchestrates the three (deps injectable for tests).

- [ ] **Step 1: Add the dependency**

Run: `npm install @mozilla/readability`
Expected: `@mozilla/readability` in `dependencies`; `npm test` still green.

- [ ] **Step 2: Write the failing test**

```js
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/text-extract.test.mjs`
Expected: FAIL — cannot find module `../src/text/extract.mjs`.

- [ ] **Step 4: Write the implementation**

```js
// src/text/extract.mjs
// Extract an article's main content HTML from an open Playwright page. Prefers a
// profile-provided selector, then @mozilla/readability run INSIDE the page (so no
// jsdom), then article/main/body. Every page call is guarded → null on failure.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Read @mozilla/readability's Readability.js source and wrap it so an injected
// <script> exposes the class as window.__Readability (the file ends with
// `module.exports = Readability`, captured by the local `module` here).
let _src = null;
function readabilityScript() {
  if (_src == null) {
    const pkgDir = path.dirname(require.resolve("@mozilla/readability"));
    const code = readFileSync(path.join(pkgDir, "Readability.js"), "utf8");
    _src = `window.__Readability=(function(){const module={exports:{}};${code};return module.exports;})();`;
  }
  return _src;
}

export async function readSelector(page, selector) {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return { title: document.title || null, html: el.outerHTML || null };
    }, selector);
  } catch { return null; }
}

export async function runReadability(page) {
  try {
    await page.addScriptTag({ content: readabilityScript() });
    return await page.evaluate(() => {
      try {
        const a = new window.__Readability(document.cloneNode(true)).parse();
        return a && a.content ? { title: a.title || null, html: a.content, byline: a.byline || null, excerpt: a.excerpt || null } : null;
      } catch { return null; }
    });
  } catch { return null; }
}

export async function readFallback(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector("article") || document.querySelector("main") || document.body;
      if (!el) return null;
      return { title: document.title || null, html: el.outerHTML || null };
    });
  } catch { return null; }
}

export async function extractArticle(page, { selector } = {}, deps = {}) {
  const rs = deps.readSelector || readSelector;
  const rr = deps.runReadability || runReadability;
  const rf = deps.readFallback || readFallback;
  if (selector) {
    const s = await rs(page, selector);
    if (s && s.html) return { title: s.title || null, html: s.html, byline: null, excerpt: null };
  }
  const a = await rr(page);
  if (a && a.html) return { title: a.title || null, html: a.html, byline: a.byline || null, excerpt: a.excerpt || null };
  const f = await rf(page);
  if (f && f.html) return { title: f.title || null, html: f.html, byline: null, excerpt: null };
  return null;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/text-extract.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/text/extract.mjs test/text-extract.test.mjs
git commit -m "feat(text): article extraction via in-page Readability + selector/body fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Naming `mdPath`, config `--text`, profile `ContentType.TEXT`

**Files:**
- Modify: `src/naming.mjs`, `src/config.mjs`, `src/profiles/profile.mjs`
- Test: `test/naming.test.mjs` (append), `test/config.test.mjs` (append)

**Interfaces:**
- Produces: `resolveTargets(...).mdPath`; `config.text` (bool) + `config.textName`; `ContentType.TEXT === "text"`.

- [ ] **Step 1: Write the failing tests**

Append to `test/naming.test.mjs`:
```js
test("resolveTargets: batch mdPath is the folder + .md, auto-named from outputName", () => {
  const cfg = { listFile: "l.csv", out: "downloads" };
  const t = resolveTargets(cfg, { url: "https://x/read", name: null }, { outputName: "My Article" });
  assert.equal(t.mdPath, path.join("downloads", "My Article.md"));
});

test("resolveTargets: single-URL mdPath defaults to outDir + .md, or textName", () => {
  assert.equal(resolveTargets({ listFile: null, out: "myout" }, { url: "https://x/read", name: null }).mdPath, "myout.md");
  assert.equal(resolveTargets({ listFile: null, out: "myout", textName: "custom.md" }, { url: "https://x/read", name: null }).mdPath, "custom.md");
});
```
Append to `test/config.test.mjs`:
```js
test("text: --text sets config.text; default false", () => {
  assert.equal(buildConfig({ _: ["https://x/read"] }, {}).text, false);
  assert.equal(buildConfig({ _: ["https://x/read"], text: true }, {}).text, true);
});

test("text: --text-name sets textName", () => {
  assert.equal(buildConfig({ _: ["https://x/read"], "text-name": "out.md" }, {}).textName, "out.md");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/naming.test.mjs test/config.test.mjs`
Expected: new tests FAIL (`mdPath`/`config.text`/`textName` undefined).

- [ ] **Step 3: Add `mdPath` in `src/naming.mjs`**

In the batch-mode return object, add `mdPath`:
```js
    return {
      outDir,
      cbzPath: path.join(base, `${folder}.cbz`),
      pdfPath: path.join(base, `${folder}.pdf`),
      mdPath: path.join(base, `${folder}.md`),
      cacheDir: cacheDirFor(path.join(base, cacheKey))
    };
```
In the single-URL return object, add `mdPath`:
```js
  return {
    outDir,
    cbzPath: config.cbzName || `${outDir}.cbz`,
    pdfPath: config.pdfName || `${outDir}.pdf`,
    mdPath: config.textName || `${outDir}.md`,
    cacheDir: cacheDirFor(outDir)
  };
```

- [ ] **Step 4: Add config in `src/config.mjs`**

Add `"text"` to the `FLAGS` set (so `--text` parses as a boolean). Add to `DEFAULTS`:
```js
  // text content type: scrape the page as HTML→Markdown (.md) instead of images.
  text: false, textName: null,
```
In `buildConfig`, in the CLI section:
```js
  if (args.text) cfg.text = true;
  if (has("text-name")) cfg.textName = args["text-name"];
```

- [ ] **Step 5: Add `ContentType.TEXT` in `src/profiles/profile.mjs`**

```js
export const ContentType = Object.freeze({ IMAGE: "image", TEXT: "text" });
```
Update the profile shape doc comment: `contentType: "image" | "text"`, and note an optional `text: { selector }` block used when `contentType:"text"`.

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/naming.test.mjs test/config.test.mjs`
Expected: PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add src/naming.mjs src/config.mjs src/profiles/profile.mjs test/naming.test.mjs test/config.test.mjs
git commit -m "feat(text): mdPath target, --text/--text-name config, ContentType.TEXT

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `scrapeText` path (`src/text/scrape-text.mjs`)

**Files:**
- Create: `src/text/scrape-text.mjs`
- Test: `test/text-scrape.test.mjs`

**Interfaces:**
- Consumes: `openReader` (`src/navigation.mjs`), `extractArticle` (Task 2), `htmlToMarkdown`+`buildMarkdownDoc` (Task 1), `resolveTargets` (`src/naming.mjs`, now with `mdPath`), `extractMetadata` (`src/metadata.mjs`), `BandwidthMeter` (`src/bandwidth.mjs`), `mapError`/`FailureCode` (`src/strategies/strategy.mjs`).
- Produces: `scrapeText(session, job, config, logger, profile, deps = {}) → result` (the text result shape).

- [ ] **Step 1: Write the failing test**

```js
// test/text-scrape.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrapeText } from "../src/text/scrape-text.mjs";

const noopLogger = { info() {}, warn() {}, step() {}, success() {}, error() {}, verbose() {} };
const fakePage = () => ({ closed: false, async close() { this.closed = true; } });
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/text-scrape.test.mjs`
Expected: FAIL — cannot find module `../src/text/scrape-text.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// src/text/scrape-text.mjs
// The text content path: open the page (past the JS gate), extract the main
// content, convert to Markdown, and write a .md. Returns the batch loop's result
// shape so the circuit breaker / status / reason column work like the image path.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { extractArticle as defaultExtractArticle } from "./extract.mjs";
import { htmlToMarkdown, buildMarkdownDoc } from "./markdown.mjs";
import { extractMetadata as defaultExtractMetadata } from "../metadata.mjs";
import { resolveTargets } from "../naming.mjs";
import { BandwidthMeter } from "../bandwidth.mjs";
import { mapError, FailureCode } from "../strategies/strategy.mjs";

// A failed text result. The code lives ONLY in `attempts` (no top-level `error`
// string) — matching the image failed-result shape — so `failureCodeOf` reports
// this exact code (it prefers a top-level `error` when present) in the reason
// column and to the breaker. The human message is logged, not returned.
const fail = (code) => ({ ok: false, complete: false, saved: 0, contentType: "text", attempts: [{ name: "text", status: "failed", code }] });

export async function scrapeText(session, job, config, logger, profile, deps = {}) {
  const openReader = deps.openReader || defaultOpenReader;
  const extractArticle = deps.extractArticle || defaultExtractArticle;
  const extractMetadata = deps.extractMetadata || defaultExtractMetadata;
  const page = await session.newPage();
  const meter = new BandwidthMeter();
  try {
    meter.attach?.(page);
    await openReader(page, job.url, config, logger);
    const art = await extractArticle(page, { selector: profile?.text?.selector });
    if (!art || !art.html) {
      logger.warn?.(`no article content extracted from ${job.url}`);
      return { ...fail(FailureCode.EMPTY_RESULT), bytes: meter.bytes, requests: meter.count };
    }
    const markdown = htmlToMarkdown(art.html);
    if (!markdown) return { ...fail(FailureCode.EMPTY_RESULT), bytes: meter.bytes, requests: meter.count };

    let title = art.title;
    if (!title) { try { title = (await extractMetadata(page, profile?.metadata || {})).title; } catch { /* best-effort */ } }

    const targets = resolveTargets(config, job, { outputName: title || undefined });
    const doc = buildMarkdownDoc({ title, source: job.url, date: new Date().toISOString().slice(0, 10), byline: art.byline, excerpt: art.excerpt, markdown });
    await mkdir(path.dirname(targets.mdPath), { recursive: true });
    await writeFile(targets.mdPath, doc);
    logger.success?.(`wrote Markdown (${doc.length} bytes) → ${targets.mdPath}`);
    return { ok: true, complete: true, saved: 1, contentType: "text", bytes: meter.bytes, requests: meter.count };
  } catch (e) {
    logger.error?.(`text scrape failed on ${job.url}: ${e?.message || e}`);
    return { ...fail(mapError(e)), bytes: meter.bytes, requests: meter.count };
  } finally {
    await page.close().catch(() => {});
    logger.info?.(`bandwidth: ${meter.summary(config.costPerGb)}`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/text-scrape.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/text/scrape-text.mjs test/text-scrape.test.mjs
git commit -m "feat(text): scrapeText — open, extract, convert, write .md

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Batch-loop integration + docs (`src/pipeline.mjs`)

**Files:**
- Modify: `src/pipeline.mjs`
- Modify: `README.md`, `scraper.config.example.json`
- Test: `test/pipeline.test.mjs` (append)

**Interfaces:**
- Consumes: `scrapeText` (Task 4).
- Produces: content-type branch in `_runJobs`; injectable `BatchRunner._scrapeText`; `scrapeJob`'s text guard removed.

- [ ] **Step 1: Write the failing tests**

Append to `test/pipeline.test.mjs`:
```js
test("_runJobs: routes a text profile to _scrapeText, image profile to _scrapeJob", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0 }, noopLogger);
  const calls = [];
  runner._resolveProfile = (url) => (url.includes("blog") ? { name: "t", contentType: "text" } : { name: "generic", contentType: "image" });
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  runner._scrapeText = async (s, job) => { calls.push(`text:${job.url}`); return { ok: true, complete: true, saved: 1, contentType: "text" }; };
  runner._scrapeJob = async (s, job) => { calls.push(`img:${job.url}`); return { complete: true, saved: 1, total: 1 }; };
  const source = { hasStatus: false, setStatus() {}, setReason() {} };
  await runner._runJobs({ jobs: [{ url: "https://blog/a", status: "" }, { url: "https://img/b", status: "" }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.deepEqual(calls, ["text:https://blog/a", "img:https://img/b"]);
});

test("_runJobs: --text (config.text) forces text mode for every URL", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0, text: true }, noopLogger);
  const calls = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._scrapeText = async (s, job) => { calls.push(job.url); return { ok: true, complete: true, saved: 1, contentType: "text" }; };
  runner._scrapeJob = async () => { throw new Error("should not be called"); };
  const source = { hasStatus: false, setStatus() {}, setReason() {} };
  await runner._runJobs({ jobs: [{ url: "https://any/x", status: "" }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.deepEqual(calls, ["https://any/x"]);
});

test("_runJobs: a text TIMEOUT failure feeds the breaker and writes the reason", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 2, text: true }, noopLogger);
  const reasons = {};
  runner._resolveProfile = () => ({ name: "t", contentType: "text" });
  runner._scrapeText = async () => ({ ok: false, complete: false, saved: 0, contentType: "text", attempts: [{ name: "text", status: "failed", code: "TIMEOUT" }] });
  const source = { hasStatus: true, setStatus() {}, setReason: (j, v) => { reasons[j.url] = v; } };
  const breaker = new CircuitBreaker(2, { base: 0 });
  const scraped = [];
  const origText = runner._scrapeText;
  runner._scrapeText = async (s, job) => { scraped.push(job.url); return origText(s, job); };
  await runner._runJobs({ jobs: [{ url: "https://d/1", status: "", row: 1 }, { url: "https://d/2", status: "", row: 2 }, { url: "https://d/3", status: "", row: 3 }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker });
  assert.deepEqual(scraped, ["https://d/1", "https://d/2"], "3rd row skipped after breaker tripped on text TIMEOUTs");
  assert.equal(reasons["https://d/1"], "TIMEOUT");
});
```
(`CircuitBreaker` is already imported in `test/pipeline.test.mjs`.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pipeline.test.mjs`
Expected: the new tests FAIL (`_runJobs` has no text branch / `_scrapeText`).

- [ ] **Step 3: Import `scrapeText` and add the seam**

In `src/pipeline.mjs`, add the import:
```js
import { scrapeText } from "./text/scrape-text.mjs";
```
In the `BatchRunner` constructor, next to `this._scrapeJob`:
```js
    this._scrapeText = deps.scrapeText || scrapeText;
```

- [ ] **Step 4: Branch on content type in `_runJobs`**

Replace the per-job `try { ... }` body (the block that resolves the profile and calls `_scrapeJob`) with the content-type branch:
```js
      let complete = false;
      let rec;
      try {
        const profile = this._resolveProfile(job.url);
        const contentType = this.config.text ? "text" : (profile.contentType || "image");
        if (contentType === "text") {
          this.logger.verbose(`profile=${profile.name} contentType=text`);
          const r = await this._scrapeText(session, job, this.config, this.logger, profile);
          complete = r.complete;
          rec = { ...job, ...r, ok: complete };
        } else {
          const strategies = this._resolvePipeline(profile, this.config, this.logger);
          this.logger.verbose(`profile=${profile.name} contentType=${profile.contentType} pipeline=[${strategies.map((s) => s.strategy.name).join(", ")}]`);
          if (!strategies.length) {
            this.logger.error(`no mechanisms resolved for ${job.url} (profile ${profile.name}) — marking retry`);
            rec = { ...job, saved: 0, ok: false, error: "no mechanisms resolved" };
          } else {
            const orchestrator = new ScrapingOrchestrator(strategies, this._validate, this.logger);
            const r = await this._scrapeJob(session, job, this.config, processor, packagers, uploader, this.logger, orchestrator, profile);
            complete = r.complete;
            rec = { ...job, ...r, ok: complete };
          }
        }
      } catch (e) {
        this.logger.error(`failed on ${job.url}: ${e?.message || e}`);
        rec = { ...job, saved: 0, ok: false, error: String(e?.message || e) };
      }
      results.push(rec);
      // ... unchanged tail: failureCodeOf(rec), breaker.record, setStatus/setReason ...
```

- [ ] **Step 5: Remove the obsolete text guard in `scrapeJob`**

In `scrapeJob`, delete the line:
```js
    if (contentType !== "image") throw new Error(`unsupported contentType "${contentType}" (text output is a future content type)`);
```
(Keep `const contentType = profile?.contentType || "image";` — it's still used in `scrapeJob`'s return objects. `scrapeJob` now only ever runs for image jobs.)

- [ ] **Step 6: Dry-run line for text**

In `describeDryRun` ([src/pipeline.mjs](../../../src/pipeline.mjs)), when a job is text (`config.text` || the resolved profile is text), print `    will scrape → <mdPath>` instead of the cbz/pdf/loose lines. Minimal: compute `const isText = config.text;` (dry-run doesn't resolve profiles today — forcing on `config.text` is sufficient and correct for the `--text` path; a profile-text dry-run line is optional). Add: if `isText`, `lines.push(\`    md → ${resolveTargets(config, job).mdPath}\`)` and skip the cbz/pdf/drive lines.

- [ ] **Step 7: Docs**

- `scraper.config.example.json`: add `"text": false,` with a comment (scrape as HTML→Markdown; or use `--text`).
- `README.md`: add a short "Text scraping" subsection — `--text` to scrape any article URL to `.md`; or a profile with `contentType:"text"` and optional `text:{selector}`; output is a `.md` with YAML frontmatter; powered by Readability + turndown.

- [ ] **Step 8: Run the pipeline tests + full suite**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — the 3 new tests plus all existing ones (the image branch is unchanged; existing `_runJobs` tests use image profiles → image branch).

Run: `npm test`
Expected: PASS — every file green.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline.mjs README.md scraper.config.example.json test/pipeline.test.mjs
git commit -m "feat(text): route text jobs to scrapeText in the batch loop; docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite:** `npm test` → all green.
- [ ] **Dry-run smoke:** `node scrape.mjs https://example.com/article --text --out out --dry-run` → shows the `.md` target, exits 0.
- [ ] **Live smoke (optional, network):** `node scrape.mjs <a-real-article-url> --text --out out` → `out.md` exists with YAML frontmatter (title/source/date) and a readable Markdown body (`head out.md`).
- [ ] **Image regression:** a normal image run (no `--text`, image profile) behaves exactly as before.
```
head -20 out.md
```
