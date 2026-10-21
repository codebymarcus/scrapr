# Multiple Google Drive Accounts, Per-Run Selection: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator connect several labeled Google Drive accounts in Settings and pick, per run, which one a run uploads to, with the existing single account preserved on upgrade.

**Architecture:** Replace the single `drive_token` secret with a `drive_accounts` table (one encrypted token per account, keyed by the Google account `sub`). `createDriveAuth` grows an account dimension (list/upsert-by-sub/getToken(id)/loadAuthConfig(id)/disconnect(id)/rename). Drive routes become account-aware; the OAuth `state` optionally carries a target account id so a card-scoped "Reconnect" updates that row in place. A run carries `driveAccountId` in its overrides; the run manager resolves it to credentials and, when it can't (account gone), turns Drive off for that run so the engine never falls back to repo-root credential files and never crashes, rows stay re-uploadable. The scraping engine (`src/`) is untouched. The web gets an accounts list in Settings and a per-run account dropdown prefilled from a per-project localStorage memory.

**Tech Stack:** Node ESM, Fastify 5, better-sqlite3, `googleapis` OAuth, AES-GCM secret encryption; React 19 + TanStack Query + SCSS modules + zustand. Tests: `node:test` (server), Vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-21-multi-drive-accounts-design.md`

## Global Constraints

- **Tokens stay encrypted at rest, per account.** Reuse `encryptSecret`/`decryptSecret` (AES-GCM) with the key from `keyFromEnv(process.env)` (`APP_SECRET_KEY`). The store only ever holds opaque token blobs; a wrong/rotated key yields a "needs-reconnect"-style unreadable token, never a crash.
- **One env OAuth client** (`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI`) authorizes every account; only per-account tokens differ. `createDriveAuth` stays one injected service wired once in `server.mjs`.
- **Account id = the Google account `sub`** (read from the OAuth `id_token`) for accounts connected with the new scopes. The migrated legacy account has no `sub`, so it gets a stable generated id and a `sub` column that fills in on first reconnect. Store `sub` as its own column for dedupe.
- **Scopes:** add `openid` and `email` to the existing `https://www.googleapis.com/auth/drive.file`. Drive access is unchanged; the extra scopes only yield the `id_token` (for `sub` + `email`).
- **The scraping engine (`src/`) is not modified.** `DriveUploader` stays account-agnostic. The run manager MUST never hand the engine `config.drive === true` together with a null/unresolved `config.driveAuth`, that is exactly what makes `DriveUploader.create` fall back to repo-root `credentials.json`/`token.json` (`src/drive.mjs:74-88`) or fail the whole run.
- **Migrations are additive** (new `006_drive_accounts`); the SQL migration only creates the table. The data seed (adopt the legacy token) runs in JS, copying the encrypted blob as-is (no decryption).
- **No em dash (`—`) in any code string or comment** (project style rule). Use colons, hyphens, parentheses, or rewording.
- CSRF `state` protection on connect/callback is preserved; `state` may additionally encode an optional target account id for reconnect.
- Pristine test output; no unrelated dependencies.

## Review Focus

- **Reconnect dedupe:** connecting (or reconnecting) a Google account already connected must update that one row in place (matched by `sub`, or by the target id carried in `state`), never add a duplicate card. Test owns Task 2/3.
- **No silent file-credential fallback and no whole-run crash** when a run's chosen account is unavailable at start: Drive is turned off for that run, scrapes complete, rows are `uploaded:false` and re-uploadable, and `credentials.json`/`token.json` are never consulted. Test owns Task 4.
- **Per-account encryption round-trip and key-rotation safety:** a stored account token decrypts back to the same token; an unreadable blob (wrong key) surfaces the account as not-connected, not an exception. Test owns Task 1/2.
- **Migration runs exactly once and preserves existing uploads:** the legacy `drive_token` becomes exactly one account row and is removed; pre-existing runs (no `driveAccountId`) still resolve to that single account and upload. Test owns Task 2/4.
- **Account isolation:** disconnecting or renaming account A never touches account B's token, label, or runs. Test owns Task 2.

---

## Task 1: `drive_accounts` storage + store methods

**Files:**
- Modify: `dashboard/server/src/db/migrations.mjs` (add `006_drive_accounts`)
- Modify: `dashboard/server/src/db/store.mjs` (account CRUD methods + prepared statements)
- Test: `dashboard/server/test/store.test.mjs` (extend/create)

**Interfaces:**
- Produces: migration `006_drive_accounts` creating `drive_accounts(id TEXT PRIMARY KEY, sub TEXT, label TEXT, email TEXT, token TEXT NOT NULL, created_at TEXT)`. Store methods: `listDriveAccounts()` -> rows ordered by `created_at`/`id`; `getDriveAccount(id)`; `getDriveAccountBySub(sub)`; `upsertDriveAccount({ id, sub, label, email, token })`; `updateDriveAccountToken(id, { token, sub, email })` (sets non-null fields); `renameDriveAccount(id, label)`; `deleteDriveAccount(id)`. Consumed by Task 2.

- [ ] **Step 1: Write failing tests** (a real better-sqlite3 in-memory db migrated via `migrate`): insert two accounts and `listDriveAccounts` returns both; `getDriveAccountBySub` finds by sub; `upsertDriveAccount` with an existing id updates in place (no duplicate); `updateDriveAccountToken` changes only the token/sub/email; `renameDriveAccount` changes only label; `deleteDriveAccount` removes one and leaves the other.
- [ ] **Step 2: Run tests to verify they fail**, Run: `node --test dashboard/server/test/store.test.mjs`, Expected: FAIL (methods/table absent).
- [ ] **Step 3: Implement** the migration and the store methods (prepared statements following the existing `q.*` pattern; the public methods on the returned store object alongside `getSecret`/`setSecret`).
- [ ] **Step 4: Run tests to verify they pass**, Run: `node --test dashboard/server/test/store.test.mjs`, Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/db/migrations.mjs dashboard/server/src/db/store.mjs dashboard/server/test/store.test.mjs
git commit -m "feat(server): add drive_accounts table and store methods"
```

---

## Task 2: Account-aware `createDriveAuth` + legacy migration seed

**Files:**
- Modify: `dashboard/server/src/drive-auth.mjs`
- Test: `dashboard/server/test/drive-auth.test.mjs` (extend/create)

**Interfaces:**
- Consumes: Task 1 store methods; `encryptSecret`/`decryptSecret`.
- Produces (all on the object `createDriveAuth` returns):
  - `listAccounts()` -> `[{ id, label, email, connected }]` (`connected` = token present and decryptable).
  - `authUrl(state)` -> unchanged shape; SCOPES now include `openid`, `email`.
  - `exchangeCode(code, { targetAccountId } = {})` -> exchanges, reads `sub`+`email` from the `id_token`, then: if `targetAccountId` is given, `updateDriveAccountToken(targetAccountId, { token, sub, email })` (card-scoped reconnect); else upsert by `sub` (`getDriveAccountBySub` -> update token in place, preserving an operator-set label; otherwise insert a new row with `id = sub`, `label = email`). Returns the account id.
  - `getToken(accountId)` / `loadAuthConfig(accountId)` -> as today but for that account (`loadAuthConfig` returns `{ clientId, clientSecret, token }` or null).
  - `disconnect(accountId)` / `renameAccount(accountId, label)`.
  - `ensureMigratedLegacyAccount()` (idempotent): if the legacy `secrets` `"drive_token"` exists and `drive_accounts` is empty, insert one row reusing the encrypted blob as-is, `id` = a generated stable id, `sub` = null, `label` = a generic default, `email` = null; then delete the `"drive_token"` secret. Run from `server.mjs` startup (and/or lazily before `listAccounts`).
  - `isConfigured()` unchanged (env client present, account-independent).
  Consumed by Tasks 3 and 4.

- [ ] **Step 1: Write failing tests** (inject a fake `oauthFactory` whose `getToken` returns `{ tokens: { ..., id_token } }` with a decodable payload, and a real migrated in-memory store): first `exchangeCode` inserts an account keyed by `sub` with `label == email`; a second `exchangeCode` for the same `sub` updates in place (still one account, token refreshed, operator label preserved); `exchangeCode(code, { targetAccountId })` updates that row and sets its `sub`/`email`; `loadAuthConfig(id)` round-trips the decrypted token and returns null for an unknown id; `disconnect(id)`/`renameAccount(id,label)` affect only that row; `ensureMigratedLegacyAccount` seeds exactly one account from a legacy `drive_token` secret, is idempotent, and removes the secret; an account whose stored blob won't decrypt shows `connected:false` in `listAccounts` without throwing.
- [ ] **Step 2: Run to verify they fail**, Run: `node --test dashboard/server/test/drive-auth.test.mjs`, Expected: FAIL.
- [ ] **Step 3: Implement.** Decode the `id_token` payload (base64url JSON) for `sub`/`email`, or use `google.auth.OAuth2#verifyIdToken`; builder's choice. Keep every function that reads a token non-throwing (return null on decrypt failure), as today.
- [ ] **Step 4: Run to verify they pass**, Run: `node --test dashboard/server/test/drive-auth.test.mjs`, Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/drive-auth.mjs dashboard/server/test/drive-auth.test.mjs
git commit -m "feat(server): make Drive auth multi-account with sub-keyed upsert and legacy migration"
```

---

## Task 3: Account-aware Drive routes

**Files:**
- Modify: `dashboard/server/src/routes/drive.mjs`
- Modify: `dashboard/server/src/server.mjs` (call `ensureMigratedLegacyAccount()` at startup if not done lazily)
- Test: `dashboard/server/test/drive-routes.test.mjs` (extend/create)

**Interfaces:**
- Consumes: Task 2 auth service.
- Produces: `GET /api/drive/accounts` -> `{ configured, accounts: listAccounts() }`; `GET /api/drive/connect?accountId=<id?>` (optional `accountId` for a card-scoped reconnect; the id is encoded into the server-side `state` entry and the state cookie, never trusted from the raw query at callback time); `GET /api/drive/callback` -> `exchangeCode(code, { targetAccountId })` using the id bound to the consumed `state`, then redirect to `/settings?drive=connected`; `POST /api/drive/accounts/:id/disconnect`; `PATCH /api/drive/accounts/:id` `{ label }` (zod-validated, non-empty, length-bounded). Keep `GET /api/drive/status` as a thin shim reporting `configured` + whether any account is connected (back-compat), or remove it if no caller remains after Task 6 (builder decides). Consumed by Task 5/6.

- [ ] **Step 1: Write failing tests** (Fastify `inject`, fake driveAuth): `/accounts` lists accounts; `/connect` sets the state cookie and returns a url; `/connect?accountId=x` binds `x` to the pending state so `/callback` calls `exchangeCode(code, { targetAccountId: "x" })`; `/callback` still rejects a mismatched/absent state (CSRF) and redirects on success; `disconnect/:id` calls `disconnect(id)`; `PATCH /:id` renames and rejects an empty label.
- [ ] **Step 2: Run to verify they fail**, Run: `node --test dashboard/server/test/drive-routes.test.mjs`, Expected: FAIL.
- [ ] **Step 3: Implement**, preserving the existing CSRF `state`/cookie machinery (store the optional `targetAccountId` in the `pending` map value alongside the expiry, so it is bound to the state server-side and the raw query id is never trusted).
- [ ] **Step 4: Run to verify they pass**, Run: `node --test dashboard/server/test/drive-routes.test.mjs`, Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/routes/drive.mjs dashboard/server/src/server.mjs dashboard/server/test/drive-routes.test.mjs
git commit -m "feat(server): account-aware Drive routes (list/connect/reconnect/disconnect/rename)"
```

---

## Task 4: Run binding, resolve `driveAccountId`, unavailable-account handling

**Files:**
- Modify: `dashboard/server/src/schemas.mjs` (`createRunSchema.overrides.driveAccountId`)
- Create: `dashboard/server/src/resolve-drive-auth.mjs` (one shared resolver)
- Modify: `dashboard/server/src/run-manager.mjs` (resolve by account, drive-off guard)
- Modify: `dashboard/server/src/upload-item.mjs` (resolve by the run's account)
- Test: `dashboard/server/test/run-manager.test.mjs`, `dashboard/server/test/upload-item.test.mjs`, `dashboard/server/test/schemas.test.mjs`

**Interfaces:**
- Consumes: Task 2 `loadAuthConfig(accountId)`.
- Produces: `overrides.driveAccountId?: string` (zod string, optional). `resolveRunDriveAuth(driveAuthService, overrides)` -> the account's auth config, or null: use `overrides.driveAccountId` when present; when absent, fall back to the single connected account if exactly one exists (back-compat for pre-existing runs), otherwise null. Run manager behavior: build config with the resolved auth; **if the resulting config would have `drive === true` but the resolved auth is null, set `config.drive = false` and log a clear run-console warning** ("chosen Drive account unavailable; rows not uploaded, reconnect and re-upload") so the engine never gets `drive:true` without creds. `upload-item.mjs` resolves via the same helper and keeps throwing `UploadItemError("unavailable")` when null.

- [ ] **Step 1: Write failing tests**
  - schemas: `createRunSchema` accepts `overrides.driveAccountId: "acc_1"`.
  - run-manager: with a fake driveAuth where `loadAuthConfig("gone")` is null, a run whose overrides request Drive + `driveAccountId:"gone"` runs to completion with `config.drive` forced false (assert via a captured runnerFactory config) and a warning logged, not a thrown/failed run; with `loadAuthConfig("ok")` returning creds, `config.driveAuth` is set and `config.drive` stays true. A run with no `driveAccountId` and exactly one connected account resolves to it.
  - upload-item: `uploadItem` resolves `loadAuthConfig(run.overrides.driveAccountId)` and throws `UploadItemError("unavailable")` when the account is gone.
- [ ] **Step 2: Run to verify they fail**, Run: `node --test dashboard/server/test/run-manager.test.mjs dashboard/server/test/upload-item.test.mjs dashboard/server/test/schemas.test.mjs`, Expected: FAIL.
- [ ] **Step 3: Implement** the shared resolver, the schema field, the run-manager drive-off guard (applied after `buildRunConfig`, before `runnerFactory`), and the `upload-item` change. Do not modify `src/`.
- [ ] **Step 4: Run to verify they pass**, Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/schemas.mjs dashboard/server/src/resolve-drive-auth.mjs dashboard/server/src/run-manager.mjs dashboard/server/src/upload-item.mjs dashboard/server/test/
git commit -m "feat(server): bind runs to a Drive account and handle an unavailable account without fallback"
```

---

## Task 5: Web types, schema, and Drive API client

**Files:**
- Modify: `dashboard/web/src/features/runs/api/runs-api.ts` (`RunOverrides.driveAccountId`)
- Modify: `dashboard/web/src/lib/schemas.ts` (a `driveAccountSchema` + accounts-list schema)
- Modify: `dashboard/web/src/features/settings/api/drive-api.ts` (accounts endpoints)
- Test: `dashboard/web/src/lib/schemas.test.ts`, `dashboard/web/src/features/settings/api/drive-api.test.ts` (if present; else fold into settings tests)

**Interfaces:**
- Produces: `RunOverrides.driveAccountId?: string`; `DriveAccount` type `{ id, label, email, connected }` + a `{ configured, accounts: DriveAccount[] }` list schema; `fetchDriveAccounts`, `connectDrive(accountId?)` (passes `?accountId=`), `disconnectAccount(id)`, `renameAccount(id, label)`. Consumed by Tasks 6, 7.

- [ ] **Step 1: Write failing tests**: the accounts-list schema parses `{ configured:true, accounts:[{id,label,email,connected}] }`; `RunOverrides` accepts `driveAccountId`.
- [ ] **Step 2: Run to verify fail**, Run: `npm --prefix dashboard/web test -- schemas`, Expected: FAIL.
- [ ] **Step 3: Implement** the types/schemas and the api-client functions (mirror the existing `drive-api.ts` shape).
- [ ] **Step 4: Run to verify pass**, Expected: PASS; `tsc` clean.
- [ ] **Step 5: Commit**

```bash
git add dashboard/web/src/features/runs/api/runs-api.ts dashboard/web/src/lib/schemas.ts dashboard/web/src/features/settings/api/drive-api.ts dashboard/web/src/lib/schemas.test.ts
git commit -m "feat(web): types, schema, and api client for Drive accounts + run driveAccountId"
```

---

## Task 6: Settings, multiple account cards

**Files:**
- Modify/replace: `dashboard/web/src/features/settings/components/DriveStatusCard.tsx` (becomes an accounts list) and `SettingsPage.tsx`
- Modify: `dashboard/web/src/features/settings/hooks/use-drive-status.ts` (becomes `use-drive-accounts.ts`)
- Test: `dashboard/web/src/features/settings/components/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: Task 5 api client. Produces: a Settings section listing account cards (label, email, Disconnect, inline Rename, per-card Reconnect) and a "Connect another Drive" action; the not-configured state preserved.

- [ ] **Step 1: Write failing tests**: with a mocked client returning two accounts, both cards render with label+email; Disconnect calls `disconnectAccount(id)`; Rename calls `renameAccount(id,label)`; "Connect another Drive" calls `connectDrive()` and a card Reconnect calls `connectDrive(id)`; the not-configured state renders the setup hint.
- [ ] **Step 2: Run to verify fail**, Run: `npm --prefix dashboard/web test -- Settings`, Expected: FAIL.
- [ ] **Step 3: Implement** using the app's existing card/atoms; follow the current `DriveStatusCard`/`use-drive-status` patterns (React Query hook, mutations invalidate the accounts query). Keep accessible labels.
- [ ] **Step 4: Run to verify pass**, Expected: PASS; `tsc` clean.
- [ ] **Step 5: Commit**

```bash
git add dashboard/web/src/features/settings/
git commit -m "feat(web): Settings lists multiple Drive accounts with rename/disconnect/reconnect"
```

---

## Task 7: New Run form, Drive account dropdown + per-project memory

**Files:**
- Create: `dashboard/web/src/stores/use-drive-account-store.ts` (per-project last-used account)
- Modify: `dashboard/web/src/features/runs/components/NewRunDialog.tsx`
- Test: `dashboard/web/src/features/runs/components/NewRunDialog.test.tsx`

**Interfaces:**
- Consumes: Task 5 api client + `RunOverrides.driveAccountId`; Task 6's accounts query. Produces: when `showDrive` and Drive upload is on, a "Drive account" `Select` listing connected accounts, default-selected from `use-drive-account-store` (projectId -> accountId) falling back to the only connected account; its value flows into `buildOverrides()` as `driveAccountId`; saved to the store on run creation (mirroring the Drive-folder store). When no accounts are connected, upload cannot be enabled and the control points to Settings.

- [ ] **Step 1: Write failing tests**: with two accounts and Drive on, selecting an account and submitting calls `createRun` with `overrides.driveAccountId` equal to the chosen id; the dropdown prefills the project's remembered account; with zero accounts, the upload path is disabled/guided to Settings.
- [ ] **Step 2: Run to verify fail**, Run: `npm --prefix dashboard/web test -- NewRunDialog`, Expected: FAIL.
- [ ] **Step 3: Implement** the store (zustand+persist, name `scrapr-drive-accounts`, mirroring `use-drive-folder-store`) and the dialog field (reuse the `Select` atom; place inside the `showDrive` block beside Folder ID).
- [ ] **Step 4: Run to verify pass**, Expected: PASS; `tsc` clean; full `npm --prefix dashboard/web test` green.
- [ ] **Step 5: Commit**

```bash
git add dashboard/web/src/stores/use-drive-account-store.ts dashboard/web/src/features/runs/components/NewRunDialog.tsx dashboard/web/src/features/runs/components/NewRunDialog.test.tsx
git commit -m "feat(web): per-run Drive account selector prefilled per project"
```

---

## Notes for the executor

- **Base branch:** this feature is independent of the run-concurrency work; build it on its own branch off `main` (confirm with the operator).
- **Run the real app once at the end:** connect a second Google account in Settings, rename a card, create a run choosing the second account, confirm the upload lands in that account and the per-row Drive link points there; then disconnect that account and start a run against it to confirm the scrape completes with rows "not uploaded" and re-uploadable (no fallback). Tests cover the logic; this confirms the OAuth round-trip and real Drive upload end to end.
- Web test invocation shown as `npm --prefix dashboard/web test -- <pattern>`; match the repo's actual vitest script.
