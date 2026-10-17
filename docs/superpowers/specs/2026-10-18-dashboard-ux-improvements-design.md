# Dashboard UX Improvements — Design

**Date:** 2026-10-18
**Status:** Approved (design); plan to follow

## Intent & Why

The dashboard today lets a user run scrapes, but three things make it hard to
operate with confidence:

1. **Google Drive authentication is terminal-only.** Connecting Drive means
   dropping to a shell and running `node authorize.mjs`, which also requires a
   `credentials.json` OAuth client file and writes a `token.json` to disk. A
   dashboard user shouldn't have to touch the filesystem or a terminal to
   connect their Drive.

2. **A running scrape is a black box.** The user sees only an aggregate
   progress bar ("N of M items"). They cannot see which row is running, what
   step it's on, or — most importantly — whether results are actually being
   uploaded to Drive. In one real session the user watched the bar reach 50%,
   checked Drive, found nothing, and had no way to tell whether uploads were
   failing or simply weren't configured. (They weren't configured — see below.)

3. **Scrape config can't be adjusted per run.** All scrape behavior lives in a
   project's "recipe" (edited in the separate Builder screen). The New Run
   dialog only asks for project + label + URLs, so the user can't, e.g., turn
   Drive on for a single run or send one run to a different folder without
   permanently editing the project.

A contributing root cause tying #2 and #3 together: in the dashboard, per-row
Drive upload only happens when the chosen project's recipe has `output.drive:
true` (and only for image recipes — text recipes never wire Drive). The engine
uploads per-row exactly like the CLI; the dashboard just silently skips upload
when the recipe doesn't opt in. The "nothing in Drive at 50%" incident was a
run whose recipe didn't have Drive enabled. The live console (#2) makes this
visible; the per-run override (#3) makes it controllable.

## Goals

- Connect Google Drive entirely from the dashboard UI via a "Connect Google
  Drive" button that runs the OAuth flow in the browser.
- Stop storing Drive credentials/tokens as loose files. Store the OAuth client
  as environment variables; store the resulting token encrypted at rest in the
  database.
- Give each run a live, terminal-style console that streams the scrape
  play-by-play in real time: current row, step progress, Drive upload
  confirmations, and errors.
- Let the user override a project recipe's Drive settings (on/off, folder,
  subfolder) at new-run time, applying only to that run.

## Non-Goals

- Changing the scrape engine's core execution or the per-row upload behavior in
  `src/pipeline.mjs` / `src/drive.mjs` (beyond making the Drive client source
  its token from the new store). The engine already does the right thing.
- Reworking the Builder/recipe editor. Recipes remain the source of project
  defaults.
- Per-run overrides for output format, image/text rules, concurrency, or row
  limits. Only Drive on/off + folder/subfolder are overridable per run. Others
  stay as project defaults.
- Multi-user accounts, per-user Drive tokens, or OS-keychain storage. This is a
  single self-hosted dashboard bound to 127.0.0.1; one Drive connection for the
  instance is sufficient.
- Persisting a durable run-log history to disk/DB. The console streams live
  events; replay of a full run's log after the fact is out of scope (see "Left
  to the builder" for the modest buffering decision).

## Anti-Goals (what would make this a failure even if it "works")

- A "Connect" button that still silently depends on a `credentials.json` file
  on disk, or that leaves a plaintext token anywhere.
- A console that only shows generic "working…" noise rather than the real
  per-row / upload signals the engine already emits.
- Per-run overrides that quietly mutate the project recipe (so the "override"
  leaks into future runs).
- Any regression to the existing CLI path, which must keep working with its
  current `credentials.json` / `token.json` files OR the new env/DB source
  (see migration note).

## Constraints

- **Stack (existing, build on it):** Engine is Node ESM (`.mjs`), Playwright,
  `googleapis` + `@google-cloud/local-auth`. Dashboard server is Fastify 5 +
  `@fastify/websocket` + `better-sqlite3` + `zod`. Web is React 19 + Vite +
  TypeScript + TanStack Query + Zustand + SCSS modules. Everything is wired
  together via Docker compose (`compose.yaml` / `compose.dev.yaml`).
- The dashboard server already imports the engine directly and already runs the
  scrape through a shared `BatchRunner`; the websocket hub + event logger
  already emit structured events. Reuse these seams rather than inventing new
  transport.
- Server binds 127.0.0.1 by default. The OAuth redirect must therefore resolve
  back to the dashboard host the user is actually browsing.

## The How — decisions made

### Feature 1: In-app Google Drive connection

**OAuth client → environment variables.** The client id/secret (today inside
`credentials.json`) become env vars read by the server, e.g.
`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, set in compose.
No `credentials.json` required for the dashboard path. (The builder decides the
exact env var names and where they're read — see `dashboard/server/src/config.mjs`.)

**Token → encrypted in SQLite.** Add a `secrets` table (migration in
`dashboard/server/src/db/migrations.mjs`). The Drive OAuth token (including the
long-lived refresh token) is stored there as an AES-256-GCM encrypted blob. The
encryption key comes from an env var (e.g. `APP_SECRET_KEY`), never stored in
the DB. A small secrets module handles encrypt/decrypt and get/set. No
`token.json` is written by the dashboard path.

**OAuth flow (web redirect, not `@google-cloud/local-auth`).** `local-auth`
spins up its own loopback server and is built for a CLI on the same machine; it
is the wrong tool for a button in a browser. Instead implement the standard web
server-side OAuth code flow with `google.auth.OAuth2`:
- `GET /api/drive/connect` → builds the Google consent URL (scope
  `https://www.googleapis.com/auth/drive.file`, `access_type=offline`,
  `prompt=consent` so a refresh token is always returned) and redirects /
  returns it to the frontend to open.
- `GET /api/drive/callback?code=…` → exchanges the code for tokens, encrypts and
  stores them in `secrets`, then returns the user to the dashboard (a small
  success page or redirect back to settings).
- The redirect URI must match what's registered on the Google OAuth client and
  must resolve to the dashboard origin the user is browsing. Builder determines
  this (an env var like `OAUTH_REDIRECT_URI` / derived from request origin) —
  flagged in "Left to the builder."

**Encryption key is optional at boot (no regression for non-Drive users).**
Today the dashboard starts with no encryption key. The `APP_SECRET_KEY` env var
must stay optional: if it's absent, the server still boots normally and Drive
simply reports as **not configured** — non-Drive users are never broken. Drive
status therefore distinguishes: *connected* (valid, decryptable token present),
*not configured* (OAuth client env vars and/or encryption key missing), and
*disconnected / needs reconnect* (a token exists but can't be decrypted — e.g.
the key changed — treated as disconnected with a "reconnect" prompt, not a crash).
Decided call.

**Status + disconnect.** `GET /api/drive/status`
(`dashboard/server/src/routes/system.mjs`) changes from "do these two files
exist" to "is there a valid token in `secrets`" (and whether the OAuth client
env vars are configured). Add a disconnect action that deletes the stored token.
Frontend: `dashboard/web/src/features/settings/DriveStatusCard.tsx` +
`use-drive-status.ts` + `api/drive-api.ts` gain the Connect and Disconnect
buttons and reflect connected/disconnected/not-configured states.

**Runtime Drive client reads the new source.** `DriveUploader.create` in
`src/drive.mjs` currently reads `credentials.json` + `token.json` from paths.
For the dashboard path it must instead build its `OAuth2` client from the env
client + the decrypted token from `secrets`. Decision: inject the credential
source into the run config the dashboard builds (`build-run-config.mjs` /
`run-manager.mjs`) rather than hard-coding file reads, so the engine stays
agnostic. The CLI path keeps working against files (back-compat). Exact shape of
the injected credential provider is left to the builder, but the engine must not
assume files when the dashboard runs it.

### Feature 2: Live terminal-style console

**Reuse the events that already flow.** The engine's `createEventLogger`
(`src/events/event-logger.mjs`) already emits, over the websocket hub, `log`
events (info/success/warn/step/section/error, including `=== (N/M) <url> ===`,
`→ uploading to Drive`, and `Drive: uploaded "<name>" (<id>)`), plus `progress`
/ `progress-end` and the run manager's `item` / `state` events. The frontend
currently **drops `log` events** (`use-run-events.ts` has `case "log": return;`).
The fix is to stop dropping them and render them.

**New console component.** There is no run-detail screen today, and only one
run executes at a time (extras queue), so the console is only ever live for the
single running run. The console is an **inline, expandable terminal panel on the
running run's card** in the Runs list (`RunCard` within
`features/runs/components/`) — no new route, no navigation; the user watches it
on the Runs page. Queued and finished runs show no console (consistent with the
"no replay" non-goal). It:
- Subscribes to the run's websocket stream (the existing `use-run-events` hook /
  cache; extend it to retain `log` events for the active run instead of
  discarding them). `useRunEvents` already runs only while a card is running,
  which fits.
- Renders a monospace, dark, scrolling feed. Each line carries its level styling
  (errors red, success green, muted dim, section headers emphasized).
- Auto-scrolls to the newest line, with a "pause auto-scroll when the user
  scrolls up" affordance.
- Shows upload confirmations prominently so "is it uploading / did it upload" is
  answered at a glance.

**Buffering.** Keep a bounded in-memory buffer of recent lines per active run on
the client (e.g. last ~1000 lines) so the console is useful without a durable
server-side log. Whether to also keep a small server-side ring buffer so a
late-joining / reconnecting client can backfill is left to the builder (see
below). No new DB table for logs.

### Feature 3: Per-run Drive overrides

**New Run dialog gains overrides.** `NewRunDialog.tsx` adds, below the existing
project/label/URLs fields, optional overrides that default to the selected
project recipe's values:
- Drive upload: on / off (toggle).
- Drive **folder ID** and **subfolder name** (shown/relevant when Drive is on).

The dialog should prefill these from the chosen project's recipe so the default
is "same as project," and visibly indicate when a value differs from the
project default.

**Only shown for image projects.** The engine uploads to Drive only on the image
packaging path; text runs never upload (`src/pipeline.mjs` text path has no
upload, and changing that is a non-goal). So the Drive override (toggle + folder
fields) is **hidden/disabled for text projects** — showing a Drive switch that
does nothing on a text run would recreate the exact "it's on but nothing
uploaded" confusion this work exists to eliminate (an anti-goal). Decided call.

**Folder field is a Drive folder ID, not a name.** `config.driveFolder` is used
by `src/drive.mjs` directly as the Drive **parent folder ID**, while
`config.driveSubfolder` is a **name** that is get-or-created under that parent.
The dialog labels the folder field as an ID (with helper text) and prefills it
from the recipe's stored ID; the subfolder field accepts a name. This matches
the scraper config as it exists today. Decided call, confirmed with the user.

**Overrides are per-run, never mutate the recipe.** `POST /api/runs` body grows
from `{ projectId, label? }` to also accept an optional `overrides` object
(e.g. `{ drive?, driveFolder?, driveSubfolder? }`), validated by zod
(`schemas.mjs` + mirrored `web/src/lib/schemas.ts`). The overrides are stored
with the run and applied at config-build time: `buildRunConfig`
(`build-run-config.mjs`) merges run overrides on top of the recipe-derived
config. The project's `recipe_json` is untouched.

**Persistence.** The overrides must survive to run execution (which may be
queued). Decision: store them on the run (e.g. a `overrides_json` column on
`runs`, migration) so a queued run applies the overrides the user chose at
creation time. Exact column vs. alternative storage left to the builder, but
overrides must be durable for queued runs and must not alter the project.

**Note on the earlier confusion:** with the Drive toggle visible at run
creation and the console showing upload lines, the "nothing in Drive"
situation becomes both visible and user-controllable.

## Left to the builder

- Exact env var names for the OAuth client, encryption key, and redirect URI,
  and where they're read (`dashboard/server/src/config.mjs`), consistent with
  existing config conventions.
- Resolving the OAuth redirect URI correctly for a 127.0.0.1 / compose setup
  (derive from request origin vs. explicit env var) and documenting what the
  user registers on their Google OAuth client.
- The precise shape of the credential provider injected into the engine so
  `DriveUploader.create` can build its client from env-client + decrypted-DB-token
  on the dashboard path while the CLI keeps using files.
- Whether to keep a small server-side ring buffer of recent log lines per active
  run for reconnect/backfill, or rely solely on the client-side buffer.
- Storage shape for per-run overrides (`runs.overrides_json` column vs.
  alternative) and the exact zod schema for the overrides object.
- Migration/back-compat for an existing `token.json` (offer a one-time import
  into the encrypted store, or simply require re-connect). Builder's call;
  re-connect is acceptable.
- All visual/styling details of the console and the dialog within the existing
  SCSS-module conventions.
- Tests: per the project's TDD workflow, covering secrets encrypt/decrypt, the
  OAuth callback storing an encrypted token, status/disconnect, the frontend
  rendering `log` events, and per-run overrides merging into run config without
  mutating the recipe.

## Key files (orientation, not prescription)

- Engine scrape loop / per-row upload: `src/pipeline.mjs`, `src/drive.mjs`
- Engine events: `src/events/event-logger.mjs`
- Auth (current, terminal): `authorize.mjs`
- Server app/routes: `dashboard/server/src/app.mjs`,
  `routes/system.mjs`, `routes/runs.mjs`, `run-manager.mjs`,
  `build-run-config.mjs`, `config.mjs`, `db/migrations.mjs`, `db/store.mjs`,
  `schemas.mjs`, `hub.mjs`, `routes/ws.mjs`
- Web: `features/settings/*` (Drive status), `features/runs/*`
  (`RunCard.tsx`, `NewRunDialog.tsx`, `hooks/use-run-events.ts`,
  `hooks/use-run-progress.ts`), `lib/schemas.ts`
