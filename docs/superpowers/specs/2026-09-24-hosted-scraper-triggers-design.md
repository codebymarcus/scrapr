# Hosted Scraper with Triggers — Design & Plan

**Date:** 2026-09-24
**Status:** Draft for review
**Author:** Mark Aquiatin (with Claude)

---

## 1. Purpose & Intent

Today the scraper (`scrape.mjs`) is a local CLI: you run it by hand on your
machine, it drives headless Chromium through a comic reader, packages the pages
into `.cbz`/`.pdf`, and uploads to Google Drive.

**Goal:** host it somewhere always reachable so a run can be *triggered* without
you opening a terminal, in two ways:

1. **Drive sheet sync** — drop or edit a link list (`.xlsx`/`.csv`) in a watched
   Drive folder, and a run starts automatically.
2. **Manual button / URL** — hit an authenticated web page or endpoint to start a
   run on demand and watch its status.

WhatsApp triggering and scheduled runs are **explicitly out of scope for v1** but
the design leaves clean seams for them (see §11).

### Agreed context (from brainstorming)

| Question | Decision |
|---|---|
| Users & scale | **Just me, occasional.** Single user, infrequent runs, cheap, idle cost near zero. |
| Triggers wanted | **Drive sheet sync + manual button/URL.** (Not WhatsApp, not scheduled — yet.) |
| Hosting preference | **Cheap VPS / Fly.io** — simple mental model, full control. |
| Link-list format | **Uploaded `.xlsx`/`.csv`** (reuses the existing reader; overwrite file back to Drive). |
| Notifications | **All three documented:** status page (core), email-on-failure (optional), Drive-as-signal (inherent). |

### Non-goals (v1)

- Multi-user auth, quotas, multi-tenant isolation.
- Public product surface. This is a single-operator tool behind a secret.
- WhatsApp / scheduled / native-Google-Sheets triggers (future, §11).
- Horizontal scaling / parallel scraping. **Concurrency is 1 by design.**

### Risk flagged (operator's call)

Hosting a comic-reader scraper on always-on infrastructure concentrates
Terms-of-Service / copyright exposure compared with running it locally and
occasionally. This is your decision to accept; it is recorded here, and
operational mitigations (private access only, no public listing, respectful
pacing already built into `settle`/`jitter`/`itemDelay`) are noted in §9.

---

## 2. Guiding Principles

- **Reuse the existing engine unchanged.** `BatchRunner` / `scrapeJob` /
  `src/*` already do the hard part (capture, cache, package, Drive upload,
  status column). The hosting layer *wraps* it; it does not rewrite it.
- **The spreadsheet status column is the source of truth for idempotency.**
  `skip`/`done`/`retry`/blank already control what gets crawled
  (`src/pipeline.mjs:skipReason`). We lean on it instead of inventing a second
  dedup system.
- **One job at a time.** Chromium is memory-heavy and occasionally leaks; a
  single-worker queue keeps a $5 box stable and predictable.
- **Scraper runs as a subprocess per job**, not in-process. A crash, memory
  leak, or hung page tears down with the child process and frees all resources;
  the service stays up. (Trade-off in §5.)
- **Swappable triggers.** Drive-watching, the manual endpoint, and any future
  WhatsApp/cron trigger all funnel into the *same* `enqueue(job)` call.

---

## 3. Chosen Architecture (Approach A)

A single small Node service running 24/7 on a cheap always-on box (Hetzner
CX22 / DigitalOcean basic droplet / a Fly Machine left running). It contains
four cooperating parts in one process, plus a persistent disk.

```
                 ┌──────────────────────────────────────────────────┐
                 │                  VPS / Fly Machine                 │
   HTTPS  ─────► │  ┌───────────┐   enqueue   ┌──────────────────┐   │
 (you, browser)  │  │  Web API  ├────────────►│   Job Queue      │   │
                 │  │ + status  │             │  (SQLite table)  │   │
                 │  │   page    │             └────────┬─────────┘   │
                 │  └───────────┘                      │ dequeue     │
                 │  ┌───────────┐   enqueue            ▼             │
  Google Drive ◄─┼─►│  Drive    ├──────────►  ┌──────────────────┐  │
   (poll + I/O)  │  │  Poller   │             │  Worker (1x)     │  │
                 │  └───────────┘             │  spawns:         │  │
                 │                            │  node scrape.mjs │  │
                 │  ┌──────────────────────┐  │  --list <file>   │  │
                 │  │ Persistent volume    │◄─┤  --config ...    │  │
                 │  │  /data/cache  (resume)│  └────────┬─────────┘  │
                 │  │  /data/work   (sheets)│           │ uploads    │
                 │  │  /data/app.db (queue) │           ▼            │
                 │  └──────────────────────┘     Google Drive       │
                 └──────────────────────────────────────────────────┘
```

### Why this over the alternatives

- **vs. Fly scale-to-zero + Drive push webhook (Approach B):** push
  notifications need a public HTTPS endpoint with domain verification and a
  **watch-channel renewal cron** (channels expire ~weekly). Cold-start wake on
  each trigger adds latency. For *occasional personal* use the savings over a $5
  always-on box don't justify the extra moving parts. **Polling is simpler and
  fits.** The design keeps push as a drop-in upgrade (§11).
- **vs. home server + tunnel (Approach C):** you ruled it out; depends on your
  machine being awake.

---

## 4. Components

### 4.1 Web API + status page
- **Framework:** minimal — Node's built-in `http`, or a thin layer (Fastify).
  No heavy framework needed.
- **Endpoints:**
  - `GET /` → status page (HTML): active job, queued jobs, last N runs with
    outcome, page counts, bytes, Drive links, tail of logs.
  - `POST /runs` → manual trigger. Body: either a Drive file ID of an uploaded
    list, or an inline URL / list of URLs. Returns a `runId`.
  - `GET /runs/:id` → JSON status + log tail for one run (used by the page and
    for scripting).
  - `POST /drive/webhook` → **reserved, not wired in v1** (placeholder for the
    push-notification upgrade).
- **Auth:** single shared secret. A long random bearer token (header
  `Authorization: Bearer <token>`) for the API, and a signed cookie / same token
  as a query param for the browser page. HTTPS only. No user accounts.

### 4.2 Drive poller
- Runs on an interval (default **every 5 min**, configurable).
- Uses Drive `changes.list` with a saved **page token** (durable in
  `app.db`) so it sees only what changed since last poll — cheap and precise.
- Filters to the **watched folder** and to `.xlsx`/`.csv` files.
- For each new/modified list file, **enqueues a job** keyed by
  `(fileId, modifiedTime/revisionId)` so the same revision is never processed
  twice (dedup at the queue layer; the status column dedups at the row layer).
- **Cold start / first run:** initialise the change token to "now" so we don't
  reprocess the whole folder history on first boot; a manual "scan folder now"
  action on the status page seeds existing files intentionally.

### 4.3 Job queue (SQLite)
- One table: `jobs(id, source, payload_json, state, attempts, created_at,
  started_at, finished_at, result_json, log_path)`.
- States: `queued → running → done | failed`.
- SQLite (via `better-sqlite3` or node's built-in `node:sqlite`) is plenty for a
  single-user serial queue — no external broker, survives restarts, lives on the
  persistent volume.
- Enqueue is called identically by the poller and the manual endpoint.

### 4.4 Worker (single)
- Polls the queue for the next `queued` job, marks it `running`.
- **Downloads** the list file from Drive into `/data/work/<runId>/list.xlsx`
  (for Drive-sourced jobs), or writes the inline URLs to a temp list.
- **Spawns** `node scrape.mjs --list <file> --config /data/scraper.config.json`
  as a child process, streaming stdout/stderr to a per-run log file
  (`/data/logs/<runId>.log`) — reuses the existing `logFile` capability too.
- On success, if the list file came from Drive and its status column changed,
  **re-uploads** the updated file, overwriting the same Drive file ID.
- Records outcome (exit code, saved/total counts parsed from the summary, bytes)
  into `jobs.result_json`; sets `done`/`failed`.
- **Resumability:** the persistent `/data/cache` volume means an interrupted run
  (box reboot, crash) re-runs the same job and the scraper's existing page cache
  continues instead of re-downloading (`src/cache.mjs`, `--cache`).

### 4.5 Persistent storage (`/data` volume)
| Path | Contents | Why it must persist |
|---|---|---|
| `/data/app.db` | queue + Drive change token + processed-revision log | restart safety, dedup |
| `/data/cache` | scraper resume cache | resume interrupted downloads |
| `/data/work` | downloaded list files, scratch | in-flight jobs |
| `/data/logs` | per-run logs | status page history |
| `/data/scraper.config.json` | hosting config profile | drive on, cleanup on, etc. |
| secrets | OAuth `credentials.json` + `token.json` | Drive auth (see §7) |

### 4.6 Notifications (all three, per your instruction)
- **Status page (core):** always built. Pull-based; the primary way you see
  results, queue depth, and logs.
- **Email on failure (optional module):** a small notifier interface with a
  no-op default and an SMTP/API implementation (e.g. Resend, SendGrid, or plain
  SMTP). Fires only on `failed` runs or per-link `retry` outcomes. Enabled via
  config; disabled ⇒ zero setup.
- **Drive-as-signal (inherent):** the packaged files simply appearing in your
  Drive folder is itself a completion signal for the happy path; no code needed.

The notifier is a single interface (`notify(event)`) so WhatsApp / push can be
added later as just another implementation.

---

## 5. Key Design Decisions & Trade-offs

| Decision | Choice | Trade-off / rationale |
|---|---|---|
| Compute lifecycle | Always-on cheap box | ~$5/mo vs true $0. Buys no cold start, no webhook/domain verification, no channel renewal. |
| Drive watching | **Poll** (`changes.list` + token) | Few-min latency, irrelevant for occasional use; far fewer moving parts than push. Push is a documented upgrade. |
| Scraper invocation | **Subprocess per job** | Slight overhead + must parse summary from logs, but full isolation and resource reclamation; a Chromium leak can't take down the service. |
| Concurrency | **1 worker** | No parallelism, but stable memory on a small box and polite to target sites. |
| Queue store | **SQLite on volume** | No external broker; simple, durable, single-writer-friendly. |
| List format | **Uploaded `.xlsx`/`.csv`** | Reuses `src/sources.mjs` + `src/reader.mjs` unchanged; write-back = overwrite same Drive file ID. No Sheets API scope. |
| Idempotency | **Status column + revision dedup** | Reuses existing `skipReason` logic; poller adds revision-level dedup so re-saves don't double-run. |
| Auth | **Single shared bearer token** | Right-sized for one operator; no account system to build/secure. |

---

## 6. Data Flow

### 6.1 Drive sheet sync
1. You upload/edit `links.xlsx` in the watched Drive folder.
2. Poller's next tick sees the change via `changes.list`; the file is a new
   `(fileId, revision)` ⇒ **enqueue**.
3. Worker downloads the file, spawns `scrape.mjs --list links.xlsx`.
4. Scraper crawls only blank/`retry` rows, packages, uploads outputs to Drive,
   writes `done`/`retry` into the status column of the local copy.
5. Worker re-uploads the updated `links.xlsx` (same file ID) so the sheet in
   Drive reflects progress and won't re-run finished rows.
6. Status page shows the run; on failure, email fires (if enabled).

### 6.2 Manual run
1. You open the status page (or `POST /runs`) with the shared token.
2. You pick an existing Drive list file **or** paste one/more URLs.
3. Same enqueue → worker → scrape path. Inline URLs skip the download/re-upload
   steps and just run + upload results.

---

## 7. Secrets & Configuration

- **Google OAuth:** the existing `credentials.json` (OAuth *Desktop app* client)
  and `token.json` from `authorize.mjs` are mounted as **secret files** (Fly
  secrets / VPS file with `600` perms outside the repo), never baked into the
  image or committed. `.gitignore` already excludes `token.json` /
  `credentials.json` — verify before first deploy.
- **Token refresh:** confirm the stored token includes a **refresh token** so
  the long-lived service can refresh access without re-running the interactive
  `authorize.mjs`. If not, re-run `authorize.mjs` once locally with
  `access_type=offline` / `prompt=consent` and deploy the resulting token. (This
  is the single most likely operational snag — call it out in the runbook.)
- **App secrets:** API bearer token, SMTP creds (if email on), watched folder
  ID, poll interval — via environment variables / Fly secrets.
- **Hosting config profile** (`/data/scraper.config.json`): `drive: true`,
  `cleanup: true` (so the box doesn't fill up), `pdf`/`cbz` as desired,
  `driveFolder`/`driveSubfolder`, sensible `settle`/`jitter`/`itemDelay`.

---

## 8. Deployment & Infrastructure

### 8.1 Container image
- Base: an image that already ships Playwright's Chromium + system libs
  (`mcr.microsoft.com/playwright:v1.48-jammy` or run
  `playwright install --with-deps chromium` in the build). This avoids the
  classic "missing shared library" headless-Chromium failures.
- Copy the repo, `npm ci`, set entrypoint to the **new hosting service**
  (`server.mjs`), not `scrape.mjs`.
- Declare the `/data` volume mount.

### 8.2 Target: Fly.io Machines (recommended concrete host)
- One app, one Machine (shared-cpu-1x, 512MB–1GB RAM — Chromium wants headroom;
  start at 1GB), one **Fly Volume** mounted at `/data`.
- `fly secrets set` for OAuth files (as base64) + app secrets.
- Keep the Machine running (don't enable auto-stop in v1) for the poller.
- HTTPS + a `*.fly.dev` hostname out of the box ⇒ no TLS setup.
- **Alternative (Hetzner/DO VPS):** Docker + a systemd unit or `docker compose`,
  Caddy for automatic HTTPS, a mounted data directory. Slightly more sysadmin,
  a bit cheaper, same architecture.

### 8.3 Estimated cost
- Compute: **~$3–6/mo** (Fly shared-cpu-1x 1GB left on, or a small VPS).
- Volume: a few GB, **~$0.15–1/mo**.
- Egress/bandwidth: usage-driven; `cleanup: true` + Drive offload keep disk flat.
- **Total ≈ $5/mo**, effectively flat regardless of run frequency.

---

## 9. Reliability, Safety & Operations

- **Crash/restart:** service restarts (systemd/Fly) → worker re-picks a
  `running` job left mid-flight (reset to `queued` on boot) → scraper resumes
  from `/data/cache`.
- **Disk safety:** `cleanup: true` deletes local artifacts only after a
  successful Drive upload (existing behaviour, `src/pipeline.mjs`), so the box
  won't fill. A periodic sweep of `/data/work` + old `/data/logs` caps growth.
- **Politeness / ToS:** access is private (bearer token, unlisted host); the
  scraper's built-in pacing (`settle`, `jitter`, `itemDelay`) is kept at
  respectful defaults; concurrency 1 avoids hammering sources. Copyright/ToS
  acceptance is the operator's; recorded in §1.
- **Poller robustness:** persist the change page token; on token loss, re-seed
  from "now" (never mass-reprocess history).
- **Secrets hygiene:** OAuth files mounted read-only, `600`, outside the image;
  bearer token rotatable via a single secret change.

---

## 10. Phased Implementation Plan

Each phase is independently shippable and testable. TDD throughout; the existing
`test/` suite stays green and new units get their own tests.

### Phase 0 — Prep (no hosting yet)
- Confirm `.gitignore` excludes secrets; confirm OAuth **refresh token** works
  headlessly (re-`authorize.mjs` with offline consent if needed).
- Extract a clean programmatic entry if convenient (the worker can just spawn the
  CLI, so this is optional).
- **Exit:** a documented, headless, non-interactive `scrape.mjs --list` run that
  uploads to Drive on your machine with the intended hosting config.

### Phase 1 — Core service skeleton
- `server.mjs`: HTTP server, bearer-token auth, `POST /runs`, `GET /runs/:id`,
  `GET /` status page (server-rendered, minimal).
- SQLite queue module (`enqueue`, `claimNext`, `finish`) + tests.
- Single worker loop that spawns `scrape.mjs` for an **inline-URL** job, streams
  logs to `/data/logs/<runId>.log`, records outcome.
- **Exit:** hit the URL locally → a real scrape runs → status page shows it.

### Phase 2 — Drive integration
- Drive download of a list file by ID into `/data/work`.
- Write-back: overwrite the same Drive file ID with the updated status column.
- `POST /runs` accepts a Drive `fileId`.
- **Exit:** manual run against a Drive-hosted `.xlsx` end to end, status column
  updated in Drive.

### Phase 3 — Drive poller (the "sync" trigger)
- `changes.list` + persistent page token; folder + extension filter; revision
  dedup; enqueue.
- "Scan folder now" button on the status page.
- **Exit:** edit a sheet in Drive → within the poll interval a run starts
  automatically and results land in Drive.

### Phase 4 — Notifications & polish
- Notifier interface + no-op default; email-on-failure implementation behind
  config.
- Status page: queue depth, history, log tail, per-link outcomes.
- Log/work sweeper.
- **Exit:** a failing run produces an email (when enabled); page shows history.

### Phase 5 — Deploy
- Dockerfile (Playwright base) + `/data` volume; Fly app + volume + secrets (or
  VPS + Caddy + systemd).
- Runbook: deploy, rotate token, re-auth Google, read logs, force a scan.
- **Exit:** triggered from your phone's browser and via a Drive edit, in prod.

---

## 11. Future Extensions (designed-for, not built)

- **WhatsApp trigger:** add a `POST /whatsapp/webhook` (WhatsApp Cloud API or
  Twilio) that parses a URL/`run` message and calls the same `enqueue(job)`;
  replies with the run link. Notifier already abstracts outbound messages.
- **Scheduled runs:** a cron entry (systemd timer / Fly scheduled Machine / node
  cron) that enqueues "process pending rows" over a known list — no new core.
- **Drive push notifications (Approach B):** wire `POST /drive/webhook`
  (already reserved), add domain verification + a channel-renewal timer, and
  optionally enable Machine auto-stop for true scale-to-zero.
- **Native Google Sheets lists:** add Sheets API scope; read/write the status
  column in a live Sheet instead of an uploaded file.
- **Parallelism:** raise worker count / add a second Machine if volume ever
  grows — the queue already supports it, but stays at 1 for v1.

---

## 12. Open Questions to Resolve Before Build

1. **Google token refresh** — does your current `token.json` carry a refresh
   token? (Determines whether Phase 0 needs a one-time re-auth.)
2. **Fly.io vs VPS** — both fit; Fly is faster to stand up with HTTPS + volume,
   a VPS is marginally cheaper. Default assumption: **Fly**.
3. **Email provider** — if email-on-failure is wanted at launch, which sender
   (Resend / SendGrid / SMTP)? Otherwise ship the no-op and add later.
4. **Watched folder** — confirm the exact Drive folder ID to watch and whether
   outputs go to a different folder than inputs.
```
