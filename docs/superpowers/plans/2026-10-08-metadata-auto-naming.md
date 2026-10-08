# Metadata + Auto-Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract per-chapter metadata while scraping, write a ComicInfo.xml into the CBZ and set the PDF title, and auto-name outputs from the title when no explicit name is given — all best-effort, never failing a job.

**Architecture:** A new `src/metadata.mjs` provides `extractMetadata(page, patterns)` and `buildComicInfoXml(fields)`. Strategies extract metadata from the open page (via the profile's `metadata` regexes, falling back to og:title/`<title>`) and return it in their success result; the orchestrator passes the winning strategy's metadata through; `scrapeJob` feeds it to packaging (ComicInfo.xml / PDF title) and to output auto-naming. The cache/resume key stays slug-stable.

**Tech Stack:** Node.js ESM (`.mjs`), Playwright, `archiver`, `pdf-lib`, `node --test` + `node:assert/strict`.

**Spec:** [docs/superpowers/specs/2026-10-08-metadata-auto-naming-design.md](../specs/2026-10-08-metadata-auto-naming-design.md)

## Global Constraints

- ES modules only (`.mjs`), no new runtime dependencies.
- Metadata is **best-effort**: extraction or metadata-packaging failures never fail a job, never throw out of a strategy, and never alter the download path.
- Lean field set only: **series/title, page count (the scraped `total`), source URL**. No JSON-LD/embedded-JSON, no extra ComicInfo fields.
- ComicInfo `Series` and `Title` are both set from the single extracted title (lean; splitting is future work).
- Output-name precedence: explicit `job.name` (sheet) > extracted metadata title > URL slug. Single-URL `--out`/`--cbz-name`/`--pdf-name` always win. The **cache dir is never derived from metadata** (resume stays stable).
- Tests use `node:test` + `node:assert/strict`, fakes, no real browser — mirror existing tests.
- Commit after each task; message ends with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Review Focus

- **`page.evaluate` throws during extraction** (fake page without `evaluate`, or a real failure) → `extractMetadata` returns `{title:null,count:null}`, never throws (Task 1).
- **Title/series with XML metacharacters** (`& < > " '`) → `buildComicInfoXml` escapes them so the CBZ's ComicInfo.xml stays well-formed (Task 1).
- **No extracted title** → `scrapeJob` still supplies `pageCount` (scraped total) and `web` (source URL), so a ComicInfo.xml (PageCount + Web, no Series/Title) is written for every successful CBZ; the PDF title is left default; no crash (Task 4). `buildComicInfoXml` itself still returns `null` for a fully-empty object, and `CbzPackager` then writes no ComicInfo.xml (packager-level unit contract).
- **Auto-naming must not disturb resume** → `cacheDir` is identical whether or not an `outputName` override is given (Task 5).
- **Metadata extraction failing inside a strategy** → the otherwise-successful acquisition still returns success with `metadata` null-ish, not a failed job (Task 2).

---

## Task 1: Metadata module (`src/metadata.mjs`)

**Files:**
- Create: `src/metadata.mjs`
- Test: `test/metadata.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractMetadata(page, patterns = {}) → Promise<{ title: string|null, count: number|null }>`
  - `buildComicInfoXml({ series?, title?, pageCount?, web? }) → string|null`

- [ ] **Step 1: Write the failing test**

```js
// test/metadata.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMetadata, buildComicInfoXml } from "../src/metadata.mjs";

// A fake page whose evaluate returns a scripted DOM snapshot.
const pageWith = (dom) => ({ evaluate: async () => dom });

test("extractMetadata: pattern hit pulls title + count from body text", async () => {
  const page = pageWith({ bodyText: "From: Ultimate Hulk Annual\nPage 1 / 29", ogTitle: null, docTitle: "ignored" });
  const md = await extractMetadata(page, { title: /From:\s*(.+)/, count: /Page\s+\d+\s*\/\s*(\d+)/i });
  assert.equal(md.title, "Ultimate Hulk Annual");
  assert.equal(md.count, 29);
});

test("extractMetadata: falls back to og:title then <title> when no title pattern/match", async () => {
  const og = pageWith({ bodyText: "no match", ogTitle: "OG Title", docTitle: "Doc Title" });
  assert.equal((await extractMetadata(og, {})).title, "OG Title");
  const doc = pageWith({ bodyText: "no match", ogTitle: null, docTitle: "Doc Title" });
  assert.equal((await extractMetadata(doc, {})).title, "Doc Title");
});

test("extractMetadata: no title anywhere and non-numeric count → nulls", async () => {
  const page = pageWith({ bodyText: "Page X / many", ogTitle: null, docTitle: "" });
  const md = await extractMetadata(page, { count: /Page\s+\S+\s*\/\s*(\w+)/ });
  assert.equal(md.title, null);
  assert.equal(md.count, null);
});

test("extractMetadata: a throwing evaluate is swallowed → nulls, no throw", async () => {
  const page = { evaluate: async () => { throw new Error("detached"); } };
  assert.deepEqual(await extractMetadata(page, { title: /x/ }), { title: null, count: null });
});

test("buildComicInfoXml: includes present fields, omits empties, escapes XML", () => {
  const xml = buildComicInfoXml({ series: "A & B <C>", title: "A & B <C>", pageCount: 29, web: "https://x/1" });
  assert.match(xml, /<Series>A &amp; B &lt;C&gt;<\/Series>/);
  assert.match(xml, /<PageCount>29<\/PageCount>/);
  assert.match(xml, /<Web>https:\/\/x\/1<\/Web>/);
  assert.doesNotMatch(xml, /undefined/);
});

test("buildComicInfoXml: returns null when nothing usable, drops zero/empty", () => {
  assert.equal(buildComicInfoXml({}), null);
  assert.equal(buildComicInfoXml({ title: "", pageCount: 0, web: null }), null);
  assert.doesNotMatch(buildComicInfoXml({ title: "T" }), /<PageCount>/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/metadata.test.mjs`
Expected: FAIL — cannot find module `../src/metadata.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// src/metadata.mjs
// Best-effort page metadata extraction and ComicInfo.xml building. Everything
// here is non-fatal: a failure yields nulls / no file, never an exception that
// could fail an otherwise-successful scrape.

// Extract { title, count } from the open reader page. `patterns` is a profile's
// `metadata` object of RegExps applied (in Node) to the page's visible text;
// title falls back to og:title then the document <title>.
export async function extractMetadata(page, patterns = {}) {
  let dom;
  try {
    dom = await page.evaluate(() => ({
      bodyText: document.body?.innerText || "",
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") || null,
      docTitle: document.title || null
    }));
  } catch {
    return { title: null, count: null };
  }
  const text = dom?.bodyText || "";
  let title = null;
  if (patterns.title) title = (text.match(patterns.title)?.[1] || "").trim() || null;
  title = title || (dom?.ogTitle || "").trim() || (dom?.docTitle || "").trim() || null;
  let count = null;
  if (patterns.count) {
    const m = text.match(patterns.count);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n)) count = n; }
  }
  return { title, count };
}

// Build a minimal ComicRack ComicInfo.xml. Returns null when no field is usable
// (so no file is written). All values are XML-escaped.
export function buildComicInfoXml({ series, title, pageCount, web } = {}) {
  const fields = [
    ["Series", series],
    ["Title", title],
    ["PageCount", Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null],
    ["Web", web]
  ].filter(([, v]) => v != null && v !== "");
  if (!fields.length) return null;
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const body = fields.map(([k, v]) => `  <${k}>${esc(v)}</${k}>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n${body}\n</ComicInfo>\n`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/metadata.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/metadata.mjs test/metadata.test.mjs
git commit -m "feat(metadata): extractMetadata + buildComicInfoXml (best-effort)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Strategies extract and return metadata

**Files:**
- Modify: `src/strategies/browser-keyboard.mjs`, `src/strategies/chapter-aware.mjs`
- Test: `test/browser-keyboard.test.mjs`, `test/chapter-aware.test.mjs`

**Interfaces:**
- Consumes: `extractMetadata` from `src/metadata.mjs` (Task 1).
- Produces:
  - `new BrowserKeyboardStrategy({ openReader?, ReaderDriver?, params?, extractMetadata? })`
  - `new ChapterAwareStrategy({ openReader?, params?, extractMetadata? })`
  - Both `execute(ctx)` now read `ctx.profile?.metadata` and return success as `ok({ downloaded, total, metadata })` where `metadata` is `{title, count}` (or `{title:null,count:null}` on any failure).

- [ ] **Step 1: Write the failing tests**

Append to `test/browser-keyboard.test.mjs`:
```js
test("current: returns extracted metadata in the success result", async () => {
  const page = fakePage();
  const capture = { attach: async () => {}, size: 3, list: () => [] };
  const strat = new BrowserKeyboardStrategy({
    openReader: async () => {},
    ReaderDriver: class { async run() { return { total: 3 }; } },
    extractMetadata: async (_page, patterns) => ({ title: patterns?.title ? "Hulk" : null, count: 3 })
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: "u" }, config: {},
    capture, meter: { attach() {} }, logger: noopLogger, profile: { metadata: { title: /x/ } }
  });
  assert.equal(res.status, "success");
  assert.equal(res.data.downloaded, 3);
  assert.equal(res.data.total, 3);
  assert.deepEqual(res.data.metadata, { title: "Hulk", count: 3 });
});
```
Append to `test/browser-keyboard.test.mjs` (Review Focus #5 — a metadata failure must not fail the job):
```js
test("current: a throwing extractMetadata still succeeds (metadata nulled)", async () => {
  const page = fakePage();
  const capture = { attach: async () => {}, size: 2, list: () => [] };
  const strat = new BrowserKeyboardStrategy({
    openReader: async () => {},
    ReaderDriver: class { async run() { return { total: 2 }; } },
    extractMetadata: async () => { throw new Error("boom"); }
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: "u" }, config: {},
    capture, meter: { attach() {} }, logger: noopLogger, profile: { metadata: {} }
  });
  assert.equal(res.status, "success");
  assert.deepEqual(res.data.metadata, { title: null, count: null });
});
```
Append to `test/chapter-aware.test.mjs`:
```js
test("chapter-aware: returns extracted metadata in the success result", async () => {
  const capture = fakeCapture();
  const visited = [];
  const s = strategyFor(capture, { total: 2, visited });
  s.extractMetadata = async () => ({ title: "Hulk", count: 2 });
  const res = await s.execute({ ...ctxFor(capture, fakePage()), profile: { metadata: {} } });
  assert.equal(res.status, "success");
  assert.deepEqual(res.data.metadata, { title: "Hulk", count: 2 });
});
```
Update the two EXISTING assertions that `deepEqual(res.data, {...})` so they no longer require an exact `res.data` shape (metadata is now also present):
- `test/browser-keyboard.test.mjs`: change `assert.deepEqual(res.data, { downloaded: 40, total: 40 });` to
  ```js
  assert.equal(res.data.downloaded, 40);
  assert.equal(res.data.total, 40);
  ```
- `test/chapter-aware.test.mjs`: change `assert.deepEqual(res.data, { downloaded: 5, total: 5 });` to
  ```js
  assert.equal(res.data.downloaded, 5);
  assert.equal(res.data.total, 5);
  ```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/browser-keyboard.test.mjs test/chapter-aware.test.mjs`
Expected: the two new tests FAIL (`res.data.metadata` is `undefined`).

- [ ] **Step 3: Update `browser-keyboard.mjs`**

Add the import and an injectable `extractMetadata`, read `profile` from ctx, and return metadata:
```js
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { ReaderDriver as DefaultReaderDriver } from "../reader.mjs";
import { ok, failed, mapError } from "./strategy.mjs";
import { extractMetadata as defaultExtractMetadata } from "../metadata.mjs";

export class BrowserKeyboardStrategy {
  constructor({ openReader = defaultOpenReader, ReaderDriver = DefaultReaderDriver, params = {}, extractMetadata = defaultExtractMetadata } = {}) {
    this.name = "current";
    this.defaultMaxAttempts = 2;
    this._openReader = openReader;
    this._ReaderDriver = ReaderDriver;
    this.params = params;
    this.extractMetadata = extractMetadata;
  }

  async execute({ session, job, config, capture, meter, logger, profile }) {
    const page = await session.newPage();
    const cfg = { ...config, ...this.params };
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, cfg, logger);
      const { total } = await new this._ReaderDriver(page, capture, cfg, logger).run();
      const metadata = await this.extractMetadata(page, profile?.metadata || {}).catch(() => ({ title: null, count: null }));
      return ok({ downloaded: capture.size, total, metadata });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Update `chapter-aware.mjs`**

Add the import + injectable `extractMetadata`, read `profile` from ctx, extract before the success return:
```js
import { extractMetadata as defaultExtractMetadata } from "../metadata.mjs";
```
Constructor:
```js
  constructor({ openReader = defaultOpenReader, params = {}, extractMetadata = defaultExtractMetadata } = {}) {
    this.name = "chapter-aware";
    this.defaultMaxAttempts = 1;
    this._openReader = openReader;
    this.params = params;
    this.extractMetadata = extractMetadata;
  }
```
In `execute`, add `profile` to the destructure and extract metadata before returning ok:
```js
  async execute({ session, job, config, capture, meter, logger, profile }) {
    const page = await session.newPage();
    const cfg = { ...config, ...this.params };
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, cfg, logger);
      const total = await this._collect(page, capture, cfg, logger);
      const downloaded = capture.size;
      if (!(downloaded > 0)) return failed(FailureCode.EMPTY_RESULT, "no pages captured");
      const metadata = await this.extractMetadata(page, profile?.metadata || {}).catch(() => ({ title: null, count: null }));
      return ok({ downloaded, total, metadata });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/browser-keyboard.test.mjs test/chapter-aware.test.mjs`
Expected: PASS (all, including the two new).

- [ ] **Step 6: Commit**

```bash
git add src/strategies/browser-keyboard.mjs src/strategies/chapter-aware.mjs test/browser-keyboard.test.mjs test/chapter-aware.test.mjs
git commit -m "feat(strategies): extract page metadata into the success result

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Orchestrator passes the winning metadata through

**Files:**
- Modify: `src/orchestrator.mjs`
- Test: `test/orchestrator.test.mjs` (append)

**Interfaces:**
- Consumes: a strategy's `ok({..., metadata})` (Task 2).
- Produces: `run(ctx)` success result gains `metadata` (the winning strategy's `res.data.metadata`, or `null`).

- [ ] **Step 1: Write the failing test**

Append to `test/orchestrator.test.mjs`:
```js
test("success result carries the winning strategy's metadata", async () => {
  const A = fakeStrategy("A", [ok({ downloaded: 10, total: 10, metadata: { title: "Hulk", count: 10 } })]);
  const r = await run([{ strategy: A, maxAttempts: 1 }]);
  assert.equal(r.status, "success");
  assert.deepEqual(r.metadata, { title: "Hulk", count: 10 });
});

test("success result metadata is null when the strategy provided none", async () => {
  const A = fakeStrategy("A", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 1 }]);
  assert.equal(r.status, "success");
  assert.equal(r.metadata, null);
});
```
(`fakeStrategy`, `ok`, and `run` already exist in `test/orchestrator.test.mjs`.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/orchestrator.test.mjs`
Expected: the two new tests FAIL (`r.metadata` is `undefined`).

- [ ] **Step 3: Implement**

In `src/orchestrator.mjs`, add `metadata` to the per-attempt declaration and set it in the non-failed branch, then include it in the success return. Change line 37:
```js
        let status, code, downloaded, total, missing = [], acceptedPartial, metadata = null;
```
In the `else` (non-failed) branch, after `acceptedPartial = v.acceptedPartial;`, add:
```js
          metadata = res.data?.metadata ?? null;
```
And the success return (line 65) becomes:
```js
          return { status: "success", usedStrategy: strategy.name, downloaded, total, attempts, acceptedPartial, metadata };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/orchestrator.test.mjs`
Expected: PASS (all, including the two new).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.mjs test/orchestrator.test.mjs
git commit -m "feat(orchestrator): surface the winning strategy's metadata on success

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Packagers write ComicInfo.xml and the PDF title

**Files:**
- Modify: `src/packagers.mjs`
- Test: `test/packagers.test.mjs` (new)

**Interfaces:**
- Consumes: `buildComicInfoXml` from `src/metadata.mjs` (Task 1).
- Produces: `packager.write(outputs, targets, metadata)` — third arg optional. `CbzPackager` appends `ComicInfo.xml` when metadata yields one; `PdfPackager` sets the document title; `LoosePackager` ignores metadata.

- [ ] **Step 1: Write the failing test**

```js
// test/packagers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { CbzPackager, PdfPackager } from "../src/packagers.mjs";
import { PDFDocument } from "pdf-lib";

const noopLogger = { success() {}, warn() {}, step() {}, info() {} };
async function tmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "scaper-pkg-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
// A real 1x1 JPEG (sharp is already a dependency) so pdf-lib.embedJpg accepts it.
const JPG = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();

// CbzPackager writes the ZIP STORED (level 0 — images are already compressed), so
// an uncompressed ComicInfo.xml entry appears verbatim in the raw .cbz bytes.
// That lets us assert on the file bytes without adding a zip-reader dependency.

test("CbzPackager: embeds an escaped ComicInfo.xml when metadata is present", async () => {
  await tmp(async (dir) => {
    const dest = path.join(dir, "out.cbz");
    await new CbzPackager(noopLogger).write(
      [{ name: "001.jpg", buffer: JPG }], { cbzPath: dest },
      { series: "Hulk & Co <x>", title: "Hulk", pageCount: 1, web: "https://x/1" }
    );
    const s = (await readFile(dest)).toString("latin1");
    assert.ok(s.includes("ComicInfo.xml"), "entry name present in the archive");
    assert.ok(s.includes("<Series>Hulk &amp; Co &lt;x&gt;</Series>"), "escaped series present");
    assert.ok(s.includes("<PageCount>1</PageCount>"), "page count present");
  });
});

test("CbzPackager: writes NO ComicInfo.xml when metadata is empty", async () => {
  await tmp(async (dir) => {
    const dest = path.join(dir, "out.cbz");
    await new CbzPackager(noopLogger).write([{ name: "001.jpg", buffer: JPG }], { cbzPath: dest }, {});
    const s = (await readFile(dest)).toString("latin1");
    assert.ok(!s.includes("ComicInfo.xml"), "no ComicInfo.xml entry");
  });
});

test("PdfPackager: sets the document title from metadata", async () => {
  await tmp(async (dir) => {
    const dest = path.join(dir, "out.pdf");
    await new PdfPackager(noopLogger).write([{ name: "001.jpg", buffer: JPG }], { pdfPath: dest }, { title: "Hulk Annual" });
    const pdf = await PDFDocument.load(await readFile(dest));
    assert.equal(pdf.getTitle(), "Hulk Annual");
  });
});
```
(Top-level `await` is fine in an ESM test module. The raw-bytes assertion works only because `CbzPackager` uses `zlib: { level: 0 }` — stored, not deflated.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/packagers.test.mjs`
Expected: FAIL — `ComicInfo.xml` is not written / `getTitle()` is undefined (and/or the chosen unzip helper shows no entry).

- [ ] **Step 3: Implement in `src/packagers.mjs`**

Add the import at the top:
```js
import { buildComicInfoXml } from "./metadata.mjs";
```
`CbzPackager.write` gains `metadata` and appends ComicInfo.xml:
```js
  async write(outputs, targets, metadata) {
    let dest = targets.cbzPath;
    if (!dest.toLowerCase().endsWith(".cbz")) dest += ".cbz";
    await mkdir(path.dirname(dest), { recursive: true });
    const comicInfo = buildComicInfoXml(metadata || {});
    const bytes = await new Promise((resolve, reject) => {
      const out = createWriteStream(dest);
      const archive = archiver("zip", { zlib: { level: 0 } });
      out.on("close", () => resolve(archive.pointer()));
      out.on("error", reject);
      archive.on("error", reject);
      archive.pipe(out);
      for (const f of outputs) archive.append(f.buffer, { name: f.name });
      if (comicInfo) archive.append(Buffer.from(comicInfo, "utf8"), { name: "ComicInfo.xml" });
      archive.finalize();
    });
    this.logger.success(`wrote ${outputs.length}-page CBZ (${mb(bytes)} MB)${comicInfo ? " + ComicInfo.xml" : ""} → ${dest}`);
  }
```
`PdfPackager.write` gains `metadata` and sets the title:
```js
  async write(outputs, targets, metadata) {
    let dest = targets.pdfPath;
    if (!dest.toLowerCase().endsWith(".pdf")) dest += ".pdf";
    await mkdir(path.dirname(dest), { recursive: true });
    const pdf = await PDFDocument.create();
    if (metadata?.title) pdf.setTitle(String(metadata.title));
    for (const f of outputs) {
      const isPng = /\.png$/i.test(f.name);
      const img = isPng ? await pdf.embedPng(f.buffer) : await pdf.embedJpg(f.buffer);
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const bytes = await pdf.save();
    await writeFile(dest, bytes);
    this.logger.success(`wrote ${outputs.length}-page PDF (${mb(bytes.length)} MB) → ${dest}`);
  }
```
`LoosePackager.write(outputs, targets, _metadata)` — leave its body unchanged (it simply ignores the third arg).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/packagers.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/packagers.mjs test/packagers.test.mjs
git commit -m "feat(packagers): write ComicInfo.xml into the CBZ and set the PDF title

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Naming — display-name override, stable cache key

**Files:**
- Modify: `src/naming.mjs`
- Test: `test/naming.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveTargets(config, job, { outputName } = {})`. `cacheDir` stays derived from `job.name || slugFromUrl` (unchanged). In batch mode the output folder is `job.name` if set, else a sanitized `outputName`, else the URL slug. Single-URL mode ignores `outputName`.

- [ ] **Step 1: Write the failing tests**

Append to `test/naming.test.mjs`:
```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/naming.test.mjs`
Expected: the new tests FAIL (`resolveTargets` ignores the third arg; `outDir` uses the slug, not `outputName`).

- [ ] **Step 3: Implement in `src/naming.mjs`**

Change `resolveTargets` to accept and apply `outputName` for the batch output folder only, keeping `cacheDir` on the stable key:
```js
export function resolveTargets(config, job, { outputName } = {}) {
  if (config.listFile) {
    const base = config.out || "downloads";
    // Stable key for the cache dir (never from metadata) so resume is unaffected.
    const cacheKey = job.name ? sanitizeName(job.name) : slugFromUrl(job.url);
    // Display name for the output files: explicit name > metadata title > slug.
    const folder = job.name
      ? sanitizeName(job.name)
      : (outputName ? sanitizeName(outputName) : slugFromUrl(job.url));
    const outDir = path.join(base, folder);
    return {
      outDir,
      cbzPath: path.join(base, `${folder}.cbz`),
      pdfPath: path.join(base, `${folder}.pdf`),
      cacheDir: cacheDirFor(path.join(base, cacheKey))
    };
  }
  const outDir = config.out || path.join("downloads", slugFromUrl(job.url));
  return {
    outDir,
    cbzPath: config.cbzName || `${outDir}.cbz`,
    pdfPath: config.pdfName || `${outDir}.pdf`,
    cacheDir: cacheDirFor(outDir)
  };
}
```
Note: `cacheDir` is built from `cacheKey` via `cacheDirFor(path.join(base, cacheKey))`, which equals the previous behaviour when `outputName` is absent (then `folder === cacheKey`). Confirm the existing `resolveTargets` tests (batch with/without name) still pass unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/naming.test.mjs`
Expected: PASS (all — the 4 new and the pre-existing batch/single tests).

- [ ] **Step 5: Commit**

```bash
git add src/naming.mjs test/naming.test.mjs
git commit -m "feat(naming): optional display-name override with a stable cache key

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Pipeline integration (thread profile, name + package from metadata)

**Files:**
- Modify: `src/pipeline.mjs`
- Test: `test/pipeline.test.mjs` (append)

**Interfaces:**
- Consumes: orchestrator `metadata` (Task 3), `resolveTargets({outputName})` (Task 5), packager `write(…, metadata)` (Task 4).
- Produces: `scrapeJob` passes `profile` into the orchestrator ctx, resolves final output targets from `r.metadata.title`, and passes a normalized `metadata` object to each packager; result unchanged otherwise.

- [ ] **Step 1: Write the failing tests**

Append to `test/pipeline.test.mjs`:
```js
test("scrapeJob: passes profile into the orchestrator ctx", async () => {
  let ctxProfile;
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const orchestrator = { run: async (ctx) => { ctxProfile = ctx.profile; return { status: "success", usedStrategy: "current", downloaded: 1, total: 1, attempts: [], metadata: null }; } };
  const profile = { name: "batcave", contentType: "image", metadata: { title: /x/ } };
  await scrapeJob({}, { url: "https://x/read" }, config, processor, [{ write: async () => {} }], null, noopLogger, orchestrator, profile);
  assert.equal(ctxProfile, profile);
});

test("scrapeJob: passes normalized metadata to the packager and auto-names from the title", async () => {
  let seenMeta, seenTargets;
  const config = { listFile: "l.csv", cache: false, cleanup: false, drive: false, out: "downloads", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const packagers = [{ write: async (_o, targets, metadata) => { seenTargets = targets; seenMeta = metadata; } }];
  const orchestrator = { run: async () => ({ status: "success", usedStrategy: "current", downloaded: 29, total: 29, attempts: [], metadata: { title: "Ultimate Hulk Annual", count: 29 } }) };
  const r = await scrapeJob({}, { url: "https://x/read", name: null }, config, processor, packagers, null, noopLogger, orchestrator, { name: "batcave", contentType: "image", metadata: {} });
  assert.equal(r.complete, true);
  assert.equal(seenMeta.series, "Ultimate Hulk Annual");
  assert.equal(seenMeta.title, "Ultimate Hulk Annual");
  assert.equal(seenMeta.pageCount, 29);
  assert.equal(seenMeta.web, "https://x/read");
  const path = (await import("node:path")).default;
  assert.equal(seenTargets.cbzPath, path.join("downloads", "Ultimate Hulk Annual.cbz"));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pipeline.test.mjs`
Expected: the two new tests FAIL (profile not put on ctx; packager called with 2 args and slug-named targets).

- [ ] **Step 3: Thread `profile` into the orchestrator ctx**

In `scrapeJob` (around the `orchestrator.run({...})` call), add `profile`:
```js
    const r = await orchestrator.run({ session, job, config, capture, meter, seeded, profile });
```

- [ ] **Step 4: Build normalized metadata + final output targets, pass metadata to packagers**

Replace the success-path packaging section. After the `if (r.status !== "success") { … return … }` block and the content-type guard, add:
```js
    // Normalize metadata for packaging + naming (best-effort; fields may be null).
    const md = r.metadata || {};
    const metadata = { series: md.title ?? null, title: md.title ?? null, pageCount: r.total ?? null, web: job.url };
    if (Number.isFinite(md.count) && Number.isFinite(r.total) && md.count !== r.total) {
      logger.verbose?.(`metadata page count ${md.count} differs from scraped total ${r.total}`);
    }
    // Final output targets: auto-name from the title when the job has no explicit name.
    const finalTargets = resolveTargets(config, job, { outputName: md.title || undefined });
```
Change the packaging loop and cleanup to use `finalTargets` + `metadata`:
```js
    logger.step("→ converting & packaging");
    const outputs = await processor.process(capture.list());
    for (const packager of packagers) await packager.write(outputs, finalTargets, metadata);
```
Update the Drive upload section to reference `finalTargets.cbzPath`/`finalTargets.pdfPath` (replace `targets.cbzPath`/`targets.pdfPath` in the upload + cleanup within the success path), and change `removeJobArtifacts(targets, logger)` to `removeJobArtifacts(finalTargets, logger)`. Leave the up-front `targets` (cache setup, `--clear-cache`, seeding) and `cache.clear()` exactly as they are — `finalTargets.cacheDir === targets.cacheDir`.

> The up-front `const targets = resolveTargets(config, job)` stays (cache dir + clear-cache use it). `finalTargets` differs only in output folder/file names, and only in batch mode with no `job.name` and a metadata title.

- [ ] **Step 5: Run the pipeline tests + full suite**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — the two new tests plus all existing scrapeJob/_runJobs tests (existing scrapeJob tests pass a `profile` already; packagers receiving a third `metadata` arg is harmless to their fakes).

Run: `npm test`
Expected: PASS — every file green.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.mjs test/pipeline.test.mjs
git commit -m "feat(pipeline): auto-name from metadata and feed it to packaging

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite:** `npm test` → all green.
- [ ] **Dry-run smoke:** `node scrape.mjs https://batcave.biz/event/ultimate-marvel/395 --dry-run` → prints the preview, exits 0.
- [ ] **Live smoke (optional, network):** scrape batcave `/395` with a throwaway config (no drive/cleanup, temp out, keepLoose+cbz) → the CBZ contains a `ComicInfo.xml` with `<Series>…Hulk…</Series>` and `<PageCount>29</PageCount>`; with a sheet row that has no name, the output is auto-named from the title.
```
Verify the ComicInfo.xml, e.g.:
  unzip -p <out>.cbz ComicInfo.xml
```
