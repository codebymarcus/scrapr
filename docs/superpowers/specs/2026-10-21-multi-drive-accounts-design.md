# Multiple Google Drive Accounts, Per-Run Selection: Design

**Date:** 2026-10-21
**Status:** Approved (design); plan to follow

## Intent and Why

Today the dashboard connects exactly one Google Drive account. The OAuth token
is stored under a single fixed key and every function that touches Drive assumes
that one account: connecting a second account would overwrite the first. An
operator who wants some runs to upload to one Drive (say, running low on storage)
and others to a different account cannot do it.

This work lets the operator connect several Google Drive accounts in Settings,
give each a label, and pick which one a run uploads to when they create it. It is
the smallest version that delivers that: manual, explicit account choice per run,
no automatic routing or quota balancing.

## Goals

- **Connect multiple Drive accounts.** Settings shows a list of connected Drive
  accounts (cards), each with a label and the Google account's email, a Disconnect
  action, and a "Connect another Drive" action that runs the Google sign-in again
  for a different account and adds it alongside the existing ones.
- **Each account has a label.** The label defaults to the account's email
  (captured at sign-in) and is renameable in Settings. (Confirmed with the user.)
- **The existing connected Drive is preserved.** On upgrade, the one account
  already connected becomes the first card automatically. No reconnect required to
  keep uploading.
- **Per-run account selection.** When "Upload to Drive" is on, the New Run form
  shows a "Drive account" dropdown listing the connected accounts; the operator
  picks one. The selection is **prefilled with the last account used for that
  project** (remembered client-side, exactly like the Drive Folder ID already is)
  and changeable per run. (Confirmed with the user.)
- **A run uploads only to its chosen account.** Scrape-time upload and the
  existing on-demand / bulk re-upload all use the run's selected account.
- **Disconnected account is a visible failure, not a silent fallback.** If a run's
  chosen account is gone or its token is invalid when a row tries to upload, that
  row surfaces an upload error (the row is still "completed", files kept locally,
  re-uploadable once the account is reconnected) and never silently uploads to a
  different account. (Confirmed with the user.)

## Non-Goals

- **Automatic routing / quota balancing / round-robin across accounts.** The
  operator chooses the account; the app never splits one run's uploads across
  accounts or picks an account on its own.
- **Per-project or per-recipe default account configuration stored on the server.**
  The remembered selection is the same lightweight client-side, per-project memory
  the Folder ID already uses, not a new server-side project setting.
- **Moving or copying existing Drive files between accounts.**
- **Multiple OAuth client apps.** All accounts authorize through the same
  env-configured Google OAuth client; only the per-account *tokens* differ.
- **Changing text runs' Drive behavior.** Text runs never upload; the account
  selector appears only where Drive upload applies (image runs), as today.

## Anti-Goals (failure even if it "works")

- Connecting a second account silently overwriting or disconnecting the first
  (the current single-key behavior).
- A run uploading to the wrong account because the selection wasn't carried
  through to scrape-time upload and on-demand re-upload consistently.
- A row silently uploading to a fallback account when its chosen account is
  unavailable (masking the problem).
- Account tokens stored unencrypted, or an account's token readable as plaintext
  from the store (the current encryption-at-rest guarantee must hold per account).
- The upgrade dropping or orphaning the already-connected account so existing
  projects' uploads break.
- A disconnect or rename that can't tell accounts apart (acting on "the" account).

## Constraints

- Build on the existing stack: Fastify 5 + better-sqlite3 + zod server (Node ESM),
  React 19 + TanStack Query + SCSS-module web, `googleapis` OAuth. Tests:
  `node:test` (server), Vitest (web). Pristine test output. No em dashes in any
  code strings or comments (project style rule).
- Tokens stay **encrypted at rest** (AES-GCM via `encryptSecret`/`decryptSecret`,
  key from `APP_SECRET_KEY`), per account, exactly as the single token is today.
  The store sees only opaque blobs.
- One env-configured OAuth client (`GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI`) authorizes every
  account. `createDriveAuth` is still a single injected service, wired once in
  `server.mjs` and shared by the drive routes and run routes.
- `DriveUploader` (`src/drive.mjs`) stays **account-agnostic**: it already accepts
  injected in-memory credentials per call, so it needs no change. All the new work
  is in storage, the auth service, the routes, run-config resolution, and the UI.
- Migrations are additive (new numbered migration), never edits to existing ones.
- The CSRF `state` cookie protection on the OAuth connect/callback stays.

## The How, decisions made

### 1. Storage: a `drive_accounts` table

Add an additive migration for a `drive_accounts` table: `id` (**the Google
account id, the `sub` claim from the OAuth `id_token`; decided below**),
`label` TEXT, `email` TEXT, `token` (the encrypted token blob, same format the
single `drive_token` secret holds today), `created_at`. Exact column names are the
builder's call; the capability is one row per connected account, holding its
label, email, and encrypted token.

**Account id = the Google account `sub` (decided, resolves builder-check #2).**
Using Google's stable per-account id (not a random id) is what makes "re-uploadable
once the account is reconnected" actually hold: a run stores `driveAccountId` and
re-uploads against it, and reconnecting the same Google account must resolve to the
**same** id so historical runs keep working. It also makes reconnect/dedupe free:
connecting an already-connected Google account upserts the same row (refreshes its
token in place) rather than creating a duplicate card. A random id would orphan
every historical run whose account was ever disconnected-and-reconnected, and would
duplicate cards for one account.

The old single `secrets` row keyed `"drive_token"` is retired in favor of this
table (see Migration, below). The `secrets` table itself stays for everything
else that uses it.

### 2. `createDriveAuth` gains an account dimension

`drive-auth.mjs` keeps its single-service shape (one env OAuth client) but its
functions take an account id and it grows a listing:

- `listAccounts()` returns `[{ id, label, email, connected }]` (connected =
  token present and decryptable). This backs the Settings list and the run-form
  dropdown.
- `exchangeCode(code)` **upserts an account by its Google `sub`**: exchange the
  code, read the account id (`sub`) and **email** from the returned `id_token`,
  and write the `drive_accounts` row for that `sub`. A first connect inserts
  (label defaults to the email); reconnecting an already-connected Google account
  updates that same row's token in place (and refreshes its email), so it neither
  duplicates a card nor clobbers a *different* account. A `label` already set by
  the operator is preserved across a reconnect.
- `getToken(accountId)` / `loadAuthConfig(accountId)` / `disconnect(accountId)`
  take the account id. `loadAuthConfig(accountId)` returns `{ clientId,
  clientSecret, token }` for that account (the shape the engine already consumes),
  or null when the account is unknown or its token won't decrypt.
- `renameAccount(accountId, label)` updates the label.
- `isConfigured()` (env client present) is unchanged and account-independent.

**Capturing the email for the default label (decided):** add `openid` and
`email` to the requested `SCOPES`, and read the email from the `id_token` Google
returns in the token response (decode its `email` claim), so no extra API call is
needed. Drive access itself is unchanged (`drive.file` stays). If the email can't
be determined, the label falls back to a generic default the operator can rename.

### 3. Routes: account-aware Drive endpoints

`routes/drive.mjs` becomes account-aware:

- `GET /api/drive/accounts` returns `listAccounts()` (plus the env `configured`
  flag). This supersedes the single-object `/status` for the list view; keep a
  `configured`/not-configured signal so the UI can still show "set up OAuth first".
- `POST /api/drive/connect` starts the OAuth flow (unchanged CSRF `state`); the
  callback **adds** an account, or refreshes it in place if that Google account is
  already connected (the `sub` upsert above). This same flow doubles as "reconnect
  an expired account": reconnecting the same account restores its token under the
  same id, so historical runs pointed at it can upload again. A per-card
  **Reconnect** affordance in Settings (which just runs this flow) is a nice-to-have.
- `GET /api/drive/callback` exchanges the code and upserts the account row.
- `POST /api/drive/accounts/:id/disconnect` removes that account's row.
- `PATCH /api/drive/accounts/:id` (or similar) renames the account's label
  (validated, non-empty, length-bounded).

The exact route shapes/verbs are the builder's call; the set of capabilities
(list, connect-adds, disconnect-one, rename-one) is required. CSRF protection on
connect/callback is preserved.

### 4. Run binding: `driveAccountId` carried end to end

The run's chosen account is a per-run override, resolved to credentials wherever
an upload happens:

- **Schema / overrides:** add `driveAccountId` (string) to the run `overrides`
  (`createRunSchema.overrides` and the web `RunOverrides` type). It is stored in
  `overrides_json` alongside `driveFolder` etc.
- **Scrape-time upload:** where the run's engine config is built
  (`build-run-config.mjs`, via `run-manager`), resolve
  `driveAuth.loadAuthConfig(overrides.driveAccountId)` instead of the account-less
  call, and inject it as `config.driveAuth`. A run with Drive on but an
  unresolvable account produces the upload error path (below), not a fallback.
- **On-demand / bulk re-upload:** `upload-item.mjs` (and the `/upload`,
  `/upload-pending` routes) rebuild the uploader with
  `loadAuthConfig(run.overrides.driveAccountId)`, so a re-upload goes to the same
  account the run chose.
- **Unavailable account, handled server-side so the engine stays unchanged and no
  file-credential fallback is reachable (decided, resolves builder-check #1).**
  There are two moments an account can be unavailable; both end at "scrape
  complete, not uploaded, re-uploadable, no silent fallback", the way the user
  decided:
  - **Unavailable at run start** (the chosen account was disconnected before the
    run executes): the run manager resolves `loadAuthConfig(driveAccountId)` when
    it builds the engine config. If it is null, it **does not pass `drive: true`
    with a null `driveAuth`** (that is exactly what would make `DriveUploader.create`
    fall back to the repo-root `credentials.json`/`token.json` files, the silent
    fallback anti-goal, or fail the whole run). Instead it **turns Drive off for
    this engine run** and records a run-level reason ("chosen Drive account
    unavailable; rows not uploaded, reconnect the account and re-upload"). The
    scrapes run, files are kept locally (cleanup already refuses to delete without a
    successful upload), every row is `complete`/`done` with `uploaded: false`, and
    the rows are re-uploadable via the on-demand path (which already resolves the
    account and already returns a clean "unavailable" error until it is
    reconnected). This needs no change to `src/`; only run-config resolution and a
    run-level note.
  - **Disconnected mid-run** (the account was valid at start, revoked while the run
    is going): the uploader was created with that account's real credentials, so a
    subsequent per-row `uploadFile` throws (e.g. a 401), which the existing
    `scrapeJob` path already catches as a per-row `uploadError`, so the row stays
    complete, `uploaded: false`, files kept, re-uploadable. No new handling needed.
  In both cases no other account is ever used. The decided outcome is reached
  without touching the engine (`src/drive.mjs` stays account-agnostic, `pipeline.mjs`
  unchanged); the only requirement is that the run manager never hands the engine
  `drive: true` with credentials it could not resolve.

### 5. Migration: adopt the existing account

The numbered SQL migration only creates the `drive_accounts` table. The **data
seed runs in JS** (server startup or lazily on the first accounts read), because
copying the legacy token needs the app, not the pure-SQL runner (resolves
builder-check #3). No decryption is needed: the encrypted blob is copied
as-is. If the legacy `secrets` row `"drive_token"` exists and `drive_accounts` is
empty, seed one row from it: reuse its encrypted token as-is (no re-auth), and
default its label.

**The migrated account has no Google `sub`** (the legacy token was obtained with
`drive.file` scope only, so there is no `id_token`/email/`sub` to read). So it gets
a **stable generated id** (not a `sub`) and a generic, operator-renameable label,
and its email is blank until reconnected. It keeps working immediately because
existing runs carry no `driveAccountId` and resolve via the single-account
back-compat rule (below). Its `sub`/email populate when the operator uses that
card's **Reconnect** (which, unlike "Connect another Drive", carries the target
account id in the OAuth `state` and updates *that* row in place, so reconnecting the
migrated account enriches it rather than spawning a duplicate card). Store the
`sub` as its own column so a later "Connect another Drive" of the same Google
account can dedupe onto an existing row. Then the legacy `"drive_token"` secret is
removed. The seed is idempotent (a present `drive_accounts` row means it already ran).

**Run back-compat:** existing runs have no `driveAccountId` in their overrides.
When a run (or a re-upload) has Drive on but no `driveAccountId`, resolve to the
**single remaining account when exactly one is connected** (the migrated one), so
old runs keep working; when zero or more-than-one accounts exist and none is
specified, it is the unavailable-account error path (nothing to guess). The web
prefills the dropdown for new runs so this gap only affects pre-existing runs.

### 6. Frontend

- **Settings** (`features/settings/`): replace the single `DriveStatusCard` with a
  list of account cards (label, email, Disconnect, inline rename) plus a "Connect
  another Drive" action, driven by `GET /api/drive/accounts`. Keep the
  not-configured state (OAuth env missing) and the connect/disconnect flows,
  extended to the account dimension.
- **New Run form** (`NewRunDialog`): when Drive upload is on, add a "Drive account"
  `Select` listing the connected accounts (label + email), prefilled from a new
  per-project client-side memory (mirroring `use-drive-folder-store`:
  `projectId -> driveAccountId`), falling back to the only connected account. Its
  value flows into `buildOverrides()` as `driveAccountId`. If no accounts are
  connected, the control guides the operator to Settings (and upload can't be on).
- **Per-project memory:** a small zustand + localStorage store like the existing
  Drive-folder store, remembering the last `driveAccountId` per project and saved
  on run creation.

## Left to the builder

- `drive_accounts` column names and whether the token column reuses the exact
  secret-blob format. (The id strategy is decided: Google `sub` for accounts
  connected with the new scopes, a stable generated id for the migrated legacy
  account, plus a `sub` column for dedupe.)
- The mechanism for a card-scoped "Reconnect" carrying the target account id
  through the OAuth `state` (versus "Connect another Drive" which dedupes by `sub`),
  and the CSRF `state` encoding that holds both the anti-forgery token and the
  optional target id.
- The precise route shapes/verbs for list/connect/disconnect/rename and their zod
  schemas; whether `/api/drive/status` is kept as a thin compatibility shim or
  fully replaced by `/accounts`.
- How the email claim is read from the `id_token` (a tiny JWT-payload decode vs a
  `googleapis` helper), and the generic fallback label text.
- Where account resolution lives so scrape-time upload and on-demand upload share
  one code path (avoid two copies of "overrides.driveAccountId -> loadAuthConfig").
- The exact reason string/status surfaced for an unavailable-account upload failure,
  and whether to show the chosen account's label on the run card / items table (a
  nice-to-have the user raised but left open; builder may add it if cheap).
- Settings card layout and the rename interaction; the dropdown's empty/one/many
  states; disabling upload when no account is connected.
- Tests (TDD): multi-account storage round-trips encrypted per account; connect
  adds rather than overwrites; disconnect/rename target one account; migration
  seeds exactly one account from a legacy token and is idempotent; a run resolves
  and uploads to its `driveAccountId`; an unavailable account yields the
  upload-error path (not a fallback, scrape still complete); the run-form dropdown
  prefills per project and threads `driveAccountId` into overrides.

## Key files (orientation)

- Server: `dashboard/server/src/drive-auth.mjs` (account dimension + email
  capture), `routes/drive.mjs` (account routes), `db/{migrations,store}.mjs`
  (`drive_accounts` table + migration), `build-run-config.mjs` and
  `run-manager.mjs` (resolve `driveAccountId` to creds), `upload-item.mjs` +
  `routes/runs.mjs` (on-demand/bulk re-upload by account), `schemas.mjs`
  (`overrides.driveAccountId`), `server.mjs`/`app.mjs` (wiring unchanged).
- Engine: `src/drive.mjs` (`DriveUploader`, unchanged, account-agnostic).
- Web: `features/settings/*` (account list UI, replaces `DriveStatusCard`),
  `features/runs/components/NewRunDialog.tsx` (account dropdown),
  `stores/use-drive-folder-store.ts` (pattern for a new per-project account
  store), `features/runs/api/runs-api.ts` + `lib/schemas.ts`
  (`RunOverrides.driveAccountId`).
