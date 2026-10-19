# scaper — headless terminal image scraper

A Node + Playwright command-line scraper that downloads the page images from a
JS-driven reader/gallery — no browser extension, no "Save As" dialogs. It drives
a headless Chromium the way a person would (getting past JS gates, pressing the
"next page" key, letting the site load each image) and captures every image the
page downloads, then writes them to disk in page order.

This handles **virtualized readers** — sites that keep only a few pages in the
DOM at a time and load the next one when you advance (e.g. batcave.biz comic
reader) — which a plain HTTP-fetch scraper cannot.

**Two ways to use it:** the **CLI** documented below, or a **web dashboard**
(project recipes, run queue, live progress, per-item upload controls, Google
Drive) — see [Dashboard (web UI)](#dashboard-web-ui).

> **First-time setup:** a few files (secrets, local config) must be created
> before running — each has a committed `*.example` template. See
> **[SETUP.md](SETUP.md)**.

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

Each URL is scraped using a **site profile** — a per-site pipeline configuration
that matches the reader by domain and sets up the right scraping mechanisms.
The scraper uses a pluggable multi-stage fallback pipeline: mechanisms run in
order, each retries itself for transient failures (up to `maxAttempts`), and
when retries exhaust the orchestrator falls back to the next mechanism. The
pipeline stops on the first valid result.

### Built-in profiles

**`batcave`** — The batcave.biz "event" reader (continuous / looping multi-chapter).
Instead of pressing advance keys (which flow out of chapter boundaries), it addresses
the target chapter's pages **directly by URL fragment** (`<chapterUrl>#page-N`):
- Reads the chapter's page count from the "Page X / N" counter.
- Locks the `ImageCapture` onto the target chapter's image directory so neighbouring
  preloaded images don't hijack the filter.
- Visits `#page-1 … #page-N` in order (with a second pass to retry missed images), then stops.

Pipeline: `[chapter-aware]` (one attempt).

**`generic`** — Default for all other sites. The original headless keyboard-advance reader:
- Opens the URL past any JS gate.
- Detects page count from the reader's DOM.
- Presses `--advance-key` through every page, collecting images as they load.

Pipeline: `[current]` (2 attempts).

### Pipeline configuration

A **mechanism entry** has the shape:

```json
{ "mechanism": "current", "maxAttempts": 2, "params": { "settle": 900 } }
```

Keys:
- `mechanism` — Mechanism name (`current`, `chapter-aware`).
- `maxAttempts` — Retry count for transient failures (default: strategy-specific).
- `params` — Per-site overrides merged over config at execute time.

### Adding a site profile

1. Create a new profile file `src/profiles/<name>.mjs`:

```javascript
export default {
  name: "my-reader",
  match: url => new URL(url).hostname.includes("myreader"),
  contentType: "image",
  pipeline: [
    { mechanism: "current", maxAttempts: 2 }
  ],
  metadata: {}
};
```

2. Register it in `src/profiles/registry.mjs`:

```javascript
import myReader from "./my-reader.mjs";

export const PROFILES = [
  batcave,
  myReader,  // add this line
  generic
];
```

The profile is now active; URLs matching `match()` will use its pipeline.

### Global strategy override

By default the pipeline is chosen per-site by the active profile. Set
`config.strategies` to force a specific pipeline for **all** links:

```json
{
  "strategies": [
    { "mechanism": "current", "maxAttempts": 2 },
    { "mechanism": "chapter-aware", "maxAttempts": 1 }
  ]
}
```

This overrides the per-site profiles globally. Omit the key to use the matched
profile's pipeline. An empty `"strategies": []` is treated the same as omitting
the key — it does NOT disable all scraping; instead, the matched profile's
pipeline is used.

### Content-agnostic seam

Each profile defines its `contentType`: `"image"` (page captures with format
conversion; the default) or `"text"` (HTML → Markdown extraction). The same
profile registry drives both.

### Text scraping

Scrape an article/blog URL to a Markdown file instead of images:

```
node scrape.mjs https://example.com/article --text --out article
```

- `--text` (or `"text": true` in the config) forces text mode for every URL;
  `--text-name` overrides the output file name. Alternatively, give a site
  profile `contentType: "text"` (and optionally `text: { selector: "article.post" }`
  to pick the content container).
- Output is a single `.md` file with YAML frontmatter (title, source, date)
  followed by the Markdown body.
- Extraction uses the profile's selector if set, otherwise Mozilla Readability
  on the rendered page (falling back to `<body>`), converted to Markdown with
  turndown.
- **Three modes.** `--text` (article → one `.md`, the default above);
  `--pattern email|phone|url|name=/regex/` (repeatable or comma-separated) pulls
  matching values into records; `--select "css"` or `--select "name=css"` pulls
  elements matching a CSS selector into records. `--pattern`/`--select` imply
  text mode (`textMode: "pattern"` / `"selector"` in the config).
- **Aggregate output.** Pattern/selector runs write one `<out>.json` and one
  `<out>.csv` per run (one record per URL, appended as the batch progresses)
  instead of a `.md` per page.
- **HTTP-first.** Text modes try a plain static HTTP fetch first and escalate to
  the browser only when the page needs rendering or the fetch is blocked. The
  run summary reports `N via http, M via browser`. Use `--no-http-first`
  (`"httpFirst": false`) to force the browser every time.
- **Profiles.** A site profile can set `text: { mode, selector | fields, patterns }`
  to choose the mode per site (`fields` is a list of `{ name, selector }`
  entries for `selector` mode).
- Text jobs share the batch loop's status column, circuit breaker, and
  `--dry-run` preview with image jobs.

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

## Dashboard (web UI)

Alongside the CLI there's a web dashboard (`dashboard/`) that drives the same
scrape engine from a browser. Run it with Docker Compose (see
**[SETUP.md](SETUP.md)** for env files and ports):

```bash
# production-like (served at http://localhost:8080)
docker compose up --build
# hot-reload dev (served at http://localhost:5173)
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

What it gives you:

- **Projects & recipes** — a project holds a reusable *recipe* (which site, how
  to extract, output format, Drive settings), edited in the **Builder**.
- **New Run form** — pick a project, then supply URLs by **pasting them or
  uploading a sheet** (csv/tsv/txt/xlsx/xls; a `name`/`title` column names each
  output). One form; no separate import dialog.
- **Per-run overrides** (image projects) — choose the **output format**
  (CBZ / PDF / Both / Loose images), toggle **Drive upload**, and set the **Drive
  folder ID** + subfolder for that run without changing the project recipe. The
  folder ID is **remembered per project** (persisted in the browser).
- **Live console** — a terminal-style stream of the running scrape (per-row
  progress, "uploading… uploaded", errors).
- **Items panel** — an expandable per-row table on each run card: **status**
  (completed / pending / skipped / failed, with the failure reason), **upload**
  state (image runs), and per-row actions — **Upload** a scraped-but-not-uploaded
  row, **Retry** a failed row, **Open in Drive**, **Remove** a not-yet-run row —
  plus bulk **Upload all pending** / **Retry all failed**. Paginated for big lists.
- **Run summary** — on a finished run: duration, outcome counts, total uploaded
  size, pages, and bandwidth (cost when a `costPerGb` rate is set).
- **Delete a run** — removes the run, its items, and its output dir (uploaded
  Drive files are left alone); a running run must be stopped first.
- **Connect Google Drive** in Settings (no terminal needed) — see
  [Dashboard: in-app "Connect Google Drive"](#dashboard-in-app-connect-google-drive).

A scrape that succeeds but whose upload fails is kept as **completed, not
uploaded** (files are not re-downloaded) — use the row's **Upload** action to
send it later.

## Upload to Google Drive

Optionally push each finished `.cbz`/`.pdf` to Google Drive after it's built.
There are two ways to authorize Drive: the **dashboard's in-app "Connect Google
Drive" button** (recommended for the dashboard) and `node authorize.mjs` (for
the CLI / terminal use).

### Dashboard: in-app "Connect Google Drive"

The dashboard (Settings page) has a **Connect Google Drive** button. It needs a
Google OAuth client of type **Web application** and these server environment
variables:

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID of the Google Cloud OAuth *Web application* client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Its client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | Where Google sends the browser back. Default `http://localhost:<PORT>/api/drive/callback` (PORT defaults to 5174) |
| `APP_SECRET_KEY` | Base64-encoded 32-byte key used to encrypt the stored Drive token. Generate with `openssl rand -base64 32`. Without it Drive shows "not configured" |

> **Redirect URI must match the origin you browse the dashboard from, and be
> registered with Google.** The OAuth `state` is kept in a SameSite=Lax cookie
> set when you click Connect, so Google must send you back to the *same origin*
> you started from, or connecting fails with `drive=error`. With the default
> Docker Compose setup the dashboard is served at `http://localhost:8080` (nginx
> proxies `/api` to the server), so set
> `GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8080/api/drive/callback` — not the
> server's own `:5174`. With the dev compose stack (Vite on `:5173`) use
> `http://localhost:5173/api/drive/callback`. Whatever value you choose must also
> be added under **Authorized redirect URIs** on the Google OAuth client.

Set these in the server's environment — either the commented placeholders in
`compose.yaml` / `compose.dev.yaml`, or a **`dashboard/server/.env`** file
(loaded automatically; copy `dashboard/server/.env.example`). Then restart and
click **Connect Google Drive** in Settings. Steps in Google Cloud: create a project → enable the
**Google Drive API** → configure the OAuth consent screen (scope
`.../auth/drive.file`, add your account as a Test user) → create an **OAuth
client ID → Web application** and add the redirect URI above.

### CLI: `authorize.mjs`

The command-line scraper uses a separate Desktop-app credential and token file
(it does not use the env vars above).

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

### Dashboard

The web dashboard reuses the same engine (`src/`) and lives under `dashboard/`:

| Path | Responsibility |
|---|---|
| `dashboard/server/` | Fastify + better-sqlite3 API: projects/recipes, run queue (`run-manager.mjs`), per-run config (`build-run-config.mjs`), Drive OAuth (`drive-auth.mjs`) + encrypted token store (`secrets/`, migrations), item upload (`upload-item.mjs`), run summary (`run-summary.mjs`), live-event hub + WebSocket |
| `dashboard/web/` | React + Vite SPA: projects/Builder, runs (New Run form, items panel, live console, run summary), settings (Drive connect). Talks to the server over the same origin (`/api`, `/api/ws`) |
| `compose.yaml`, `compose.dev.yaml` | Run the web + server together (prod / hot-reload dev) |

The server imports the engine directly and runs scrapes through the same
`BatchRunner`, so a dashboard run behaves exactly like a CLI run (including
per-row Drive upload).

## Notes / limits

- Downloads a single reader URL (one chapter/issue). Point it at each chapter
  URL to grab a series, or ask for a chapter-looping wrapper.
- Respect each site's terms of service and copyright. Use for content you're
  allowed to download.
