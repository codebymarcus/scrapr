# Text Content Type (HTML → Markdown) — Design

**Date:** 2026-10-08
**Status:** Draft for review
**Author:** Mark Aquiatin (with Claude)
**Related:** [site profiles](2026-10-08-site-profiles-design.md) ·
[metadata + auto-naming](2026-10-08-metadata-auto-naming-design.md) ·
[circuit breaker](2026-10-08-circuit-breaker-failure-classification-design.md) ·
[roadmap audit](../notes/2026-10-08-roadmap-audit.md)

---

## 1. Purpose & Intent

The scraper only produces images today. The site-profiles work deliberately laid
a content-agnostic seam (`profile.contentType`, content-type-dispatched packaging)
for a second content type: **text**. This feature activates it — scrape a page,
extract its main content, convert it to **Markdown**, and write a `.md` file.

**Goal:** add a `text` content type. A URL is scraped as text when its profile
declares `contentType: "text"` **or** the run passes `--text`. Text runs through a
**parallel path** (`scrapeText`) branched in the batch loop; the image
mechanisms/orchestrator/capture/sharp/cbz machinery is untouched.

### Agreed context (from brainstorming)

| Question | Decision |
|---|---|
| Conversion robustness / deps | **Full:** `@mozilla/readability` (automatic main-content extraction) + `turndown` (HTML→Markdown). |
| Readability in Node | Run **inside the Playwright page** (injected) — we already have a real DOM, so no `jsdom` (keeps it to two deps). |
| Text-mode selection | **Profile `contentType:"text"` OR an ad-hoc `--text` flag/config** (scrape any article URL with no profile). |
| Shape | **Parallel path** in `_runJobs`; one URL → one `.md`; image path unchanged. |

### Non-goals (this phase)

- Article pagination / multi-page articles (one page per URL).
- Drive upload of `.md` (local output only; `--drive` stays image/cbz-only).
- PDF (or any non-Markdown) text output; a separate text-to-pdf is future.
- Changing the image acquisition path, `ImageCapture`, `ImageProcessor`, the
  orchestrator, strategies, validator, or the image packagers.
- Failure→mechanism routing for text (text has a single extraction path).

---

## 2. Architecture

A job's content type is resolved in `BatchRunner._runJobs`:
`const contentType = config.text ? "text" : (profile.contentType || "image");`
— the `--text` flag forces text for the whole run; otherwise the profile decides.

```
_runJobs per job (after the breaker-skip check):
  contentType = config.text ? "text" : (profile.contentType || "image")
  if (contentType === "text")
    rec = await this._scrapeText(session, job, this.config, this.logger, profile)
  else
    strategies = resolvePipeline(...); orchestrator = new ScrapingOrchestrator(...)
    rec = await this._scrapeJob(..., orchestrator, profile)      // today's image path
  // shared: results.push(rec); breaker.record(host, {ok, code:failureCodeOf(rec)});
  //         setStatus/setReason
```

`scrapeText` returns the **same result shape** the batch loop already consumes, so
the circuit breaker, `status`/`reason` column, and `_summary` all work for text
unchanged:
```
{ ok, complete, saved, bytes, requests, contentType: "text",
  attempts: [{ name: "text", status, code }],   // code set on failure
  error?: string }                               // on a thrown/nav failure
```
A text site that rate-limits/times out therefore trips the breaker exactly like an
image site (its code is a `DOMAIN_HEALTH_CODES` value → counts).

---

## 3. New modules — `src/text/`

### `src/text/markdown.mjs` (pure; unit-testable, no browser)

```js
import TurndownService from "turndown";

// Convert an HTML fragment to Markdown. turndown bundles its own Node DOM
// (@mixmark-io/domino), so this needs no jsdom.
export function htmlToMarkdown(html) {
  if (!html) return "";
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  return td.turndown(String(html)).trim();
}

// Compose the final .md document: YAML frontmatter (present fields only) + an
// H1 title + the markdown body. Values are YAML-escaped (quoted).
export function buildMarkdownDoc({ title, source, date, byline, excerpt, markdown } = {}) {
  const fm = [];
  const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

### `src/text/extract.mjs` (page-touching; testable with a fake page)

`extractArticle(page, { selector } = {}) → { title, html, byline, excerpt } | null`:
1. If `selector`, return that element's `outerHTML` (+ `document.title` as title).
2. Else run **@mozilla/readability in the page**: inject the library once via a
   wrapper that captures its `module.exports`
   (`await page.addScriptTag({ content: READABILITY_SRC_WRAPPED })` where the
   wrapper is `window.__Readability=(function(){const module={exports:{}};<src>;return module.exports;})()`,
   `<src>` read from `@mozilla/readability`'s shipped `Readability.js`), then
   `page.evaluate(() => { const a = new window.__Readability(document.cloneNode(true)).parse(); return a && { title:a.title, html:a.content, byline:a.byline, excerpt:a.excerpt }; })`.
3. Fallback when Readability yields nothing: the `outerHTML` of `article`, else
   `main`, else `body`.
4. Return `null` when no usable HTML is found. Every `page.evaluate` is
   try/caught → `null` on failure (never throws).

### `src/text/scrape-text.mjs`

`scrapeText(session, job, config, logger, profile)`:
1. `page = await session.newPage()`; attach `BandwidthMeter`.
2. `await openReader(page, job.url, config, logger)` (passes the JS gate).
3. `const art = await this.extractArticle(page, { selector: profile?.text?.selector })` (injectable for tests).
4. If `!art || !art.html` → `failed(EMPTY_RESULT)`-shaped result.
5. `const markdown = htmlToMarkdown(art.html)`; if empty/too short (< a small
   floor, e.g. 1 char) → `EMPTY_RESULT`.
6. Title precedence: `art.title` → `extractMetadata(page, profile?.metadata||{}).title` → `<title>`.
7. `const doc = buildMarkdownDoc({ title, source: job.url, date: <ISO date>, byline: art.byline, excerpt: art.excerpt, markdown })`.
8. Write to `resolveTargets(config, job, { outputName: title }).mdPath`.
9. Return a success result `{ ok:true, complete:true, saved:1, contentType:"text", bytes, requests }`.
Wrapped so a thrown error → `{ ok:false, complete:false, contentType:"text", error, attempts:[{name:"text",status:"failed",code:mapError(error)}] }`; the page is always closed.

---

## 4. Naming — `src/naming.mjs`

Add an `mdPath` to the returned targets, parallel to `cbzPath`/`pdfPath`:
- Batch mode: `path.join(base, `${folder}.md`)` (folder from `job.name` →
  `outputName`(title) → slug, same precedence; cache key still slug-stable).
- Single-URL mode: `config.textName || `${outDir}.md`` (a `--text-name` override,
  or the out dir + `.md`).

No change to `cacheDir`/`cbzPath`/`pdfPath` behaviour.

---

## 5. Profiles & config

- `profile.mjs`: `ContentType = { IMAGE:"image", TEXT:"text" }`. Profile shape doc
  gains an optional `text: { selector }` block (used only when `contentType:"text"`).
  Image profiles are unchanged.
- `config.mjs`: add `text: false` to `DEFAULTS` (a boolean flag), set by `--text`.
  Optionally `textName: null` (`--text-name`) for single-URL output naming. The
  `--text` flag forces `contentType:"text"` for every job in the run.
- `package.json`: add `turndown` and `@mozilla/readability` to `dependencies`.

A `--text` run with no matching text profile still works: Readability's generic
extraction handles arbitrary article pages.

---

## 6. Batch-loop integration — `src/pipeline.mjs`

- `BatchRunner` gains injectable `_scrapeText` (default: the real `scrapeText`),
  alongside `_scrapeJob`.
- In `_runJobs`, after the breaker-skip check and the pre-job wait, compute
  `contentType` and branch: text → `_scrapeText(session, job, this.config, this.logger, profile)`; image → today's orchestrator + `_scrapeJob`. Both produce
  `rec`; the shared tail (`results.push`, `failureCodeOf`, `breaker.record`,
  `setStatus`/`setReason`) is unchanged.
- The existing `scrapeJob`'s `contentType !== "image"` guard is removed (the
  branch now happens before `scrapeJob`, so `scrapeJob` only ever handles images).
- `describeDryRun`: for a text job (profile text or `config.text`), show
  `will scrape → <folder>.md` instead of the cbz/pdf/loose lines. Minor.

---

## 7. Error handling

- `scrapeText` never throws into the loop: a thrown/nav error becomes a failed
  result with a `mapError` code; Readability/evaluate failures fall back then, if
  still empty, return `EMPTY_RESULT`.
- `htmlToMarkdown`/`buildMarkdownDoc` are pure and tolerate null/empty input.
- Text failures carry a `FailureCode` in `attempts[0].code`, so the breaker and
  the `reason` column classify them exactly like image failures.
- Writing the `.md` creates the parent dir (as the image packagers do).

---

## 8. Testing

`node --test`, fakes, no real browser.

New:
- `test/text-markdown.test.mjs` — `htmlToMarkdown`: headings, lists, links,
  emphasis, code block, table, empty input → `""`. `buildMarkdownDoc`: frontmatter
  includes only present fields, YAML-escapes quotes/backslashes, H1 from title,
  body appended, empty fields omitted.
- `test/text-extract.test.mjs` — `extractArticle` with a fake page: selector path
  returns that element's html+title; readability-result path returns its
  title/html/byline/excerpt; fallback to body when readability is null; `null`
  when nothing usable; a throwing `page.evaluate` → `null` (no throw).
- `test/text-scrape.test.mjs` — `scrapeText` with fakes (inject `extractArticle`):
  success writes a `.md` (assert file contains frontmatter + `# title` + body) and
  returns `{ok:true, contentType:"text", saved:1}`; empty article → `EMPTY_RESULT`
  result; a thrown `openReader` → failed result with mapped code; page always
  closed.
- `test/naming.test.mjs` — `mdPath` present, auto-named from `outputName`, cache
  key unchanged; single-URL `textName`/default.
- `test/pipeline.test.mjs` — `_runJobs` routes `profile.contentType:"text"` and
  `config.text:true` to `_scrapeText` (injected fake) and an image URL to
  `_scrapeJob`; a text result with a `TIMEOUT` code still feeds the breaker and
  writes the reason.

Full existing suite stays green (the image path is unchanged).

Live smoke (manual): `node scrape.mjs <article-url> --text --out out` → a clean
`out.md` with YAML frontmatter (title/source/date) and a readable Markdown body.

---

## 9. Files

```
src/text/markdown.mjs       NEW  htmlToMarkdown (turndown) + buildMarkdownDoc
src/text/extract.mjs        NEW  extractArticle (readability-in-page + selector/fallback)
src/text/scrape-text.mjs    NEW  scrapeText(...)
src/naming.mjs              EDIT mdPath on targets (+ textName single-URL)
src/profiles/profile.mjs    EDIT ContentType.TEXT + text:{selector} doc
src/config.mjs              EDIT `text` flag (--text) + textName (--text-name)
src/pipeline.mjs            EDIT _runJobs content-type branch; drop scrapeJob's text guard; dry-run text line
package.json                EDIT + turndown, @mozilla/readability
README.md / scraper.config.example.json  EDIT  document --text / text profiles
test/text-markdown.test.mjs, test/text-extract.test.mjs, test/text-scrape.test.mjs  NEW
test/naming.test.mjs, test/pipeline.test.mjs  EDIT
```

---

## 10. Acceptance criteria

- A URL with a `contentType:"text"` profile, or any URL under `--text`, is scraped
  as text: main content extracted (Readability, or a profile `text.selector`),
  converted to Markdown, and written as a `.md` with YAML frontmatter
  (title/source/date, plus byline/excerpt when available) and an H1 title.
- `--text` works on an arbitrary article URL with no profile.
- Text results flow through the circuit breaker, `status`/`reason` column, and
  end-of-run summary identically to image results (a text domain-health failure
  trips the breaker; the reason column shows the code).
- The image path is unchanged when not in text mode; the full existing test suite
  stays green; new text/naming/pipeline tests pass.
- Only `turndown` + `@mozilla/readability` are added; Readability runs in-page (no
  `jsdom`).
- No article pagination, no Drive upload of `.md`, no text-to-PDF.
