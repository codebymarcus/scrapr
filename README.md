# scaper — headless terminal image scraper

A Node + Playwright command-line scraper that downloads the page images from a
JS-driven reader/gallery — no browser extension, no "Save As" dialogs. It drives
a headless Chromium the way a person would (getting past JS gates, pressing the
"next page" key, letting the site load each image) and captures every image the
page downloads, then writes them to disk in page order.

This handles **virtualized readers** — sites that keep only a few pages in the
DOM at a time and load the next one when you advance (e.g. batcave.biz comic
reader) — which a plain HTTP-fetch scraper cannot.

## Install (one time)

```bash
cd scraper
npm install        # also downloads a Chromium build (~90 MB) via Playwright
```

## Use

```bash
node scrape.mjs "<readerUrl>" [options]
```

Example (downloads all 18 pages of an issue into `./downloads/…`):

```bash
node scrape.mjs "https://batcave.biz/reader/6967/39131"
```

Pick an output folder:

```bash
node scrape.mjs "https://batcave.biz/reader/6967/39131" --out ./x-men-115
```

Files are saved as `01.webp`, `02.webp`, … in page order. The extension matches
the real image type (so a `.jpg` URL that actually serves WebP is saved as
`.webp`).

### Get a CBZ or PDF of JPGs

```bash
node scrape.mjs "…/39131" --out ./x-men-115 --jpg --cbz    # comic-book archive
node scrape.mjs "…/39131" --out ./x-men-115 --jpg --pdf    # PDF, one page per image
```

- `--cbz` → `./x-men-115.cbz` (a ZIP of `01.jpg`, `02.jpg`, … that comic readers open).
- `--pdf` → `./x-men-115.pdf` (one page per image, page sized to the image, no encryption).
- Add both flags to get both. `--cbz-only` / `--pdf-only` skip the loose image
  files. `--quality 90` raises JPEG quality (default 88).

### Format & device compatibility

Some devices/readers can't open **WebP** inside a CBZ. Use `--jpg` (implied by
`--pdf`) to emit **maximally-compatible JPEGs**:

- **JPEG, baseline** (progressive off) — the most widely supported encoding.
- **sRGB / RGB** — CMYK and other colour spaces are converted to sRGB.
- **Quality 88** by default (`--quality`, 85–90 recommended).
- **Longest edge ≤ 2400 px**, aspect ratio preserved, **no upscaling**
  (`--max-edge` to change the cap).
- No alpha (flattened onto white), no ICC/metadata, **no encryption**.

> Note on the ~1400 px short-edge floor: the scraper never **upscales** — if the
> source pages are smaller than that (e.g. 1200 px wide), they're kept at native
> size, since enlarging only interpolates without adding detail. The cap only
> ever shrinks oversized pages.

A PDF can only embed baseline JPEG/PNG, so `--pdf` converts to JPEG
automatically (unless you pass `--format png`).

## Config file (recurring settings)

Instead of repeating flags every run, put settings in a JSON file. Precedence is
**defaults → config file → CLI flags** (a flag always overrides the file), so you
keep stable settings in one place and only pass what changes.

- Default location: `./scraper.config.json` (or point at one with `--config <path>`).
- Copy the starter and edit it (it's fully commented — `//` and `/* */`
  comments are allowed in the config file):
  ```bash
  cp scraper.config.example.json scraper.config.json
  ```
- Keys are the camelCase setting names, e.g.:
  ```json
  {
    "out": "comics",
    "format": "jpg",
    "pdf": true,
    "keepLoose": false,
    "drive": true,
    "driveFolder": "1AbC...XyZ",
    "driveSubfolder": "Comics",
    "driveOnly": "pdf"
  }
  ```
  Common keys: `out`, `format` (`jpg`/`png`/`webp`/`keep`), `quality`, `maxEdge`,
  `cbz`, `pdf`, `keepLoose` (`false` = only archives), `advanceKey`, `settle`,
  `jitter`, `itemDelay`, `drive`, `driveFolder`, `driveSubfolder`,
  `driveOnly` (`pdf`/`cbz`), `driveCredentials`, `driveToken`.

With the file above, this is all you need per run:
```bash
node scrape.mjs --list links.xlsx        # uses out/pdf/drive/folder/subfolder from the file
node scrape.mjs --list links.xlsx --drive-subfolder "Batch 2"   # override just the subfolder
```
`scraper.config.json` is git-ignored (it holds your personal folder ids/paths);
`scraper.config.example.json` is the tracked template.

## Scraping strategies

The scraper uses a pluggable multi-stage fallback pipeline: strategies run in
order, each strategy retries itself for transient failures (up to `maxAttempts`),
and when retries are exhausted the orchestrator falls back to the next strategy.
The pipeline stops on the first valid result. Attempts are tracked within a
single run; page-level resume across runs remains unchanged (the `PageCache`).
Cross-strategy resume — a fallback strategy only fetching what an earlier
strategy missed — also relies on that page cache; with `--no-cache`, a
fallback strategy re-downloads every page over the network instead of picking
up where the previous strategy left off.

### Built-in strategies

**`current`** — The original headless keyboard-advance reader. Opens the URL past
any JS gate, detects the page count from the reader's DOM elements, presses the
advance key (`--advance-key`) through every page, and collects images as they
load. This is the first strategy in the default pipeline.

**`chapter-aware`** — A fallback for *continuous / looping* multi-chapter readers
like batcave.biz's "event" reader, where pressing the advance key flows out of
the opened chapter into adjacent chapters (so `current` stalls, collecting only
the first page). Instead of pressing keys, it addresses the target chapter's
pages **directly by URL fragment** (`<chapterUrl>#page-N`):
- Reads the chapter's page count from the reader's own "Page X / N" counter.
- Locks the shared `ImageCapture` onto the target chapter's image directory so a
  neighbouring chapter's preloaded images can't hijack the directory filter.
- Visits `#page-1 … #page-N` in order (with a second pass to retry any page whose
  image didn't load the first time), then stops.

Pages arrive in order, so output is ordered correctly even though the image
filenames carry no dash-style page number. Since `chapter-aware` shares the same
`ImageCapture`/`PageCache`, it only picks up pages the earlier strategy missed.

### Configuration

The `strategies` config array defines the pipeline:

```json
{
  "strategies": [
    { "name": "current",       "enabled": true, "maxAttempts": 2 },
    { "name": "chapter-aware", "enabled": true, "maxAttempts": 1 }
  ]
}
```

Keys:
- `name` — Strategy name (`current`, `chapter-aware`, or a custom strategy).
- `enabled` — Include in the pipeline: `true` (default) or `false` to skip.
- `maxAttempts` — Retry count for this strategy (default: strategy-specific).

**Defaults:** Omit the entire `strategies` key to use the pipeline above.
**Single-strategy mode:** Set `"strategies": [{ "name": "current" }]` to restore
single-strategy behaviour (no fallback).

### Adding a custom strategy

Create a new strategy file `src/strategies/<name>.mjs`:

```javascript
export class MyStrategy {
  constructor() {
    this.name = "my-strategy";           // the name used in config.strategies
    this.defaultMaxAttempts = 2;         // fallback if maxAttempts is not set
  }

  async execute({ session, job, config, capture, meter, logger }) {
    // Inject your scraping logic here. Must return:
    // - success: { status: "ok", data: { downloaded, total } }
    // - failure: { status: "failed", error: { code }, data: { downloaded, total, message } }
    // Use `session` (Playwright session), `capture` (shared ImageCapture), `logger`, etc.
  }
}
```

Then register it in `src/strategies/registry.mjs`:

```javascript
import { MyStrategy } from "./my-strategy.mjs";

export const STRATEGY_FACTORIES = {
  current: () => new BrowserKeyboardStrategy(),
  "chapter-aware": () => new ChapterAwareStrategy(),
  "my-strategy": () => new MyStrategy()   // add this line
};
```

Your strategy is now available in `scraper.config.json`:
```json
{ "strategies": [{ "name": "my-strategy", "maxAttempts": 3 }] }
```

## Batch mode: scrape a list of links from Excel

Put your links in a spreadsheet and point the scraper at it. Both **Excel**
(`.xlsx`, `.xls`) and **CSV/TSV** (`.csv`, `.tsv`) are supported — including the
`status` write-back (CSV is written back without a UTF-8 BOM, TSV with tab
delimiters):

```bash
node scrape.mjs --list links.xlsx --out ./comics --jpg --cbz   # Excel
node scrape.mjs --list links.csv  --out ./comics --jpg --cbz   # CSV
```

Each link is scraped in turn into its own subfolder and `.cbz` under `--out`
(the parent folder; default `./downloads`), with a polite pause between links.

**Sheet format** — two supported layouts:

| url | name |
|---|---|
| https://batcave.biz/reader/6967/39131 | X-Men 115 |
| https://batcave.biz/reader/6967/39132 | X-Men 116 |

- A `url` (or `link`/`href`) column supplies the links; an optional
  `name` (or `title`) column names each output folder / `.cbz`.
- If there's **no header**, the **first column** is treated as the links
  (one per row). Rows that aren't `http(s)` URLs are skipped.

With the sheet above, `--out ./comics --jpg --cbz` produces
`./comics/X-Men 115.cbz`, `./comics/X-Men 116.cbz`, etc. One link failing
doesn't stop the batch — a summary of failures is printed at the end.

### `status` column (resumable progress)

Add a `status` column (or let the tool add one — it appends `status` to a
sheet that has a header but no such column) and the scraper tracks each row,
writing the result back to the file **after every row** so you can stop and
resume:

| url | name | status |
|---|---|---|
| …/39131 | X-Men 115 | *(blank)* |
| …/39132 | X-Men 116 | done |
| …/39133 | X-Men 117 | skip |
| …/39134 | X-Men 118 | retry |

| Value | Meaning |
|---|---|
| *(blank)* | Crawl it. On success → set `done`; on error/incomplete → set `retry`. |
| `done` | Already finished — don't download again. |
| `skip` | Don't download (left untouched). |
| `retry` | Crawl it (this is what an unfinished row was set to). |

A row is marked **`done` only when every detected page downloaded**; if it
errored or got fewer pages than the reader reported, it's set **`retry`** so a
later run picks it up again. Just re-run the same command to retry the
unfinished rows — `done`/`skip` rows are left alone.

> Writing status back rebuilds the sheet's cell values; keep the file closed
> in Excel while a batch runs (if it's locked, the tool warns and continues).
> Status tracking needs a header row with a `url`/`link` column.

## Options

| Option | Default | What it does |
|---|---|---|
| `--list <file>` | — | Excel/CSV of links to scrape in batch (see above) |
| `--dry-run` | off | Preview the batch — each job's resolved output targets, skip reason, and Drive destination — then exit without launching the browser or contacting Drive |
| `--item-delay <ms>` | `3000` | Pause between links in batch mode |
| `--out <dir>` | `./downloads/…` | Single: exact output dir. Batch: parent folder for per-link subfolders |
| `--advance-key <key>` | `ArrowRight` | Key that moves to the next page (`ArrowDown`, `PageDown`, `Space`, …) |
| `--pages <n>` | auto | Force the page count instead of auto-detecting |
| `--count-selector <css>` | `img.reader__item, .reader img, #reader img` | Selector whose match count = number of pages |
| `--issue-prefix <substr>` | auto (folder of first image) | Only capture image URLs containing this substring; keeps preloaded neighbouring chapters out |
| `--all-images` | off | Capture every large image, no directory lock |
| `--host <substr>` | — | Only capture images whose URL contains this substring |
| `--jpg` | off | Convert to compatible baseline sRGB JPEG (alias for `--format jpg`) |
| `--format <fmt>` | `keep` | Output format: `jpg`, `png`, `webp`, or `keep` (original) |
| `--quality <n>` | `88` | JPEG/WebP quality (1–100; 85–90 recommended) |
| `--max-edge <px>` | `2400` | Cap the longest side (aspect kept, never upscales) |
| `--cbz` | off | Also package the pages into a `.cbz` archive |
| `--cbz-only` | off | Produce only the `.cbz`, no loose image files |
| `--cbz-name <path>` | `<out dir>.cbz` | Path/name for the `.cbz` |
| `--pdf` | off | Also package the pages into a `.pdf` (one page per image) |
| `--pdf-only` | off | Produce only the `.pdf`, no loose image files |
| `--pdf-name <path>` | `<out dir>.pdf` | Path/name for the `.pdf` |
| `--cleanup` | off | After a successful upload, delete the link's local files; also delete a partial/incomplete download |
| `--accept-partial` | off | If a rerun captures no new pages (the reader has nothing more to give), package/upload what's cached and mark the link done instead of retrying forever |
| `--no-cache` | off | Disable the resumable page cache (re-download everything each run) |
| `--clear-cache` | off | Delete each targeted job's resume cache first, then scrape fresh (path resolved from config, so cwd doesn't matter). With `--dry-run`, only reports what it would clear |
| `--min-bytes <n>` | `20000` | Ignore images smaller than this (skips icons/thumbnails) |
| `--settle <ms>` | `700` | Base pause after each key press, per page |
| `--jitter <0-1>` | `0.3` | Randomize every wait by ± this fraction |
| `--max-retries <n>` | `4` | Navigation retries with exponential backoff |
| `--rate-limit-base <ms>` | `2000` | Backoff base for HTTP 429/503, doubled per hit |
| `--headed` | off | Show the browser window (useful for debugging) |
| `--nav-timeout <ms>` | `45000` | Navigation timeout |
| `--verbose` | off | Per-page capture, skip reasons, phase timings, and a config summary |
| `--debug` | off | Everything `--verbose` shows plus low-level detail: every image response (type/size/URL), key presses, navigation attempts, rate-limit math, cache hits |
| `--log-file <path>` | — | Write a complete, uncoloured, timestamped trace of **every** level to a file (regardless of console verbosity) — attach it when reporting a problem |
| `--cost-per-gb <n>` | — | Estimate metered-proxy cost: report data volume, plus a `~$` estimate at this per-GB rate (e.g. `4` for $4/GB) |

## How it works

1. Launches headless Chromium (full "new" headless engine, with light stealth so
   automation-sniffing gates let it through).
2. Opens the URL; if a JS interstitial bounces to a `/_c?…` gate, waits for it to
   set its cookie and re-requests the real URL.
3. Detects the page count from the reader's page elements.
4. Presses the advance key through every page. Each press makes the reader load
   the next page's image; a network listener captures those image bytes.
5. Locks onto the current chapter's image folder so preloaded neighbouring
   chapters are ignored, orders images by the page number in their URL, and
   writes them to the output folder.

## Adapting to other sites

- If no images download, run with `--headed` to watch what happens.
- If the reader advances on a different key, set `--advance-key` (e.g. `ArrowDown`).
- If page detection is wrong, set `--count-selector` to a selector that matches
  one element per page, or `--pages N` to force the count.
- If it grabs unrelated images, tighten `--host` or `--issue-prefix`; if it
  misses some, try `--all-images` or a larger `--settle`.

## Debugging a stuck download

If a link never completes (e.g. it stops at `22/23`):

1. Read the **missing page(s)** line — the scraper now prints exactly which pages
   it couldn't get (e.g. `missing page(s): 14`).
2. Re-run with `--verbose` to see each page captured, each image **skipped and
   why** (below `minBytes`, wrong chapter directory, host filter), and per-phase
   timings.
3. Add `--debug` to see every image response (type/size/URL), key presses,
   navigation attempts, and rate-limit backoff — this reveals whether a page was
   never requested, was requested but filtered, or was rate-limited.
4. Add `--log-file run.log` to capture the whole trace to a file you can review
   or share.

```bash
node scrape.mjs "<url>" --verbose --debug --log-file run.log
```

Common causes: a genuinely small page filtered by `--min-bytes` (numbered pages
now bypass this), an over-detected page count (pin it with `--pages`), or a
mismatched `--count-selector` / `--advance-key`.

## Estimating proxy data cost

Metered proxies (Bright Data, Oxylabs, …) bill per GB of traffic **through the
proxy** — HTML, JS, CSS, every image kept *or* filtered, trackers — not just the
pages saved. The scraper measures the real transferred bytes and reports them
after each link, and a total for a batch:

```
bandwidth: 3.1 MB across 102 requests (~$0.01 @ $4/GB)
```

Pass `--cost-per-gb <rate>` to include the `~$` estimate (omit it for volume
only). Pages served from the resume cache are excluded — they never hit the
network. The figure is a close estimate, not a to-the-cent match with a
provider's dashboard (they may count connection/TLS overhead and round
differently).

## Per-link sequence & cleanup

With `--cleanup` (or `"cleanup": true`), each link runs this sequence:

1. **Download** every page. Progress shows a live bar (`[████░░] 12/18 75% pages`).
2. If the download is **incomplete** → mark the row `retry` and **delete that
   link's partial files**, then move on.
3. If complete → **convert & package** (e.g. the PDF).
4. **Upload** the produced file(s) to Drive.
5. **Delete the local files** to free space — but only after a **successful
   upload** (with no `--drive`, cleanup is skipped so your only copy is kept).

Then it continues to the next link. A failed upload keeps the local files and
marks the row `retry`.

The logs are colour-coded: cyan for the current step/section, green for
success (saved / uploaded), yellow for retry/rate-limit, red for errors, grey
for skipped rows. Colours auto-disable when output isn't a terminal or when
`NO_COLOR` is set.

## Rate limiting & resilience

The scraper is deliberately gentle and avoids common scraper failure modes:

- **One page at a time.** The browser loads each page's image sequentially as
  you advance — there are no parallel image fetches hammering the server.
- **Jittered pacing.** The `--settle` pause between pages is randomized by
  `±--jitter` (default ±30%), so requests don't arrive on an exact metronome.
  Raise `--settle` (e.g. `--settle 1500`) to slow down on strict sites.
- **Exponential backoff on navigation.** Failed/timed-out page loads are retried
  up to `--max-retries` times, doubling the wait each attempt (`--rate-limit-base`).
- **HTTP 429 / 503 handling.** If the server signals rate limiting, the scraper
  pauses before the next page — honouring a `Retry-After` header when present,
  otherwise backing off exponentially (`--rate-limit-base`, doubled per hit).
- **Drive upload retry.** A transient upload failure (HTTP 5xx, a rate-limit
  response, or a dropped connection) is retried with exponential backoff
  (`--max-retries` / `--rate-limit-base`) instead of failing the whole job and
  forcing a re-download; only non-transient errors fail fast.
- **Graceful Ctrl-C.** Pressing Ctrl-C stops the batch *after* the current link
  finishes, so its files and its `status` cell stay consistent and the run
  resumes cleanly. The remaining links are left untouched. Press Ctrl-C a
  second time to force an immediate exit.
- **Resumable downloads (page cache).** As each page downloads it is written to a
  per-link cache under `<out-parent>/.scaper-cache/`. If a link fails partway
  (say 49/50), the next run **resumes**: the pages it already has are served
  straight from disk (the browser never re-requests them from the server) and
  only the missing page(s) download. The cache is deleted automatically once the
  link finishes and (if `--drive`) uploads. Disable with `--no-cache`. To throw
  away a stuck link's partial cache and start it over, add `--clear-cache` (it
  deletes the cache then scrapes fresh; `--clear-cache --dry-run` just shows what
  it would delete). No need to hunt down `.scaper-cache/` by hand.
  - If a rerun keeps failing on the *same* final page — usually an over-detected
    page count or a genuinely missing last page — the scraper says so and stops
    looping silently. Rerun with `--accept-partial` to package/upload what you
    have and mark the link done, or pin the count with `--pages` / adjust
    `--count-selector`.

To be extra polite on a sensitive site:

```bash
node scrape.mjs "<url>" --settle 2000 --jitter 0.5 --rate-limit-base 5000
```

## Upload to Google Drive

Optionally push each finished `.cbz`/`.pdf` to Google Drive after it's built.

**One-time setup**

1. **Google Cloud (Part A):** create a project → enable the **Google Drive API**
   → configure the OAuth consent screen (scope `.../auth/drive.file`, add your
   account as a Test user) → create an **OAuth client ID → Desktop app** →
   download the JSON as `scraper/credentials.json`.
2. **Authorize (Part B):** run it once to approve in your browser and save a
   reusable token:
   ```bash
   node authorize.mjs      # opens browser → writes token.json
   ```

**Use it**

```bash
# upload the produced files to My Drive root
node scrape.mjs "…/39131" --pdf --drive

# upload into a specific Drive folder (id from the folder URL after /folders/)
node scrape.mjs --list links.xlsx --cbz --drive --drive-folder 1AbC...XyZ

# build both, but upload ONLY the pdf, into a subfolder created on the fly
node scrape.mjs "…/39131" --cbz --pdf \
  --drive --drive-folder 1AbC...XyZ --drive-subfolder "Uncanny X-Men" --drive-only pdf
```

- `--drive` uploads the `.cbz` and/or `.pdf` you asked for, so pair it with
  `--cbz` and/or `--pdf`.
- `--drive-only pdf` (or `cbz`) uploads just that one type even when both were
  produced locally.
- `--drive-subfolder "<name>"` creates that folder inside `--drive-folder` (or
  My Drive root) on the fly — reused if it already exists — and uploads into it.
- Uploads are **resumable** (large files are fine) and **idempotent** — a file
  already present in the target folder is skipped, so re-runs don't duplicate.
- A live **upload progress bar** shows the percentage (`[███░░] 5.0MB/11.9MB 42%
  uploading …`).
- In batch mode a row is marked `done` only after a successful upload; an upload
  failure marks it `retry`.
- `credentials.json` and `token.json` are secrets — they're git-ignored.

Service-account alternative (headless/Workspace): share a **Shared Drive**
folder with the service account and adapt `src/drive.mjs` to use the service
account key instead of the OAuth client. OAuth (above) is simplest for a
personal Google account.

## Project structure

The CLI entry (`scrape.mjs`) is thin; the logic lives in small
single-responsibility modules under `src/`:

| Module | Responsibility |
|---|---|
| `config.mjs` | Parse argv → one validated config object |
| `logger.mjs` | All console output (injected everywhere) |
| `time.mjs` | `sleep`, jittered waits |
| `naming.mjs` | Slugs, sanitising, per-job output paths |
| `browser.mjs` | `BrowserSession` — Chromium launch/context/stealth |
| `navigation.mjs` | Retry/backoff navigation + JS-gate handling |
| `capture.mjs` | `ImageCapture` — collect page images, filters, rate-limit signal |
| `reader.mjs` | `ReaderDriver` — detect page count, advance through pages |
| `processor.mjs` | `ImageProcessor` — order, convert, resize, name |
| `packagers.mjs` | `LoosePackager` / `CbzPackager` / `PdfPackager` (one `write()` interface) |
| `sources.mjs` | `UrlSource` / `SheetSource` (one `load()/setStatus()` interface) |
| `drive.mjs` | `DriveUploader` — optional Google Drive upload of the output |
| `pipeline.mjs` | `scrapeJob` (one URL) + `BatchRunner` (orchestration) |

Extending it stays local: add an output format by writing a new packager and
registering it in `buildPackagers`; add a link source (a DB, an API) with a new
class exposing `load()`/`setStatus()`. The runner depends on those interfaces,
not the concrete classes.

## Notes / limits

- Downloads a single reader URL (one chapter/issue). Point it at each chapter
  URL to grab a series, or ask for a chapter-looping wrapper.
- Respect each site's terms of service and copyright. Use for content you're
  allowed to download.
