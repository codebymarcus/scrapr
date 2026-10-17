# Dashboard UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dashboard user connect Google Drive from the UI (no terminal, no files), watch a live terminal-style console of a running scrape, and override a project's Drive settings per run.

**Architecture:** Three features over the existing Fastify + better-sqlite3 server, the shared scrape engine, and the React + TanStack Query web app. Drive auth moves to env-var OAuth client + an encrypted token row in SQLite; the engine gains an in-memory credential path so it no longer needs files when the dashboard runs it. The live console surfaces `log` websocket events the frontend already receives but currently discards. Per-run overrides ride on the run row and are merged into the engine config at execution time without mutating the project recipe.

**Tech Stack:** Node ESM (`.mjs`), Fastify 5, `@fastify/websocket`, better-sqlite3, zod, `googleapis` (Drive v3, `google.auth.OAuth2`), node:crypto (AES-256-GCM). Web: React 19, TypeScript, TanStack Query, Zustand, SCSS modules, Vitest. Server/engine tests use `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-dashboard-ux-improvements-design.md`

## Global Constraints

- Node ESM only (`.mjs` on server/engine, `.ts`/`.tsx` on web). No TypeScript on the server/engine.
- Do not change the engine's core execution or per-row upload behavior in `src/pipeline.mjs`. The only engine change allowed is in `src/drive.mjs` `DriveUploader.create` to accept an in-memory credential source.
- The CLI path (`scrape.mjs` + `authorize.mjs` + `credentials.json`/`token.json`) must keep working unchanged. New behavior is additive.
- OAuth scope stays exactly `https://www.googleapis.com/auth/drive.file` (matches `authorize.mjs`).
- `config.driveFolder` is a Drive **parent folder ID**; `config.driveSubfolder` is a **name** get-or-created under it (`src/drive.mjs:89-93, 98-118`). Preserve this meaning everywhere.
- `APP_SECRET_KEY` (AES key) is **optional** at boot: when absent the server still starts and Drive reports "not configured." Never crash the server over a missing or bad key.
- Server tests: `cd dashboard/server && npm test` (`node --test`, files in `dashboard/server/test/*.test.mjs`). Web tests: `cd dashboard/web && npm test` (`vitest run`). Engine tests: `npm test` at repo root.
- Per-run overrides must never write back to `projects.recipe_json`.
- Drive override UI appears for **image** projects only (text runs never upload).

## Review Focus

- **OAuth callback with `error=access_denied` or no `code` (user cancels consent):** `GET /api/drive/callback` must return a graceful page/redirect and leave Drive disconnected, never a 500. → test in Task 2.
- **`APP_SECRET_KEY` absent at boot:** server boots; `GET /api/drive/status` reports `configured:false` / not connected; non-Drive features unaffected. → test in Task 2.
- **Token present in DB but undecryptable (key rotated/wrong):** status is disconnected with a reconnect hint; `getToken()` returns null rather than throwing. → test in Task 1 (crypto) + Task 2 (status).
- **Per-run Drive override sent for a text recipe:** `buildRunConfig` ignores drive overrides for text (no `config.drive`), so a text run never silently "turns on" Drive. → test in Task 5.
- **A long run emitting thousands of `log` events:** the client log buffer is bounded (keep the most recent `MAX_LOG_LINES`), so the cache/DOM can't grow without limit. → test in Task 7.

---

### Task 1: Secrets storage — encryption + DB table + store methods

**Files:**
- Create: `dashboard/server/src/secrets/crypto.mjs`
- Modify: `dashboard/server/src/db/migrations.mjs` (append migration `002_secrets`)
- Modify: `dashboard/server/src/db/store.mjs` (add secret prepared statements + methods)
- Test: `dashboard/server/test/crypto.test.mjs`, extend `dashboard/server/test/store.test.mjs`

**Interfaces:**
- Produces:
  - `keyFromEnv(env = process.env) -> Buffer | null` — parses `APP_SECRET_KEY` (base64 of exactly 32 bytes); returns `null` when unset or invalid (never throws).
  - `encryptSecret(plaintext: string, key: Buffer) -> string` — returns `v1:<ivB64>:<tagB64>:<cipherB64>` (AES-256-GCM, random 12-byte IV).
  - `decryptSecret(blob: string, key: Buffer) -> string` — throws on wrong key / tampered blob / malformed input.
  - store methods: `getSecret(key: string) -> string | null`, `setSecret(key: string, value: string) -> void` (upsert), `deleteSecret(key: string) -> void`. Store holds opaque encrypted blobs; it does no crypto.

- [ ] **Step 1: Write failing crypto tests** in `test/crypto.test.mjs`:

```js
// round-trip
const key = keyFromEnv({ APP_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") });
assert.equal(decryptSecret(encryptSecret("hello", key), key), "hello");
// wrong key throws
const other = keyFromEnv({ APP_SECRET_KEY: Buffer.alloc(32, 9).toString("base64") });
assert.throws(() => decryptSecret(encryptSecret("hi", key), other));
// tampered blob throws
const blob = encryptSecret("hi", key);
assert.throws(() => decryptSecret(blob.slice(0, -2) + "xy", key));
// missing / bad env → null, no throw
assert.equal(keyFromEnv({}), null);
assert.equal(keyFromEnv({ APP_SECRET_KEY: "not-base64-32-bytes" }), null);
```

- [ ] **Step 2: Run to verify fail** — `cd dashboard/server && node --test test/crypto.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement `crypto.mjs`** with the three functions using `node:crypto` `createCipheriv("aes-256-gcm", …)`. `keyFromEnv` returns `null` unless the decoded key is exactly 32 bytes.
- [ ] **Step 4: Run crypto tests** → PASS.
- [ ] **Step 5: Add migration `002_secrets`** to `MIGRATIONS`:

```sql
CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);
```

- [ ] **Step 6: Write failing store test** in `test/store.test.mjs` (follow the file's existing in-memory-db setup): `setSecret`/`getSecret` round-trips an opaque string; `getSecret` of an unknown key is `null`; `setSecret` twice upserts; `deleteSecret` removes it.
- [ ] **Step 7: Run** → FAIL (methods missing).
- [ ] **Step 8: Implement store methods** — add prepared statements (`getSecret`, `upsertSecret` via `INSERT … ON CONFLICT(key) DO UPDATE`, `deleteSecret`) and expose `getSecret`/`setSecret`/`deleteSecret` on the returned store object, mirroring the existing method style.
- [ ] **Step 9: Run store + crypto tests** → PASS.
- [ ] **Step 10: Commit** — `feat(server): encrypted secrets store (crypto + table + methods)`.

---

### Task 2: Drive auth service + OAuth routes (connect / callback / status / disconnect)

**Files:**
- Create: `dashboard/server/src/drive-auth.mjs`
- Create: `dashboard/server/src/routes/drive.mjs`
- Modify: `dashboard/server/src/config.mjs` (OAuth env vars + key)
- Modify: `dashboard/server/src/app.mjs` (register `drive.mjs`; move drive/status off `system.mjs`)
- Modify: `dashboard/server/src/routes/system.mjs` (drop drive/status; keep `/api/health`)
- Test: `dashboard/server/test/drive-auth.test.mjs`, `dashboard/server/test/drive-routes.test.mjs`; update `dashboard/server/test/system.test.mjs` (remove drive/status cases there)

**Interfaces:**
- Consumes: `store.{getSecret,setSecret,deleteSecret}` (Task 1), `keyFromEnv`/`encryptSecret`/`decryptSecret` (Task 1).
- Config (new in `config.mjs`): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (default `http://localhost:${PORT}/api/drive/callback`), and `APP_SECRET_KEY` read via `keyFromEnv`.
- Produces `createDriveAuth({ store, key, clientId, clientSecret, redirectUri, oauthFactory? }) ->`
  - `isConfigured() -> boolean` (clientId && clientSecret && key all present)
  - `authUrl(state: string) -> string` (scope `drive.file`, `access_type:"offline"`, `prompt:"consent"`)
  - `exchangeCode(code: string) -> Promise<void>` (exchanges, encrypts token JSON, `setSecret("drive_token", …)`)
  - `getToken() -> object | null` (decrypts `drive_token`; returns `null` if absent OR undecryptable — never throws)
  - `status() -> { configured: boolean, connected: boolean, reason: "ok" | "not-configured" | "needs-reconnect" }`
  - `disconnect() -> void` (`deleteSecret("drive_token")`)
  - `loadAuthConfig() -> { clientId, clientSecret, token } | null` (null unless configured AND a decryptable token exists) — consumed by Task 3/5.
  - `oauthFactory` defaults to `(id, secret, redirect) => new google.auth.OAuth2(id, secret, redirect)`; tests inject a fake.
- Routes (registered with `{ driveAuth }`):
  - `GET /api/drive/status` → `{ connected, configured, reason, hint }`.
  - `GET /api/drive/connect` → `{ url }` (the consent URL) or `409 { error }` when not configured.
  - `GET /api/drive/callback?code=…&state=…` (or `?error=…`) → exchanges on success and redirects to `/settings` (or returns a small success page); on `error`/missing code, redirects/replies without 500, Drive stays disconnected.
  - `POST /api/drive/disconnect` → `{ disconnected: true }`.

- [ ] **Step 1: Write failing `drive-auth.test.mjs`** using a fake store (plain Map) and a fake `oauthFactory`:
  - not configured (no key) → `isConfigured()` false, `status().reason === "not-configured"`, `loadAuthConfig()` null.
  - configured + `exchangeCode` (fake returns `{ tokens: { refresh_token: "r" } }`) → `getToken()` returns the token, `status().connected` true, `loadAuthConfig()` returns `{ clientId, clientSecret, token }`.
  - token stored but key wrong on read → `getToken()` null, `status().reason === "needs-reconnect"`, no throw.
  - `authUrl("s")` contains the scope, `access_type=offline`, `prompt=consent`, and the state.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `drive-auth.mjs`.** `status()`: not-configured when `!isConfigured()`; else connected when `getToken()` non-null; else if a `drive_token` secret exists but won't decrypt → `needs-reconnect`; else disconnected (`ok`, connected false).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Add OAuth env + key to `config.mjs`** (exports above). Keep existing exports.
- [ ] **Step 6: Write failing `drive-routes.test.mjs`** with `buildApp({ driveAuth: fake })` using `app.inject`:
  - status reflects the fake's `status()`.
  - connect returns `{ url }` when configured; `409` when not.
  - **callback with `?error=access_denied`** → not 500 (redirect 302 or 200), `exchangeCode` not called. *(Review Focus)*
  - **callback with no `code`** → not 500. *(Review Focus)*
  - callback with a `code` → calls `exchangeCode`, then redirects.
  - disconnect calls `driveAuth.disconnect()` and returns `{ disconnected: true }`.
  - **a server built with no key still answers `/api/drive/status` (configured:false) and `/api/health`** — boot-without-key. *(Review Focus)*
- [ ] **Step 7: Run** → FAIL.
- [ ] **Step 8: Implement `routes/drive.mjs`;** register it in `app.mjs` with `deps.driveAuth`; remove the drive/status route from `system.mjs` (leave `/api/health`); update `system.test.mjs` to drop the moved cases.
- [ ] **Step 9: Run drive-routes + drive-auth + system tests** → PASS.
- [ ] **Step 10: Commit** — `feat(server): in-app Google Drive OAuth (service + routes)`.

---

### Task 3: Engine accepts in-memory Drive credentials

**Files:**
- Modify: `src/drive.mjs` (`DriveUploader.create`)
- Test: extend `test/*.test.mjs` for drive (create `test/drive-auth-inmemory.test.mjs` if no drive unit test exists)

**Interfaces:**
- Consumes: a config field `config.driveAuth = { clientId, clientSecret, token } | undefined`.
- Produces: unchanged `DriveUploader.create(config, logger)` signature and return. New behavior: when `config.driveAuth` is present, build the `OAuth2` client from it (`new google.auth.OAuth2(clientId, clientSecret)` + `setCredentials(token)`) instead of reading `credentials.json`/`token.json`. When absent, behavior is exactly as today (file-based). `config.driveFolder`/`config.driveSubfolder` handling is unchanged.

- [ ] **Step 1: Write failing test** — call `DriveUploader.create({ driveAuth: { clientId: "id", clientSecret: "sec", token: { refresh_token: "r" } }, driveFolder: null }, fakeLogger)` and assert it resolves to a `DriveUploader` **without touching the filesystem** (run in a temp cwd with no `credentials.json`/`token.json`; today that path throws). Assert the uploader’s `drive` is built. Also assert that with neither `driveAuth` nor files present, `create` still throws the existing actionable error.
- [ ] **Step 2: Run** → FAIL (create throws "credentials not found").
- [ ] **Step 3: Implement the branch** at the top of `DriveUploader.create`: if `config.driveAuth?.clientId && config.driveAuth?.token`, build `auth` from it and skip the file reads; otherwise keep the current file flow (lines 68-81). Keep the subfolder ensure logic (89-93).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Run full engine suite** — `npm test` (root) → PASS.
- [ ] **Step 6: Commit** — `feat(engine): DriveUploader accepts in-memory OAuth credentials`.

---

### Task 4: Drive connect / disconnect UI

**Files:**
- Modify: `dashboard/web/src/lib/schemas.ts` (`driveStatusSchema`)
- Modify: `dashboard/web/src/features/settings/api/drive-api.ts` (connect/disconnect calls)
- Modify: `dashboard/web/src/features/settings/hooks/use-drive-status.ts` (add mutations hook)
- Modify: `dashboard/web/src/features/settings/components/DriveStatusCard.tsx`
- Test: `dashboard/web/src/features/settings/components/SettingsPage.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 2 routes/shapes.
- Produces (web):
  - `driveStatusSchema` → `{ connected: boolean, configured: boolean, reason: string, hint?: string }` (drop `credentialsPath`/`tokenPath`).
  - `connectDrive(client?) -> Promise<{ url: string }>` (GET `/api/drive/connect`), `disconnectDrive(client?) -> Promise<void>` (POST `/api/drive/disconnect`).
  - `useDriveMutations(client?)` exposing `connect` (navigates `window.location.href = url`) and `disconnect` (invalidates `driveStatusKey`).

- [ ] **Step 1: Write failing `SettingsPage.test.tsx` cases:** when `configured:false` → card shows a "not configured" message and no Connect button; when `configured:true, connected:false` → a **Connect Google Drive** button; when `connected:true` → "Connected" + a **Disconnect** button. (Mock the client; follow existing test patterns in the file.)
- [ ] **Step 2: Run** — `cd dashboard/web && npm test -- SettingsPage` → FAIL.
- [ ] **Step 3: Update `driveStatusSchema`**, add `connectDrive`/`disconnectDrive` to `drive-api.ts`, add `useDriveMutations` to `use-drive-status.ts`, and rework `DriveStatusCard.tsx` to render the three states with buttons (replace the credentials/token `<dl>`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Typecheck/build** — `cd dashboard/web && npm run build` → PASS.
- [ ] **Step 6: Commit** — `feat(web): connect/disconnect Google Drive from settings`.

---

### Task 5: Per-run Drive overrides — backend

**Files:**
- Modify: `dashboard/server/src/db/migrations.mjs` (migration `003_run_overrides`)
- Modify: `dashboard/server/src/db/store.mjs` (`createRun` stores overrides; `getRun`/`listRuns` parse `overrides`)
- Modify: `dashboard/server/src/schemas.mjs` (`createRunSchema` gains `overrides`)
- Modify: `dashboard/server/src/routes/runs.mjs` (pass `overrides` through to `createRun`)
- Modify: `dashboard/server/src/build-run-config.mjs` (accept + merge `overrides` and `driveAuth`)
- Modify: `dashboard/server/src/run-manager.mjs` (`execute` passes `run.overrides` + injected `driveAuth`)
- Modify: `dashboard/server/src/server.mjs` (construct `driveAuth`, pass to `buildApp` and `createRunManager`)
- Test: extend `test/store.test.mjs`, `test/schemas.test.mjs`, `test/runs.test.mjs`, `test/build-run-config.test.mjs`, `test/run-manager.test.mjs`

**Interfaces:**
- Consumes: Task 2 `driveAuth.loadAuthConfig()`.
- `overrides` shape: `{ drive?: boolean, driveFolder?: string, driveSubfolder?: string }`.
- `createRunSchema` = existing `{ projectId, label? }` + `overrides: <shape>.optional()`.
- `store.createRun({ projectId, label, overrides })` persists `JSON.stringify(overrides ?? null)` into `runs.overrides_json`; `getRun`/`listRuns`/`nextQueuedRun` return rows with parsed `overrides` (object or null). Use a `runFromRow` helper mirroring `projectFromRow`.
- `buildRunConfig(recipe, { runOutDir, overrides, driveAuth }) -> config`:
  - `config.driveAuth = driveAuth` when provided (so the engine uses in-memory creds).
  - For **image** recipes only: after `copyOutput`, apply overrides — `if (overrides?.drive !== undefined) config.drive = overrides.drive`; same for `driveFolder`, `driveSubfolder`.
  - For **text** recipes: overrides are ignored (no `config.drive`). *(Review Focus)*
- `run-manager.execute`: `const driveAuth = deps.driveAuth?.loadAuthConfig?.() ?? undefined;` then `buildRunConfig(recipe, { runOutDir: runOutDir(run), overrides: run.overrides, driveAuth })`. `createRunManager` gains an optional `driveAuth` param.

- [ ] **Step 1: Add migration `003_run_overrides`** — `ALTER TABLE runs ADD COLUMN overrides_json TEXT;`.
- [ ] **Step 2: Write failing store test** — `createRun({ projectId, label, overrides: { drive: true, driveFolder: "ID", driveSubfolder: "sub" } })`; `getRun` returns `run.overrides` deep-equal to that object; a run created without overrides has `overrides === null`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** store changes (parse via `runFromRow`). **Step 5: Run** → PASS.
- [ ] **Step 6: Write failing schema test** in `schemas.test.mjs` — `createRunSchema` accepts a body with a valid `overrides`; rejects `overrides.drive` of wrong type. **Step 7: Run → FAIL. Step 8: Implement. Step 9: Run → PASS.**
- [ ] **Step 10: Write failing `runs.test.mjs` case** — `POST /api/runs` with `overrides` returns 201 and the created run carries them (via store). **Step 11: Run → FAIL. Step 12: Implement route pass-through (`store.createRun({ projectId, label: label ?? null, overrides })`). Step 13: Run → PASS.**
- [ ] **Step 14: Write failing `build-run-config.test.mjs` cases:**
  - image recipe with `output.drive:false` + `overrides.drive:true, driveFolder:"X"` → `cfg.drive===true`, `cfg.driveFolder==="X"`.
  - image recipe, `driveAuth` passed → `cfg.driveAuth` deep-equals it.
  - **text recipe + `overrides.drive:true` → `cfg.drive` is NOT true (stays engine default)** and no upload is configured. *(Review Focus)*
- [ ] **Step 15: Run → FAIL. Step 16: Implement `buildRunConfig` merge + driveAuth. Step 17: Run → PASS.**
- [ ] **Step 18: Write failing `run-manager.test.mjs` case** — with a fake `driveAuth.loadAuthConfig()` returning creds and a run with overrides, assert the `runnerFactory` receives a config whose `drive`/`driveFolder`/`driveAuth` reflect the overrides+creds. (Follow the existing fake-runner pattern in that test.)
- [ ] **Step 19: Run → FAIL. Step 20: Implement `execute` + `createRunManager({ driveAuth })`; wire `server.mjs` to build `driveAuth` from `keyFromEnv` + config env and pass it to both `buildApp` and `createRunManager`. Step 21: Run full server suite → PASS.**
- [ ] **Step 22: Commit** — `feat(server): per-run Drive overrides + in-memory auth wiring`.

---

### Task 6: Per-run Drive overrides — New Run dialog

**Files:**
- Modify: `dashboard/web/src/features/runs/components/NewRunDialog.tsx`
- Modify: `dashboard/web/src/features/runs/api/runs-api.ts` (`createRun` body includes `overrides`)
- Modify: `dashboard/web/src/features/runs/hooks/use-run-mutations.ts` (`useCreateRun` input gains `overrides`)
- Test: extend `dashboard/web/src/features/runs/components/NewRunDialog.test.tsx`

**Interfaces:**
- Consumes: Task 5 `POST /api/runs` overrides; `useProjects` (projects carry `recipe`).
- `createRun(input: { projectId, label?, overrides? }, client?)` — `overrides` added to the POST body.
- `useCreateRun` input type gains `overrides?: { drive?: boolean; driveFolder?: string; driveSubfolder?: string }`.
- Dialog behavior: when the selected project's `recipe.contentType === "image"`, show a **Drive** section — a toggle (default `recipe.output?.drive ?? false`), a **Folder ID** input (default `recipe.output?.driveFolder ?? ""`), a **Subfolder name** input (default `recipe.output?.driveSubfolder ?? ""`). For **text** projects the section is hidden. Only send `overrides` keys that differ from the recipe default (or always send the section's values for image projects — builder's choice, but never send Drive overrides for a text project).

- [ ] **Step 1: Write failing `NewRunDialog.test.tsx` cases:**
  - selecting an image project shows a Drive toggle + Folder ID + Subfolder fields, prefilled from its recipe.
  - selecting a text project shows **no** Drive fields.
  - submitting an image run with the toggle on and a folder id calls the client `post("/api/runs", …)` with `overrides.drive===true` and the folder id.
- [ ] **Step 2: Run** — `cd dashboard/web && npm test -- NewRunDialog` → FAIL.
- [ ] **Step 3: Implement** — add state + fields gated on the selected project's content type, prefill from its recipe, thread `overrides` through `useCreateRun`/`createRun`. Resolve the selected project from `projectsQuery.data`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Build** — `cd dashboard/web && npm run build` → PASS.
- [ ] **Step 6: Commit** — `feat(web): per-run Drive overrides in the New Run dialog`.

---

### Task 7: Live console — retain `log` events in the cache

**Files:**
- Modify: `dashboard/web/src/features/runs/types.ts` (`CachedRunDetail.logs`)
- Modify: `dashboard/web/src/features/runs/hooks/use-run-events.ts` (`applyEvent` keeps `log`)
- Test: extend `dashboard/web/src/features/runs/hooks/use-run-events.test.ts`

**Interfaces:**
- Produces:
  - `LogLine = { seq: number; level?: string; message: string; ts?: number }` in `types.ts`.
  - `CachedRunDetail.logs?: LogLine[]`.
  - `MAX_LOG_LINES` constant (e.g. `1000`) exported from `use-run-events.ts`.
  - `applyEvent` `case "log"`: append `{ seq, level, message, ts }` to `detail.logs`, assigning a monotonically increasing `seq`, keeping only the last `MAX_LOG_LINES`. No-op when there is no cached detail (keep current guard behavior consistent with other cases).

- [ ] **Step 1: Write failing test** in `use-run-events.test.ts` (follow the file's fake-socket + QueryClient setup): feeding two `log` events appends two `LogLine`s with increasing `seq` and the right `message`/`level`; feeding `MAX_LOG_LINES + 5` log events leaves exactly `MAX_LOG_LINES`, keeping the most recent. *(Review Focus: bounded buffer)*
- [ ] **Step 2: Run** → FAIL (logs dropped today).
- [ ] **Step 3: Implement** — replace `case "log": return;` with the append-and-cap logic; add the type + constant.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): retain run log events in the cache (bounded)`.

---

### Task 8: Live console — terminal component inline in the run card

**Files:**
- Create: `dashboard/web/src/features/runs/components/RunConsole.tsx`
- Create: `dashboard/web/src/features/runs/components/RunConsole.module.scss`
- Modify: `dashboard/web/src/features/runs/components/RunCard.tsx` (expandable console for the running run)
- Modify: `dashboard/web/src/features/runs/components/RunCard.module.scss` (console toggle layout)
- Test: `dashboard/web/src/features/runs/components/RunConsole.test.tsx`; extend `RunCard.test.tsx`

**Interfaces:**
- Consumes: Task 7 `CachedRunDetail.logs` / `LogLine`.
- `RunConsole({ logs }: { logs: LogLine[] })` — renders a monospace, dark, scrolling list; each line keyed by `seq`, with a level-based class (`error` red, `success`/`warn`/`muted`/`section` variants). Auto-scrolls to the newest line; pauses auto-scroll when the user has scrolled up (resumes when back at the bottom). Renders an empty-state line when `logs` is empty.

- [ ] **Step 1: Write failing `RunConsole.test.tsx`:** given sample `logs`, it renders each message in order; an `error`-level line gets the error class; empty `logs` shows the empty state.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `RunConsole.tsx` + SCSS.** Use a `ref` + effect to scroll to bottom; track an `atBottom` flag on scroll to gate auto-scroll. (jsdom has no layout; guard the scroll effect so tests don't crash.)
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Write failing `RunCard.test.tsx` case:** a running card shows a console toggle; expanding it renders `RunConsole` fed from the cached detail's `logs`; a non-running card shows no console. (Use the existing cache-seeding/socket-fake helpers in the test.)
- [ ] **Step 6: Run** → FAIL.
- [ ] **Step 7: Implement in `RunCard.tsx`** — read `detail.data?.logs` (already fetched for running cards), add an expand/collapse control, render `RunConsole` when expanded and `isRunning`.
- [ ] **Step 8: Run** → PASS.
- [ ] **Step 9: Build** — `cd dashboard/web && npm run build` → PASS.
- [ ] **Step 10: Commit** — `feat(web): live terminal console on the running run card`.

---

## Docs (fold into the owning commits)

- Update `README` (Drive section) and `scraper.config.example.json`/compose docs: the dashboard now uses `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, and `APP_SECRET_KEY` (base64 32-byte) env vars, and the "Connect Google Drive" button replaces `node authorize.mjs` for dashboard use (the CLI still uses `authorize.mjs`). Note the required redirect URI to register on the Google OAuth client. Do this in Task 2 (env vars) and Task 4 (button) commits.
- `compose.yaml` / `compose.dev.yaml`: add the four env vars (with placeholders) to the server service. Fold into Task 2.

## Self-Review Notes

- **Spec coverage:** Feature 1 → Tasks 1–4; Feature 2 → Tasks 7–8; Feature 3 → Tasks 5–6. The "nothing in Drive" clarification is addressed by the console (Task 8) + per-run toggle (Task 6) + text-recipe guard (Task 5). Env-vars-for-client + encrypted-token-in-DB (Tasks 1–2). No `token.json`/`credentials.json` on the dashboard path (Task 3 injection + Task 2 service).
- **Review Focus:** all five lines have an owning task test (callback error → T2; no key at boot → T2; undecryptable token → T1/T2; text override ignored → T5; bounded log buffer → T7).
- **Type consistency:** `driveAuth` shape `{ clientId, clientSecret, token }` is identical in `loadAuthConfig` (T2), `buildRunConfig` (T5), and `DriveUploader.create` (T3). `overrides` shape `{ drive?, driveFolder?, driveSubfolder? }` identical across schema (T5), store (T5), API (T6), dialog (T6). `LogLine`/`MAX_LOG_LINES` defined in T7, consumed in T8.
- **CLI untouched:** `authorize.mjs` and the file-based `DriveUploader.create` path remain (T3 keeps the fallback).
