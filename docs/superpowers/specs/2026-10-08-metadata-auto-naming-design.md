# Metadata + Auto-Naming — Design

**Date:** 2026-10-08
**Status:** Draft for review
**Author:** Mark Aquiatin (with Claude)
**Related:** [site profiles](2026-10-08-site-profiles-design.md) ·
[roadmap audit](../notes/2026-10-08-roadmap-audit.md)

---

## 1. Purpose & Intent

Scraped chapters currently package with no metadata, and output folders/archives
are named from the sheet's name column or a URL slug. This feature extracts
per-chapter metadata **while scraping**, writes a **ComicInfo.xml** into the CBZ
so comic libraries (Komga/Kavita) show proper series/title/page-count, sets the
**PDF document title**, and **auto-names** outputs from the real title when the
sheet/URL doesn't provide a good name. It activates the `metadata` seam already
present on profiles ([src/profiles/batcave.mjs](../../../src/profiles/batcave.mjs)
has `title`/`count` patterns, currently unused).

This is **sub-project #2** of the three-part enhancement set; it builds on the
site-profiles layer (sub-project #1, merged).

### Scope (agreed: "Lean")

| Decision | Value |
|---|---|
| Field set | **series/title, page count, source URL** — nothing more |
| Metadata source | the profile's declared `metadata` regex patterns, falling back to `og:title` → `<title>` |
| ComicInfo.xml | written into the **CBZ** (minimal ComicRack schema) |
| PDF | set the document **title** (via pdf-lib) |
| Auto-naming | output folder/archive name from the title when no explicit name is given |
| Precedence (output name) | explicit `job.name` (sheet) > extracted metadata title > URL slug |
| Cache/resume key | **slug-stable** (`job.name || slugFromUrl`) — never derived from metadata |

### Non-goals (this phase)

- JSON-LD / embedded-JSON extraction and richer ComicInfo fields (summary,
  writer, publisher, dates, volume, number) — a future extension.
- Renaming/moving existing already-downloaded outputs from prior runs.
- Changing single-URL explicit outputs: `--out`, `--cbz-name`, `--pdf-name` are
  always respected.
- Any change to failure-aware selection (sub-project #3).

---

## 2. Architecture

Metadata is extracted from the reader page **during acquisition** (the only time
a page is open — strategies open and close their own pages), flows up through the
orchestrator's winning result, and is then used for packaging and naming. A
separate metadata pass is rejected: it would need an extra navigation (cost +
re-triggering the batcave JS gate).

```
scrapeJob (has `profile` from the site-profiles work)
   → orchestrator.run(ctx incl. profile)
       → strategy.execute: acquire pages, then
         extractMetadata(page, profile.metadata) → ok({ downloaded, total, metadata })
       → orchestrator returns { …, metadata } (winning strategy's)
   → scrapeJob:
       metadata → final output-name resolution (naming)
       metadata → packagers (ComicInfo.xml in CBZ, PDF title)
```

Metadata is **best-effort**: any extraction failure yields `{title:null,count:null}`
and never fails a job; ComicInfo.xml is omitted when there is no usable metadata;
auto-naming falls back to the slug. The critical download path is unchanged.

---

## 3. Metadata extractor — `src/metadata.mjs` (new)

```js
// Extract best-effort metadata from the open reader page. `patterns` is the
// profile's `metadata` object (regexes applied in Node to the page's text);
// falls back to OpenGraph title then the document <title>.
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
  let title = null;
  if (patterns.title) title = (dom.bodyText.match(patterns.title)?.[1] || "").trim() || null;
  title = title || (dom.ogTitle || "").trim() || (dom.docTitle || "").trim() || null;
  let count = null;
  if (patterns.count) {
    const m = dom.bodyText.match(patterns.count);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n)) count = n; }
  }
  return { title, count };
}

// Build a minimal ComicRack ComicInfo.xml string. Returns null when there is no
// usable metadata (so no file is written). XML-escapes all values.
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

- `patterns` are real `RegExp` objects (profiles are JS modules), applied in Node
  on the returned `bodyText` — not serialized into the page.
- Field set is deliberately small. `series` and `title` are both set from the
  extracted title in scrapeJob (ComicInfo `Series` is what most readers group by);
  a future phase can split them.

---

## 4. Threading metadata through acquisition

- **Context:** `scrapeJob` passes `profile` into `orchestrator.run(ctx)` — i.e.
  `orchestrator.run({ session, job, config, capture, meter, seeded, profile })`.
  The orchestrator already spreads `ctx` (plus its logger) into
  `strategy.execute`, so strategies receive `profile`.
- **Strategies:** `BrowserKeyboardStrategy` and `ChapterAwareStrategy`, just
  before returning success, call
  `const metadata = await extractMetadata(page, ctx.profile?.metadata || {})`
  and return `ok({ downloaded, total, metadata })`. (Failure/early returns are
  unchanged.) Both strategies import `extractMetadata` — one added line each
  plus the import.
- **Orchestrator:** on the success return, include the winning result's metadata:
  `return { status:"success", usedStrategy, downloaded, total, metadata: res.data?.metadata ?? null, attempts }`.
  No other orchestrator behaviour changes; the fallback/retry logic is untouched.

---

## 5. Packaging — `src/packagers.mjs`

- Packager interface becomes `write(outputs, targets, metadata)` (third arg
  optional; `LoosePackager` ignores it).
- `CbzPackager`: when `buildComicInfoXml(...)` returns non-null, append it as
  `ComicInfo.xml` at the zip root (alongside the page images), before finalize.
- `PdfPackager`: when `metadata?.title`, call `pdf.setTitle(metadata.title)`
  (and `pdf.setKeywords`/producer left default). No layout change.
- `buildPackagers` unchanged. `scrapeJob` passes the `metadata` object (built
  from the extracted title + total + source URL — see §6) to each
  `packager.write(outputs, targets, metadata)` call.

The `metadata` object packagers receive is normalized in scrapeJob:
`{ series: title, title, pageCount: total, web: job.url }` (fields may be null;
`buildComicInfoXml` drops nulls).

---

## 6. Naming & scrapeJob integration

Split the **stable cache key** from the **display name** in
`src/naming.mjs`:

- `cacheDir` continues to derive from `job.name || slugFromUrl(job.url)` —
  **unchanged**, so resume/`--clear-cache` are unaffected.
- Output paths (`outDir`, `cbzPath`, `pdfPath`) accept an optional display-name
  override. Add a parameter:
  `resolveTargets(config, job, { outputName } = {})` where, in **batch mode**,
  the output folder is `sanitizeName(job.name) || (outputName && sanitizeName(outputName)) || slugFromUrl(job.url)`,
  while `cacheDir` still uses `job.name ? sanitizeName(job.name) : slugFromUrl(job.url)`
  (independent of `outputName`). Single-URL mode ignores `outputName` (explicit
  `--out`/`--cbz-name`/`--pdf-name` win).

`scrapeJob` flow:
1. As today: `targets = resolveTargets(config, job)` up front (cache setup,
   `--clear-cache`, seeding all use this — the cache dir is stable).
2. Acquire via the orchestrator → `r.metadata`.
3. On success, build the normalized `metadata` object (title/series/pageCount/web),
   then resolve **final output targets**:
   `const finalTargets = resolveTargets(config, job, { outputName: r.metadata?.title })`.
   `finalTargets.cacheDir === targets.cacheDir` (slug-stable), only the output
   paths may differ.
4. Package with `finalTargets` + `metadata`; cleanup (`removeJobArtifacts`) uses
   `finalTargets`; `cache.clear()` uses the original `cache` handle (unchanged).
5. If `r.metadata?.count` is present and differs from `r.total`, log a one-line
   verbose note (cross-check only; `total` remains authoritative).

The up-front `targets` and `finalTargets` differ only in the output folder/file
names, and only when batch mode + no explicit `job.name` + a metadata title
exists. Otherwise they are identical to today.

---

## 7. Profiles

- `batcave.mjs`: its existing `metadata: { title: /From:\s*(.+)/, count: /Page\s+\d+\s*\/\s*(\d+)/i }`
  becomes live (no change needed).
- `generic.mjs`: keeps `metadata: {}` → the extractor uses the `og:title` /
  `<title>` fallback. No new profile fields are introduced.

---

## 8. Error handling

- `extractMetadata` wraps `page.evaluate` in try/catch → `{title:null,count:null}`
  on any failure; never throws.
- A strategy's metadata call is itself guarded (a metadata error must not fail an
  otherwise-successful acquisition): wrap the call so a throw yields `null`.
- `buildComicInfoXml` returns `null` when no usable fields → CbzPackager writes no
  ComicInfo.xml.
- Auto-naming: a null/empty title → output name falls back to the slug (current
  behaviour).

---

## 9. Testing

`node --test`, fakes, no real browser.

New — `test/metadata.test.mjs`:
- `extractMetadata`: pattern hit (title + count from bodyText); fallback to
  `og:title` then `<title>` when no `title` pattern/match; no match anywhere →
  `{title:null,count:null}`; `count` parse + non-numeric guard; `page.evaluate`
  throwing → `{title:null,count:null}` (no throw).
- `buildComicInfoXml`: includes present fields, omits null/empty, XML-escapes
  `&<>"'`, returns `null` when all empty, `PageCount` only when a positive number.

Edited:
- `test/packagers.test.mjs` (or new if absent): `CbzPackager.write(…, metadata)`
  produces a zip containing a `ComicInfo.xml` entry with the expected fields; and
  writes **no** `ComicInfo.xml` when metadata is empty. `PdfPackager` sets the
  title (assert via pdf-lib `getTitle()` on the written bytes).
- `test/naming.test.mjs` (or new): explicit `job.name` wins over `outputName`;
  `outputName` used when no `job.name` (batch); `cacheDir` identical regardless of
  `outputName`; single-URL ignores `outputName`.
- `test/orchestrator.test.mjs`: the success result carries `metadata` from the
  winning strategy's `res.data.metadata`.
- `test/pipeline.test.mjs`: `scrapeJob` passes `metadata` to `packager.write` and
  resolves final output targets from `r.metadata.title` (fake orchestrator +
  fake packager capturing its third arg).
- `test/browser-keyboard.test.mjs` / `test/chapter-aware.test.mjs`: a success
  result includes `metadata` (inject a fake `extractMetadata` or a fake page the
  real extractor reads).

Full existing suite stays green.

Live smoke (manual): batcave `/395` → the CBZ contains `ComicInfo.xml` with the
Hulk title and `PageCount` 29; a row with no name auto-names the output from the
title; a non-batcave reader falls back to `og:title`/`<title>` or the slug.

---

## 10. Files

```
src/metadata.mjs                 NEW  extractMetadata + buildComicInfoXml
src/strategies/browser-keyboard.mjs EDIT extract + return metadata
src/strategies/chapter-aware.mjs    EDIT extract + return metadata
src/orchestrator.mjs             EDIT pass winning metadata through on success
src/pipeline.mjs                 EDIT thread profile into ctx; final output targets; pass metadata to packagers; count cross-check
src/naming.mjs                   EDIT resolveTargets(config, job, { outputName }) — stable cacheDir, display-name output paths
src/packagers.mjs                EDIT write(outputs, targets, metadata): ComicInfo.xml (cbz) + PDF title
test/metadata.test.mjs           NEW
test/packagers.test.mjs          NEW/EDIT
test/naming.test.mjs             NEW/EDIT
test/orchestrator.test.mjs       EDIT
test/pipeline.test.mjs           EDIT
test/browser-keyboard.test.mjs   EDIT
test/chapter-aware.test.mjs      EDIT
```

---

## 11. Acceptance criteria

- Scraped CBZs contain a `ComicInfo.xml` with Series/Title/PageCount/Web when
  metadata is available; PDFs have their document title set.
- Metadata is extracted via the profile's patterns, falling back to
  `og:title`/`<title>`; batcave yields the chapter title + page count.
- Output folders/archives auto-name from the title when no explicit `job.name`;
  explicit names and single-URL explicit outputs always win; the cache/resume key
  is unchanged (slug-stable).
- Metadata is best-effort: extraction/packaging-metadata failures never fail a
  job or alter the download path.
- Full existing test suite stays green; new metadata/packager/naming tests pass;
  batcave `/395` still scrapes 29/29 with a correct ComicInfo.xml.
- No JSON-LD/embedded-JSON extraction, extra ComicInfo fields, concurrency, or
  failure-aware selection introduced.
