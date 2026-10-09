# Text Extraction v2 — HTTP-first acquisition + pluggable extractors

**Date:** 2026-10-09
**Status:** Approved design (ready for implementation plan)
**Author:** Mark Aquiatin (with Claude)
**Builds on:** `docs/superpowers/specs/2026-10-08-text-content-type-design.md` (the shipped `text` content type: article → Markdown)

---

## 1. Purpose & Intent

The scraper now has a `text` content type, but it (a) always launches a browser
and (b) only does article extraction (Readability → Markdown). This project
generalizes text scraping into **targeted text of several kinds** over a
**cost-cutting HTTP-first acquisition layer**.

**Goals**
- **Cut metered-proxy cost and wall-clock time:** fetch pages over plain HTTP and
  run extraction in Node; launch Chromium only when the cheap path fails or the
  page is JS-gated. Most text targets are in static HTML.
- **Extract targeted text, not just articles:** emails, phone numbers, URLs and
  custom patterns (**pattern** mode); specific fields by CSS selector
  (**selector** mode); clean prose → Markdown (**article** mode, as shipped).
- **Keep it a single-operator, polite tool:** no concurrency, no queue, no
  pagination for text. The image pipeline is untouched.

**Success criteria**
- Pages/targets reachable via static HTTP are scraped with **no browser launch**,
  and the run summary reports how often the HTTP path won (`via:http` vs
  `via:browser`).
- All three modes work from fixture HTML in tests **with no real browser**.
- The shipped `--text` (article → `.md`) behavior is unchanged for users.
- The image path is byte-for-byte behavior-unchanged when not in text mode.

**Non-goals (this project)**
- Text pagination / multi-page stitching; concurrency; non-`openReader` JS
  interaction; image HTTP-first (a later project — the strategy-pipeline seam is
  left clean for it); presets beyond email/phone/url (custom regex covers the rest).

## 2. Context & key findings

- **Node 22, built-in `fetch`.** No HTTP library is needed.
- **`xlsx` is already a dependency.** CSV writing reuses it.
- **Spike result (decisive):** `@mozilla/readability` **cannot** run on
  `@mixmark-io/domino` (turndown's bundled DOM) — it throws `nodeList is not
  iterable`, and `NotYetImplemented` after shimming. A real server-side DOM is
  required for no-browser Readability.
- **Decision — unify on `linkedom`** (one new light, pure-JS dependency, no native
  build). A single `linkedom` document serves all three modes with no browser:
  `querySelectorAll` (selector), Readability (article), and regex over the raw
  HTML (pattern). This also **retires the in-page Readability injection** shipped
  in the text content type — Readability now runs in Node on a `linkedom` doc for
  both the static and the browser paths.
- **Records output — both CSV and JSON** (chosen).
- **Record writing — incremental** (persist each URL's record as it completes,
  matching the scraper's resumable, persist-as-you-go ethos).

## 3. Architecture

```
URL → [acquire: static fetch → escalate to browser] → linkedom document + raw html
      → [extract: pattern | selector | article]      → payload (+ empty flag)
      → [write: records (CSV+JSON, incremental) | article (.md per URL)]
```

Three parts, each a small focused module:

1. **Acquisition** (`src/text/acquire.mjs`) — HTTP-first with extraction-aware
   escalation; normalizes every source to a `linkedom` document.
2. **Extractors** (`src/text/extractors/{pattern,selector,article}.mjs` +
   `registry.mjs`) — one shared `extract(doc, html, opts)` contract.
3. **Output** (`src/text/records.mjs` for CSV+JSON; existing `markdown.mjs` for
   `.md`).

Wired into the batch loop via the existing text branch in
`BatchRunner._runJobs` → `scrapeText` (rewired to use acquisition + the selected
extractor + the matching writer).

### 3.1 Acquisition layer — `src/text/acquire.mjs`

```
acquireAndExtract({ url, mode, opts, session, config, logger, meter, deps }) →
    { result, via, bytes }          // result = extractor payload (non-empty)
  | fail(code)                       // EMPTY_RESULT / HTTP_ERROR / NETWORK_ERROR / TIMEOUT / BLOCKED

Steps:
  1. STATIC:
     - fetch(url, { headers: browser-like UA + Accept, redirect: "follow",
       signal: AbortSignal.timeout(config.navTimeout) }); count bytes into meter.
     - non-2xx  → remember HTTP_ERROR, go to ESCALATE.
     - content-type not html/xml → remember BLOCKED/non-html, go to ESCALATE.
     - html = await res.text(); doc = parseHtml(html) (linkedom).
     - payload = extract(mode)(doc, html, opts).
     - if !payload.empty → return { result: payload, via: "http" }.
     - else go to ESCALATE (static loaded but yielded nothing — likely JS-rendered).
  2. ESCALATE (browser):
     - page = session.newPage(); meter.attach(page);
       await openReader(page, url, config, logger);     // existing JS-gate handling
     - html = await page.content(); doc = parseHtml(html) (linkedom).
     - payload = extract(mode)(doc, html, opts).
     - page.close() in finally.
     - if !payload.empty → return { result: payload, via: "browser" }.
     - else → fail(EMPTY_RESULT).
  3. A thrown fetch/nav error anywhere → caught → fail(mapError(e)); never throws
     into the batch loop.
```

- **One document type.** Static `res.text()` and browser `page.content()` are both
  parsed by `parseHtml` (linkedom), so extractors never branch on source.
- `parseHtml(html)` is a tiny helper (own module or top of `acquire.mjs`) wrapping
  linkedom's `parseHTML`, returning `{ document }` (and `window` if needed).
- `deps` injects `fetchFn` (default global `fetch`), `openReader`, `parseHtml`, and
  the extractor registry, for browserless tests.

### 3.2 Extractor contract — `src/text/extractors/`

Every extractor is a pure function, never throws:

```
extract(doc, html, opts) → { kind, empty, ...payload }
```

**`pattern.mjs`** — `kind:"pattern"`.
- `opts.patterns`: array of `{ name, regex }`. Presets resolved by name:
  - `email` → RFC-lite `/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi`
  - `phone` → international/NA-friendly digit-group pattern
  - `url`   → `https?://` matcher
  - custom  → `name=/regex/flags` passed through from CLI/profile.
- Scans `doc.body.textContent` **and** `html` (to catch `mailto:`/`tel:` hrefs and
  attribute values); merges, **dedups** case-insensitively per type, preserves
  first-seen order.
- Payload: `{ matches: [{ type, value }] }`. `empty` = `matches.length === 0`.

**`selector.mjs`** — `kind:"selector"`.
- `opts.fields`: array of `{ name, selector, attr?, many? }`.
- Per field: `doc.querySelectorAll(selector)`; value = `attr ? el.getAttribute(attr)
  : el.textContent.trim()`; `many:true` → array of all, else first match (or null).
- Payload: `{ fields: { [name]: value | value[] | null } }`. `empty` = every field
  null/empty.

**`article.mjs`** — `kind:"article"`.
- `runReadability(doc)`: `new Readability(doc).parse()` (Node, on the linkedom doc)
  → `{ title, html, byline, excerpt } | null`.
- Fallback chain when Readability yields nothing: profile `opts.selector` →
  `article` → `main` → `body` (via `doc.querySelector`), else null.
- Converts with the **existing** `htmlToMarkdown` + `buildMarkdownDoc` (unchanged).
- Payload: `{ title, byline, excerpt, markdown }`. `empty` = no/empty markdown.
- **Replaces** the shipped `src/text/extract.mjs` (in-page injection). Same output
  contract; the in-page `page.evaluate` tests are retired, the markdown-conversion
  tests stand.

**`registry.mjs`**: `EXTRACTORS = { pattern, selector, article }` (name → extractor),
mirroring `strategies/registry.mjs`. Adding a mode = one file + one line.

### 3.3 Output writers

**Article → one `.md` per URL** (unchanged): `buildMarkdownDoc(payload)` →
`resolveTargets(config, job).mdPath`.

**Records (pattern/selector) → aggregate CSV + JSON, written incrementally**
(`src/text/records.mjs`):
- Each URL → one record object:
  - pattern: `{ url, email: [...], phone: [...], url: [...], <custom>: [...] }`
    (matches grouped by type).
  - selector: `{ url, <field>: value | value[] }`.
- A `RecordWriter` opened for the batch:
  - `append(record)` after each URL: rewrites `<base>.json` (array) and `<base>.csv`
    from the in-memory accumulator so a mid-run crash keeps completed URLs. (Simpler
    and safe for the single-operator scale; "incremental" = persisted-after-each, not
    streamed-append.)
  - CSV columns = `url` + union of all keys seen so far; multi-valued cells joined
    with `"; "`; written via `xlsx` (`utils.json_to_sheet` → `sheet_to_csv`).
  - JSON = `JSON.stringify(records, null, 2)`.
- Paths from `resolveTargets`: add `jsonPath`/`csvPath` siblings to `mdPath`,
  defaulting off `--out` (batch) / the single-URL base; `--text-name` overrides the
  base name.

### 3.4 Result shape (unchanged text shape)

Success: `{ ok:true, complete:true, saved, contentType:"text", bytes, requests, via }`
- `saved` = `1` for a written `.md`; for records, the count of matches/non-empty
  fields. **Zero matches on a page that loaded fine is `ok:true, complete:true,
  saved:0`** — a clean "nothing to find", not a failure (so the breaker does not
  trip and the row is marked done).

Failure: the existing `fail(code)` = `{ ok:false, complete:false, saved:0,
contentType:"text", attempts:[{ name:"text", status:"failed", code }] }` spread with
`{ bytes, requests }` — **no top-level `error`** (so `failureCodeOf` reports the code
from `attempts[]`; this invariant is covered by a regression test, as in the shipped
feature).

`via:"http"|"browser"` is threaded into `rec` and tallied in the run summary.

## 4. CLI / config / profile surface

**Mode selection precedence:** explicit CLI flag > profile `text.mode` > default
`article`. `--text` alone remains article → `.md` (shipped behavior unchanged).

**New CLI flags** (added to `config.mjs` `DEFAULTS`, `FLAGS` where boolean, and
`buildConfig`):
- `--text-mode <article|pattern|selector>`
- `--select "<css>"` or `--select "name=<css>"` (repeatable) — shorthand that sets
  `mode:selector` and appends a field; bare selector → field name `text`.
  **Disambiguation (selectors contain `=`):** the `name=` prefix is recognized
  **only** when the substring before the first `=` matches `^[A-Za-z0-9_-]+$`;
  otherwise the whole value is the selector (field `text`). So `price=.amount`
  → field `price`; `a[href='x']` → field `text`, selector `a[href='x']`.
- `--pattern <preset|name=/regex/flags>` (repeatable) — sets `mode:pattern` and
  appends a pattern; **presets** (bare words): `email`, `phone`, `url`. Anything
  else must be `name=/regex/flags` — split on the first `=` only (the regex body is
  delimited by `/.../`), e.g. `sku=/SKU-\d+/i`. A value that is neither a known
  preset nor `name=/.../ ` form is rejected with a clear config error.
- `--http-first` / `--no-http-first` (default **on**) — force/skip the static path
  (debugging and sites known to be JS-only).
- `--text-name <base>` — overrides the output base (already exists; now also names
  `.json`/`.csv`).

**Config keys** (DEFAULTS): `textMode:"article"`, `textSelect:[]`,
`textPatterns:[]`, `httpFirst:true` (plus existing `text`, `textName`).

**Profile** (`contentType:"text"`) gains an optional
`text: { mode, selector | fields, patterns }` block, so a site is scraped by URL
with no flags — same resolve-by-URL model as images. Profile shape doc comment
updated.

**Dry-run:** `describeDryRun` shows the resolved mode and the output target(s)
(`.md`, or `.json` + `.csv`).

## 5. Errors, breaker, metering

- `mapError` extended: `fetch` `AbortError`/timeout → `TIMEOUT`; `TypeError`
  ("fetch failed")/ENOTFOUND/ECONN → `NETWORK_ERROR`; non-2xx → `HTTP_ERROR`
  (set at the call site, not from a thrown error).
- These feed `CircuitBreaker` exactly as the image path does (`HTTP_ERROR`,
  `NETWORK_ERROR`, `TIMEOUT` are domain-health codes); the `reason` column shows
  the code. `EMPTY_RESULT` does not trip the breaker.
- Bandwidth: the static fetch counts `res` body bytes into the `BandwidthMeter`;
  the browser escalation attaches the meter to the page as today. The summary
  reports total bytes and the `via` tally.

## 6. Pipeline integration

- `scrapeText(session, job, config, logger, profile, deps)` is **rewired**:
  1. Resolve mode: `config.textMode`-or-flags > `profile.text?.mode` > `"article"`.
  2. Build `opts` from flags/profile (`fields`/`patterns`/`selector`).
  3. `acquireAndExtract(...)` → payload + `via`.
  4. Dispatch to the matching writer (article → `.md`; pattern/selector →
     `RecordWriter.append`).
  5. Return the text result shape (with `via`).
- `BatchRunner` gains a per-run `RecordWriter` (created when the run is in a records
  mode) and passes it into `scrapeText` via the existing `_scrapeText` seam / deps.
  Article runs don't create one.
- The image branch, `scrapeJob`, orchestrator, strategies, capture, processor and
  packagers are **untouched**.

## 7. New / changed files

- **New:** `src/text/acquire.mjs`, `src/text/extractors/pattern.mjs`,
  `.../selector.mjs`, `.../article.mjs`, `.../registry.mjs`,
  `src/text/records.mjs`.
- **Changed:** `src/text/scrape-text.mjs` (rewired), `src/naming.mjs`
  (`jsonPath`/`csvPath`), `src/config.mjs` (flags/keys), `src/profiles/profile.mjs`
  (doc), `src/pipeline.mjs` (RecordWriter wiring, dry-run line, summary `via`
  tally), `README.md`, `scraper.config.example.json`.
- **Removed:** `src/text/extract.mjs` (replaced by `extractors/article.mjs`) and its
  in-page `page.evaluate` tests.
- **Dependency:** add `linkedom`. No other new deps (built-in `fetch`; `xlsx` reused).

## 8. Testing (node:test + node:assert/strict, no real browser)

- **Extractors:** build a `linkedom` doc from fixture HTML.
  - pattern: emails/phones/urls found in text AND in `mailto:`/`tel:` hrefs; dedup;
    custom regex; empty page → `empty:true`.
  - selector: `textContent`, `attr`, `many`, missing field → null, all-missing →
    `empty:true`.
  - article: Readability on fixture → markdown; fallback to `article`/`main`/`body`;
    nothing → `empty:true`.
- **Acquisition/escalation** (injected fake `fetchFn` + fake `session`):
  static-success stays `via:"http"`; non-2xx → escalate → `via:"browser"`;
  static-empty (JS-rendered fixture) → escalate; both-empty → `EMPTY_RESULT`;
  thrown fetch → `fail(NETWORK_ERROR)`, no top-level `error` (breaker invariant).
- **Records writer:** CSV columns union + `"; "` join; JSON array content;
  incremental rewrite keeps earlier rows after a later append.
- **Pipeline branch:** a records-mode text job routes to the records writer; an
  article text job writes `.md`; `--text` default stays article; the image branch is
  unchanged.
- **Config:** mode precedence (flag > profile > default); `--select`/`--pattern`
  parsing (repeatable); `--no-http-first`.

## 9. Review focus (inputs the spec implies but tests must pin)

- **`--pattern email` over a URL list** → aggregate CSV+JSON with one deduped row
  per URL, `saved` = match count, `via` recorded.
- **A page that loads but has zero matches** → `ok:true, complete:true, saved:0`
  (clean empty, breaker not tripped), not a failure.
- **A JS-gated page (static yields nothing)** → escalates to the browser and still
  extracts.
- **A transport failure (non-2xx / DNS / timeout)** → mapped code, feeds the
  breaker, written to `reason`, no top-level `error` on the result.
- **`--text` with no mode/flags** → article → `.md`, exactly as shipped (no
  regression).

## 10. Seams left for later (not built now)

- **Image HTTP-first:** an `http-first` mechanism in the strategy pipeline (before
  the browser mechanisms) — the acquisition helper here is reusable.
- **More presets / structured extraction:** JSON-LD / microdata / OpenGraph as a
  `structured` mode; additional pattern presets.
- **Text pagination / crawl:** following links to N pages per URL.
