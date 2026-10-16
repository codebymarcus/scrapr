# Scraper Dashboard — Design

**Date:** 2026-10-16
**Status:** Draft for review
**Author:** Mark Aquiatin (with Claude)

---

## 1. Intent & the why

The scraper today is a Node.js CLI library (`scrape.mjs` + `src/`). Running it means
remembering flags, pointing it at spreadsheets of URLs, watching console output, and
writing `.mjs` "profile" files by hand to teach it a new site. There is no way to see
at a glance what is queued, what is running, what stalled, or whether a new scraping
target actually extracts the right things before committing a whole batch to it.

This project adds a **local, single-user web dashboard** that wraps the existing
engine so the operator (the author, on their own machine) can:

- **See everything in one place** — what is queued, running, stalled, or done.
- **Resume stalled work** — pick up an interrupted run where it left off.
- **Add work** — enqueue a new list of URLs (or import an existing spreadsheet).
- **Stand up a new scraping project and _test_ it** — paste one URL, see what the
  engine detects, point-and-click/toggle the exact items (text, images, fields) to
  capture, confirm they look right, and save it as a reusable recipe — **without
  writing a profile file by hand**.

The guiding why: **trust before scale.** The operator wants to _verify_ a recipe on a
real page and judge correctness (right text, right image) before unleashing it across
hundreds of same-template pages.

## 2. Goals

- A browser dashboard, run locally with one command, single user, no login (v1).
- The **dashboard owns the queue** in its own local database (SQLite). The CLI's
  spreadsheet workflow becomes an _import_ path, not the source of truth.
- **Live run monitoring**: per-run progress (done / total), running/stopped/done
  state, failing-host indicators, and a readable log view.
- **Resume**: a stopped run continues, processing only the unfinished items — mirroring
  how the engine already behaves (status-column + page-cache resumability).
- **Pause / stop** a running job from the UI.
- **Project builder with live test — image-first (operator priority)**: paste a URL →
  engine fetches & renders → operator sees **every candidate image as a thumbnail**
  with its metadata (dimensions, bytes, container/position) → **keeps/drops individual
  images or sets a filter rule** → saves a **data-driven recipe** to the DB. Text/field
  capture is the **secondary** path in the same builder (click/toggle fields, grab an
  image by selector). See §7.4 — the image path requires **new engine work** (§5.4).
- **Detection filter** in the builder: scope detection to images / text / links /
  tables / custom selector, so tests are fast and focused.
- **Google Drive**: surface the existing Drive connection/auth status and
  destination settings in the UI (the engine already uploads image packages to Drive).
- **Design**: React 19 + TypeScript (strict), reusing the conventions and design
  system from `crypto-market-dashboard` — a **dark, vintage/retro** theme built on the
  operator's core palette (see §6).

## 3. Non-goals (v1) & anti-goals

**Deferred to later (explicitly out of v1):**

- **Dashboard login / auth** — single local user, no sign-in in v1. (Comes when/if hosted.)
- **Site-login scraping** — the engine authenticating into sites that gate pages behind
  a login. Not in v1.
- **Scheduled / automatic triggers** — cron-style or event triggers (cf. the untracked
  `hosted-scraper-triggers` note). Not in v1; runs are started manually.
- **Hosting / multi-user** — v1 is localhost only. Architecture should not _preclude_
  hosting later, but no hosting work is done now.
- **Replacing the CLI** — the CLI keeps working. The dashboard is additive.

**Anti-goals (would make this a failure even if it "works"):**

- Re-implementing the scraping engine, or forking its logic. The dashboard must drive
  the _existing_ engine as a library; scraping behavior must stay identical to the CLI.
- A recipe builder that still requires hand-editing `.mjs` files for the common case.
- A test/preview that writes output or mutates the queue as a side effect — testing a
  page must be free of consequences.
- Silent incorrectness — if a page doesn't match a saved recipe, the dashboard should
  flag it for review, not guess.

## 4. Constraints

- **Engine is a Node ESM library with no API/server/frontend today.** It is cleanly
  modularized and almost everything is exported (`BatchRunner`, `scrapeJob`,
  `scrapeText`, `acquireAndExtract`, `RecordWriter`, `CircuitBreaker`, `DriveUploader`,
  config/source modules). The `logger` is dependency-injected into every component —
  this is the primary hook for turning engine activity into live UI events.
- **Persisted engine state today:** spreadsheet `status`/`reason` columns (per-row
  progress, resumable), per-job page cache `index.json` (per-page progress, has
  `total` + entry count), and the `RecordWriter` `.json`/`.csv` (text results).
- **Site "recipes" are currently code** (`src/profiles/*.mjs`), matched by URL,
  first-match-wins. To let the operator define targets from the UI, recipes must become
  **data-driven** (stored in the DB and resolved at runtime) — see §7.4.
- **No runtime enqueue** today (the job list is fixed at process start) and **no
  programmatic stop** (only SIGINT). Both need to be added to drive runs from a UI.
- **No existing single-page preview** that extracts without writing. `acquireAndExtract`
  returns the extractor payload and never writes — a thin no-write wrapper gives the
  builder its "test" capability cheaply.
- **Tech stack is fixed by the reference project** (see §6): React 19, TS strict + ESM
  + `verbatimModuleSyntax`, Vite, TanStack React Query (all remote data), Zustand
  (global client state only), Zod (validate all external JSON), Sass + CSS Modules
  (ITCSS + tokens), Vitest + Testing Library. Named exports only; `PascalCase.tsx` for
  components, `kebab-case.ts` for everything else; `type XProps` not `interface`; never
  hardcode a color (use tokens). Backend is also Node (same repo), so it can import the
  engine directly.

## 5. Architecture (the parts decided)

### 5.1 Where it lives
A new **`dashboard/` folder inside this scraper repo** (decided). It contains:

- `dashboard/server/` — a small Node (ESM) HTTP + WebSocket server that **imports the
  scraper engine in-process** (not shelling out to the CLI).
- `dashboard/web/` — the React/TS SPA (Vite), structured like `crypto-market-dashboard`.

One repo, one `npm run` to start both (or a concurrently-run dev script). Rationale:
the backend needs the engine as a library; co-locating avoids a package-publish dance
and keeps the engine and its UI versioned together.

### 5.2 Backend responsibilities
- **Own the queue DB** (SQLite). CRUD for projects (recipes), runs, and run-items.
- **Drive the engine**: construct `BatchRunner` with (a) an **injected logger** that
  emits structured events, and (b) a **DB-backed job source** that reads items from the
  queue and writes status back to the DB (instead of a spreadsheet).
- **Expose a typed HTTP API** for the SPA (list/create projects & runs, enqueue, import
  a spreadsheet, resume, pause/stop, fetch results, Drive status).
- **Push live events over WebSocket** (progress, per-item status, breaker trips, log
  lines). This is the one pattern the reference project does _not_ have (it polls), so
  it's new work — see §7.1.
- **Single-page test endpoint(s)**: no-write preview(s) that, given a URL + detection
  scope, return what the recipe would capture. **Text/field** preview is a thin wrapper
  over `acquireAndExtract` (returns detected fields + extracted values). **Image**
  preview is new work (§5.4): run the browser reader on the test page, enumerate every
  candidate image (DOM + network), and return thumbnails + metadata (dimensions, bytes,
  container selector, position/index) **without packaging or uploading**.

### 5.3 Frontend responsibilities
- SPA mirroring the reference architecture: feature-sliced (`features/runs`,
  `features/projects`, `features/builder`, `features/drive`), atomic shared components,
  React Query for all server data, Zustand only for global client state (e.g. theme),
  Zod schemas validating every API response.
- Add **react-router** (reference project is single-view; this one has several views).
- A **live layer**: WebSocket messages update React Query caches (or a small live store)
  so progress bars and statuses move in real time.

### 5.4 Engine changes required (additive, must not change scraping behavior)

**Queue / control / events:**
1. A **programmatic stop** (promote the private `_stopping` to a supported control).
2. A **DB-backed `JobSource`** implementing the same interface as `SheetSource`
   (load items, `setStatus`, `setReason`) but against the queue DB.
3. A **recipe resolver bound per-run**: a run carries an operator-selected recipe id;
   the resolver loads that recipe from the DB and applies it to the run's items (rather
   than first-match-by-URL). Code profiles (`batcave`, `generic`) remain as built-in
   fallbacks for items with no bound recipe.
5. A **structured-event logger** adapter (implements the existing logger method shape;
   forwards events to the WebSocket layer).

**Image path (new R&D — this is what "image sites priority" costs):**
6. A **no-write image preview**: render the test page via the Playwright reader,
   enumerate candidate images (DOM `<img>`/background + network responses), and return
   per-image thumbnails + metadata (dimensions, bytes, container selector, position)
   **without** the packaging/Drive steps that `scrapeJob` always runs today.
7. An **image recipe / filter model**: today `capture.mjs` filters passively by
   `minBytes` + directory-lock + numbered-page heuristics. Add **operator-defined image
   rules** — include/exclude by min dimensions, size, container/CSS selector, and
   position/index — stored in the recipe and applied during capture. This is the
   primitive behind "keep the hero, drop the ad."

**Text path (secondary, smaller):**
4. A **no-write text/field extraction preview** wrapper over `acquireAndExtract`
   (returns detected fields + values; the selector model already exists).

These are the known seams; the builder may find more. **Boundary (see anti-goals):**
the builder lets the operator *compose and param-tune existing capture mechanisms*
(`current`, `chapter-aware`) and *define image filters* as data. A genuinely new paging
scheme that neither mechanism covers still needs a new strategy written in code — the
builder reduces, but does not fully eliminate, code for novel paging. Making this honest
and visible in the UI (e.g. "this site's paging needs a new mechanism") is part of v1.

## 6. Design system & theme (decided)

Reuse `crypto-market-dashboard` wholesale where possible: copy `src/styles/`
(ITCSS settings/tools/generic/elements/objects + `index.scss`), `src/components/`
atoms/molecules/templates (Text, IconButton, TextInput, Select, Label, ErrorState,
PageLayout, PageHeader, ThemeToggle, icons), and `src/lib/` (typed HTTP client,
api-clients registry, query-client, query-retry) and `src/stores/use-preferences-store.ts`.
Keep the same `vite.config.ts` alias + Sass `loadPaths` and `tsconfig` flags. Rename the
localStorage preferences key and the pre-paint theme `<script>` in `index.html`.

**Theme: dark + vintage/retro.** Core palette (operator-chosen,
colorhunt `ff6500 / 1e3e62 / 0b192c / 000000`):

| Role | Token | Hex | Note |
|---|---|---|---|
| Accent (actions, progress, active nav, focus) | `--color-accent` | `#FF6500` | core |
| Elevated surface / strong border / hover | `--color-surface-hover` / `--color-border-strong` | `#1E3E62` | core |
| App background canvas | `--color-background` | `#0B192C` | core |
| Base frame (sidebar, deepest layer, meter troughs) | `--color-base` | `#000000`→`#060F1A` | core |
| Panels | `--color-surface` | `#102A45` | derived |
| Border | `--color-border` | `#23405F` | derived |
| Text (cream "paper") | `--color-text` | `#EFE3CC` | derived — warm, not cold white |
| Secondary text (muted tan) | `--color-text-secondary` | `#A99F86` | derived |
| Accent hover / burnt | `--color-accent-hover` | `#FF7D2B` / burnt `#D9550A` | derived |
| Positive (done) | `--color-positive` | `#7FAE63` | derived (muted) |
| Warning (stalled) | `--color-warn` | `#D9A441` | derived (muted) |
| Negative (failed) | `--color-negative` | `#CF5B4C` | derived (muted) |

The palette carries no semantic colors; the muted green/amber/red above are **derived**
and chosen to sit on the navy. (If the operator later wants strictly on-palette
semantics, warnings/errors can collapse to orange + neutrals.)

**Vintage treatment (approved via mockup):**
- Typography: **Bitter** (slab serif) for display titles & run names; **JetBrains Mono**
  for all data (counts, URLs, selectors, statuses, labels); Inter for body. Load the
  fonts (the reference names Inter but never loads it).
- Cream paper text on deep navy; **burnt-orange gradient** primary buttons with an inset
  bevel; **dashed section rules**; italic subtitles.
- A faint **film-grain + scanline overlay** for the retro-CRT/print feel (subtle; make
  it toggleable/reducible and respect `prefers-reduced-motion`).
- **Progress = segmented LED meter** (approved): discrete lit blocks glowing orange in a
  dark inset groove, leading block gently flickering on a running job; amber when
  stalled; mono `%` readout alongside.

Mockups produced during brainstorming live in
`.superpowers/brainstorm/.../content/` (`vintage-v2.html` is the approved reference for
the Runs screen; `builder-v3.html` for the builder flow — the builder's final skin
should be re-rendered in the vintage theme during implementation).

## 7. Key designed behaviors

### 7.1 Live progress
The engine's per-step state is only seen by the injected logger today. The backend
injects a logger adapter that converts `step/section/success/warn/error/progressBar`
calls into structured events, and pushes them over WebSocket. The SPA applies them to
the relevant run's cache. (New pattern — no reference to copy.)

### 7.2 Resume
"Resume" re-runs a run against the queue DB; the DB-backed job source skips items whose
status is `done` and processes blank/`retry` items — the same semantics as the current
spreadsheet `skipReason` logic. Per-page (within-item) resume continues to rely on the
existing page cache.

### 7.3 Add / import work
- **Add a list**: paste/enter URLs, or **import** an existing `.xlsx/.csv` (reuse the
  engine's sheet reader) → rows become queue items under a chosen project/recipe.
- Items can be enqueued into a new run, or into an **existing stopped/resumable run**.
  (v1 does **not** live-append to a run that is currently executing — that would require
  a pollable/streaming job source; deferred.)

### 7.4 Project builder & test (the heart — image-first)

**Image path (the operator's priority):**
1. Operator pastes **one test URL** (a real page from the target site) and sets the
   **detection scope** to Images.
2. Backend runs the **no-write image preview** (§5.4.6): renders the page in the reader,
   enumerates every candidate image, returns **thumbnails + metadata** (dimensions,
   bytes, container selector, position) — nothing is packaged or uploaded.
3. UI shows all candidate images as a **thumbnail grid**. Operator **keeps/drops
   individual images** (e.g. keep the hero, drop the ad/logo) and/or **sets a filter
   rule** — min dimensions, size, container/CSS selector, position/index — that
   generalizes to later pages.
4. Because every later page shares the **same site template**, the captured
   rule/selector is saved **verbatim** into the recipe and reused on all following pages.
   A page where the rule captures nothing (or an unexpected count) is **flagged for
   review** (lightweight marker on the run), not silently accepted.
5. The recipe also records the **paging mechanism** (`current` / `chapter-aware`) and
   its params. If the site's paging matches neither, the builder **says so** and the run
   can't be fully data-driven until a new mechanism is added in code (honest boundary).

**Text/field path (secondary, same builder):**
6. With scope set to Text/fields, the **no-write text preview** (§5.4.4, over
   `acquireAndExtract`) shows detected fields with **actual extracted values**; operator
   toggles fields or adds one by selector. Selector model already exists in the engine.

**Both paths:** operator can **re-test on another URL** before saving; **Save project**
writes the recipe as **data** to the DB (no `.mjs` authoring for the covered cases).

Rendering the preview uses the engine's Playwright render (screenshot + element/image
map) rather than a raw cross-origin embed. If click-on-rendered-page proves costly in
v1, the fallback is the thumbnail grid + rule form for images (and the toggle list for
text), with click-to-add as a later enhancement.

### 7.5 Google Drive
Surface the existing Drive OAuth status (connected / needs `authorize.mjs`) and the
destination folder/subfolder settings. Image packages (`.cbz`/`.pdf`) upload to Drive
as they do in the CLI. (Text outputs are not uploaded to Drive today; unchanged.)

## 8. The four core screens

1. **Runs** (home) — stat strip (running / queued / done today / failing hosts) +
   grouped run cards: Running (live segmented meter, pause/log), Stopped-resumable
   (resume, leftover rows), Recent/Done. (Approved: `vintage-v2.html`.)
2. **Projects** — list of saved recipes; create new → builder.
3. **Builder / Test page** — paste URL, detection filter, rendered preview. **Image-first:**
   a thumbnail grid of candidate images with per-image keep/drop + a filter-rule form
   (min size, selector, position); paging-mechanism selector with the honest "needs a new
   mechanism" notice. Text/fields as the secondary tab (toggle fields/values). Per-recipe
   **output options** (cbz/pdf/loose, quality, Drive on/off) live here. Save recipe.
   (Approved flow: `builder-v3.html`; to be re-skinned vintage and reworked image-first.)
4. **Settings / Google Drive** — Drive connection status & destination; general prefs
   (theme, grain toggle).

### 8.1 Decisions settled during review (builder's calls, not open questions)
- **One active run at a time** in v1 (engine is sequential, single browser session);
  additional runs queue.
- **Recipe bound per-run** (operator selects it when creating the run); resolver uses the
  bound recipe, not first-match-by-URL.
- **"Add to existing run"** = a stopped/resumable run only (no live-append in v1).
- **"Flag for review"** is lightweight: a run-item marker when a required field/image
  rule captures nothing or an unexpected count; surfaced as a filter on the run.
- **Per-run/recipe output options** (format, quality, Drive on/off) live on the recipe
  with editable defaults, shown in the builder.

## 9. What's left to the builder

- Exact SQLite schema for projects/recipes, runs, run-items (and migration approach).
- The structured event schema and the WebSocket message contract (and whether to use
  WS or SSE — WS assumed).
- The precise recipe data model (how selectors, image-selection rules, detection scope,
  content type, and pipeline/mechanism map from the current code profile shape to data).
- API surface details (routes, request/response Zod schemas).
- The builder's live-preview rendering mechanism (Playwright screenshot + element-map
  overlay vs. simpler detect-and-toggle for v1).
- Test strategy (Vitest + Testing Library on the SPA; Node tests for the new engine
  seams and the server).
- Whether the dev setup is one combined script or two processes; packaging for "one
  command to run."
- Final vintage skin of the builder and settings screens (home screen is pinned).

---

## Appendix A — engine reference (for implementers)

- Entry: `scrape.mjs`; config/flags in `src/config.mjs` (`DEFAULTS`, `parseArgs`,
  `buildConfig`, `validateConfig`).
- Batch loop: `BatchRunner._runJobs()` in `src/pipeline.mjs` (sequential; SIGINT stop).
- Sources: `src/sources.mjs` (`UrlSource`, `SheetSource`, `createJobSource`).
- Profiles (recipes as code): `src/profiles/*.mjs`, `registry.mjs` (`resolveProfile`).
- Strategies/mechanisms: `src/strategies/registry.mjs`.
- Text v2: `src/text/acquire.mjs` (`acquireAndExtract`, HTTP-first), extractors in
  `src/text/extractors/` (`article`/`pattern`/`selector` via `registry.mjs`),
  `src/text/scrape-text.mjs`, `src/text/records.mjs` (`RecordWriter`).
- Cache: `src/cache.mjs` (`PageCache`, per-job `index.json`).
- Breaker: `src/breaker.mjs` (per-domain, in-memory, per-run).
- Drive: `src/drive.mjs` (`DriveUploader`), `authorize.mjs` (OAuth, writes `token.json`).
- Logger (the injection seam): `src/logger.mjs` (`createLogger`).
