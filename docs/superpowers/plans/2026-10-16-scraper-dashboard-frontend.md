# Scraper Dashboard — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React 19 + TypeScript single-page app (`dashboard/web/`) in the operator's dark **vintage** theme that consumes the backend API: watch/resume runs with live progress, add/import work, stand up and **test** an image-first scraping project, and manage Drive/settings.

**Architecture:** Vite SPA mirroring the conventions of `/Users/quincus/Personal/projects/crypto-market-dashboard` — feature-sliced (`features/<name>` each with `api/ components/ hooks/ types.ts` and a single barrel `index.ts`), atomic shared components, **TanStack React Query** for all server data, **Zustand** for global client state only (theme), **Zod** validating every API response, **Sass + CSS Modules** (ITCSS layers + CSS-variable tokens). All server data flows through one typed HTTP client whose base URL is injectable, so every component/hook is testable with **Vitest + Testing Library** and an injected `fetch` (query by role/accessible-name, never test-ids). Live run updates arrive over a WebSocket and are merged into the React Query cache.

**Tech Stack:** React 19 (function components, named exports only), TypeScript strict + ESM + `verbatimModuleSyntax`, Vite, `@tanstack/react-query`, `zustand`, `zod`, `react-router`, Sass + CSS Modules, Recharts not required. Vitest + `@testing-library/react` + `/user-event` + `/jest-dom` + jsdom. Fonts: **Bitter** (slab-serif display), **JetBrains Mono** (data), **Inter** (body) — loaded via Google Fonts `<link>`.

**Spec:** `docs/superpowers/specs/2026-10-16-scraper-dashboard-design.md` (§6 design system, §7 behaviors, §8 screens). Backend it consumes is merged on `main` (plan 2); engine on `main` (plan 1).

## Global Constraints

- **Conventions copied from crypto-market-dashboard (binding):** named exports only (no default exports, incl. `App`); `PascalCase.tsx` for components, `kebab-case.ts` for every other module (hooks `use-*.ts`, api `*-api.ts`, keys `*-keys.ts`); props typed as `type <Name>Props = {...}` (never `interface`), destructured in the signature; `import type` for type-only imports; import features only via their single barrel (`@/features/<name>`), prefer `@/` alias over deep relative paths, no per-folder barrels; **validate all external JSON with a Zod schema** and infer the type, never cast fetch output; all remote data through the shared HTTP client + React Query hooks (never `fetch` in a component), query keys from a per-feature factory; **never hardcode a color** — use `var(--color-*)` tokens; accessibility required (semantic elements, `role`/`aria-label`, `type="button"`). 2-space indent, double quotes, trailing commas.
- `dashboard/web/` is its own package (own `package.json`, `"engines": {"node": ">=22"}`). It talks to the backend at a base URL from `import.meta.env.VITE_API_BASE` (default `http://localhost:5174`), and to the WS at `VITE_WS_BASE` (default `ws://localhost:5174`).
- **Vintage theme tokens (from the approved mockup — use these exact values):** `--color-base:#060F1A` (sidebar/deepest/meter troughs), `--color-background:#0B192C`, `--color-surface:#102A45`, `--color-surface-hover:#1E3E62`, `--color-border:#23405F`, `--color-border-strong:#1E3E62`, `--color-text:#EFE3CC` (cream), `--color-text-secondary:#A99F86`, `--color-accent:#FF6500`, `--color-accent-hover:#FF7D2B`, `--color-accent-burnt:#D9550A`, `--color-focus:#FF6500`, `--color-positive:#7FAE63`, `--color-warn:#D9A441`, `--color-negative:#CF5B4C`. Fonts: display/headings `Bitter`, data (counts/urls/selectors/statuses/labels) `JetBrains Mono`, body `Inter`. A faint film-grain + scanline overlay (toggleable, respects `prefers-reduced-motion`). Progress shown as a **segmented LED meter** (discrete lit orange blocks in an inset groove; amber when stalled).
- **Carry-forwards from the backend plan (honor these):** load image thumbnails via `GET /api/thumb?url=<encoded>` (never the raw image URL); the builder's image rules UI must treat `includeSelector`/`excludeSelector`/`position` as **preview-only** and surface the preview response's `unenforcedRuleKeys` as a warning; WS events carry epoch-ms `ts`; a run's recipe is bound at create time.
- Tests never hit the network: inject `fetch` into the HTTP client (or use a test client with a stub), use a fresh `QueryClient` per test with retries off, and render with the providers.

## Backend API this app consumes (reference)

- `GET /api/health` → `{ ok }`. `GET /api/drive/status` → `{ connected, credentialsPath, tokenPath, hint }`.
- Projects: `POST /api/projects {name, recipe}` → `201 {project}`; `GET /api/projects` → `{projects}`; `GET/PUT /api/projects/:id`; `DELETE /api/projects/:id` → 204 | **409** (has runs).
- Runs: `POST /api/runs {projectId,label?}` → `201 {run}`; `GET /api/runs` → `{runs}`; `GET /api/runs/:id` → `{run, items}`; `POST /api/runs/:id/items {urls[]}` → `{added}` (**409** if running); `POST /api/runs/import {path, runId?}`; `GET /api/runs/:id/results`; `POST /api/runs/:id/start` → `{run}` | 409 | 404; `POST /api/runs/:id/stop` → `{stopped}` | 409 | 404.
- Preview: `POST /api/preview/text {url, recipe}` → `{status, via, mode, fields}`; `POST /api/preview/image {url, recipe}` → `{status, via, images, unenforcedRuleKeys}`.
- `GET /api/thumb?url=`. WS `GET /api/ws?runId=` → events `{type:"log"|"progress"|"progress-end"|"item"|"state", ...}`.
- Run `state`: `queued|running|stopped|done|failed`. Item: `{id,url,name,status,reason,saved,total,needs_review,position}`. Recipe: `{name, contentType:"image"|"text", match?, text?, image?{pipeline,rules,expectCount}, output?, metadata?}`.

## Review Focus

- **WS drops / reconnects mid-run** → the hook retries and the UI falls back to React Query polling; progress never freezes silently. Pinned in Task 6.
- **A run with zero items or a 409 on an action** (start a running run, enqueue into a running run) → a clear inline message, no crash, button state reflects the run's real state. Pinned in Tasks 6/7.
- **Image preview returns `unenforcedRuleKeys`** → the builder shows a visible warning and does not present those rules as applied at run. Pinned in Task 9.
- **A thumbnail URL that 404s or is slow** → a broken-image placeholder, not a layout break or hang. Pinned in Task 9.
- **A Zod validation failure on any response** → an ErrorState with retry, not a white screen. Pinned in Task 3 (client) and exercised per feature.

---

### Task 1: Scaffold + ITCSS styles with the vintage theme

**Files:**
- Create: `dashboard/web/package.json`, `vite.config.ts`, `tsconfig.json`/`tsconfig.app.json`/`tsconfig.node.json`, `eslint.config.js`, `vitest.config.ts`, `index.html` (Google Fonts links + pre-paint theme script), `src/main.tsx`, `src/test/setup.ts`, and `src/styles/` (ITCSS: `settings/` tokens, `tools/` mixins, `generic/`, `elements/`, `objects/`, `index.scss`).
- Test: `dashboard/web/src/styles/tokens.test.ts` (asserts the token file declares the vintage hex values — a guard that the palette doesn't drift).

**Interfaces:**
- Produces: a buildable Vite app (`npm run dev`/`build`/`test`), `@/` alias → `src`, Sass `loadPaths` including `src`, `index.scss` importing the ITCSS layers; the vintage CSS-variable tokens on `:root[data-theme="dark"]` (default) and a light fallback; fonts loaded. Mirror the crypto-dashboard's `vite.config.ts`/`tsconfig` flags (`verbatimModuleSyntax`, `jsx: react-jsx`, `paths`).

- [ ] **Step 1: Write the failing token test** — read `src/styles/settings/_theme.scss` and assert it contains `--color-accent: #FF6500`, `--color-background: #0B192C`, `--color-text: #EFE3CC` (and the rest of the vintage set).
- [ ] **Step 2: Run** `cd dashboard/web && npm test` → FAIL (files absent).
- [ ] **Step 3: Scaffold** the Vite+TS+React project, install deps, port the crypto-dashboard `styles/` structure but with the vintage tokens, fonts, and grain/scanline in `generic/`. Add `engines`.
- [ ] **Step 4: Run** `npm test` → PASS; `npm run build` → succeeds (types clean).
- [ ] **Step 5: Commit** — `feat(web): scaffold Vite React app with vintage ITCSS theme`

---

### Task 2: Shared atomic components

**Files:**
- Create: `src/components/atoms/` (`Text.tsx`, `Button.tsx`, `IconButton.tsx`, `TextInput.tsx`, `Select.tsx`, `Label.tsx`, `Badge.tsx`, `SegmentedMeter.tsx`, `icons/`), `src/components/molecules/` (`ErrorState.tsx`, `ThemeToggle.tsx`, `Field.tsx`), `src/components/organisms/PageHeader.tsx`, `src/components/templates/PageLayout.tsx`, each with a co-located `*.module.scss`.
- Test: co-located `*.test.tsx` for `Text`, `Badge`, `SegmentedMeter`, `ErrorState`.

**Interfaces:**
- Produces (named exports, `type XProps`): `Text` (variant/as/tone/weight — ported); `Button`/`IconButton` (`type="button"`, `label` required on IconButton); `TextInput`/`Select`/`Label`/`Field`; `Badge` (`tone: "running"|"stopped"|"done"|"failed"|"review"` → themed pill); `SegmentedMeter` (`value:number, total:number, tone?:"accent"|"warn", segments?=22` → the LED meter, `role="progressbar"` with `aria-valuenow/max`); `ErrorState` (`role="alert"`, title/message/onRetry); `ThemeToggle`; `PageLayout`/`PageHeader`.

- [ ] **Step 1: Write failing tests** — `SegmentedMeter` lights `round(value/total*segments)` blocks and exposes `aria-valuenow`; `Badge` renders the status label with the right tone class; `Text` maps variant→class; `ErrorState` shows the message and calls `onRetry`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the components using only token vars; mono font for data, Bitter for `Text variant="display|title"`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add vintage atomic component library`

---

### Task 3: HTTP client, React Query infra, Zod schemas

**Files:**
- Create: `src/lib/http/api-client.ts`, `src/lib/http/api-error.ts`, `src/lib/api-client.ts` (the configured dashboard client), `src/lib/query-client.ts`, `src/lib/query-retry.ts`, `src/lib/schemas.ts` (shared Zod: `recipeSchema`, `projectSchema`, `runSchema`, `itemSchema`, `runDetailSchema`, `previewTextSchema`, `previewImageSchema`, `driveStatusSchema`, run-event schemas).
- Test: `src/lib/http/api-client.test.ts`, `src/lib/schemas.test.ts`.

**Interfaces:**
- Produces: `createApiClient({ baseUrl, fetchFn?, timeoutMs? })` → `{ get<T>(path,{schema,signal}), post<T>(path,{body,schema,signal}), del(path,{signal}) }` — builds the request, maps failures to one `ApiError {kind,status}`, parses JSON, runs `schema.safeParse`, re-throws caller cancellations. `dashboardClient = createApiClient({ baseUrl: import.meta.env.VITE_API_BASE ?? "http://localhost:5174" })`. `fetchFn` injectable for tests. Zod schemas mirror the API shapes above; export inferred types (`Project`, `Run`, `RunItem`, `RunDetail`, `TextPreview`, `ImagePreview`, `RunEvent`, `DriveStatus`).

- [ ] **Step 1: Write failing tests** — client parses a valid JSON body against a schema; a shape mismatch throws `ApiError{kind:"shape"}`; an HTTP 409 throws `ApiError{kind:"http",status:409}`; `recipeSchema`/`runSchema` accept a valid payload and reject a bad enum.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (port the crypto-dashboard client; add `post`/`del`). 
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add typed HTTP client, query infra, and Zod schemas`

---

### Task 4: App shell, router, theme store

**Files:**
- Create: `src/app/App.tsx`, `src/app/providers.tsx`, `src/app/routes.tsx`, `src/components/organisms/Sidebar.tsx`, `src/stores/use-preferences-store.ts` (theme + grain), `src/app/theme.ts` (apply `data-theme`); modify `index.html` pre-paint script + `main.tsx`.
- Test: `src/app/App.test.tsx`, `src/stores/use-preferences-store.test.ts`.

**Interfaces:**
- Produces: `App` (named export) rendering `providers` (QueryClientProvider + RouterProvider) → a `PageLayout` with `Sidebar` (nav: Runs / Projects / Settings · Drive) and routed content; routes `/` (Runs), `/projects`, `/projects/new` (Builder), `/settings`. `usePreferencesStore` (Zustand `persist`, key `scrapr-preferences`, `partialize` to `{theme, grain}`); grain toggle flips a `data-grain` attribute. Pre-paint script applies the saved theme before first paint.

- [ ] **Step 1: Write failing tests** — `App` renders the sidebar nav with links to the four sections; the preferences store toggles theme/grain and persists (mock localStorage); default theme is dark.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** shell/router/store; add react-router.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add app shell, routing, and theme store`

---

### Task 5: Runs feature — list & cards

**Files:**
- Create: `src/features/runs/` (`api/runs-api.ts`, `hooks/runs-keys.ts`, `hooks/use-runs.ts`, `hooks/use-run.ts`, `components/RunsPage.tsx`, `components/RunCard.tsx`, `components/RunGroup.tsx`, `components/StatStrip.tsx`, `types.ts`, `index.ts`).
- Test: `src/features/runs/components/RunsPage.test.tsx`, `RunCard.test.tsx`.

**Interfaces:**
- Consumes: `dashboardClient`, schemas (Task 3), atoms (Task 2).
- Produces: `fetchRuns(signal)`→`Run[]`, `fetchRun(id,signal)`→`RunDetail`; `runKeys` factory; `useRuns()`/`useRun(id)` React Query hooks; `RunsPage` (the `/` screen) grouping runs into **Running** / **Stopped – resumable** / **Recent** with a `StatStrip` (running / queued items / done today / failing hosts) and a "+ New run" / "Import list" header; `RunCard` (name, content-type tag, `Badge`, `SegmentedMeter` for progress, counts in mono, action buttons area). Presentational cards are prop-driven; `RunsPage` holds the query calls.

- [ ] **Step 1: Write failing tests** — `RunsPage` with an injected client (stub `fetchRuns`) renders a running run in the Running group with a progressbar and its counts, a stopped run in the resumable group, and a done run in recent; empty state when no runs.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the feature; render via the design-system atoms.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add runs list and run cards`

---

### Task 6: Live run events + run actions

**Files:**
- Create: `src/features/runs/hooks/use-run-events.ts` (WS), `src/features/runs/hooks/use-run-actions.ts` (start/stop/resume mutations); modify `RunCard.tsx`/`RunsPage.tsx` to wire actions + live updates.
- Test: `src/features/runs/hooks/use-run-events.test.ts`, `use-run-actions.test.ts`, updated `RunCard.test.tsx`.

**Interfaces:**
- Consumes: `VITE_WS_BASE`, `dashboardClient`, `runKeys`.
- Produces: `useRunEvents(runId, { enabled })` — opens `ws://…/api/ws?runId=`, parses `RunEvent`, and updates the React Query cache for that run (progress/item/state), reconnecting with backoff; a `WebSocket` factory is injectable for tests; **falls back to React Query `refetchInterval` when the socket is down** (Review Focus). `useRunActions()` → `{ start, stop, resume }` mutations hitting `/api/runs/:id/start|stop` (resume = start a stopped run), invalidating `runKeys` and surfacing a 409 as a typed error the card shows inline. `RunCard` shows Pause/Stop on running, **Resume** on stopped, nothing destructive on done.

- [ ] **Step 1: Write failing tests** — `useRunEvents` with an injected fake socket applies a `progress` event to the cached run and reconnects after a simulated close; `useRunActions.start` posts to the start endpoint and a 409 resolves to an inline error, not a throw to the user; `RunCard` shows Resume for a stopped run and calls start.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** hooks + wiring; backoff + polling fallback.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add live run events and start/stop/resume actions`

---

### Task 7: New run + enqueue/import

**Files:**
- Create: `src/features/runs/components/NewRunDialog.tsx`, `src/features/runs/components/ImportListDialog.tsx`, `src/features/runs/hooks/use-run-mutations.ts` (createRun, enqueue, import).
- Test: `NewRunDialog.test.tsx`, `use-run-mutations.test.ts`.

**Interfaces:**
- Produces: `useCreateRun()` (`POST /api/runs`), `useEnqueue(runId)` (`POST /api/runs/:id/items`, surfaces 409 for a running run), `useImport()` (`POST /api/runs/import`); `NewRunDialog` (pick a project → create run → optionally paste/enter URLs to enqueue); `ImportListDialog` (choose a sheet path → import into a new/selected run). Dialogs use `Field`/`TextInput`/`Select`; validate URLs client-side (http/https, non-empty) before submit.

- [ ] **Step 1: Write failing tests** — creating a run posts the chosen projectId and invalidates the runs list; enqueue into a running run shows the 409 message; empty url list is blocked client-side.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add new-run and import-list flows`

---

### Task 8: Projects feature

**Files:**
- Create: `src/features/projects/` (`api/projects-api.ts`, `hooks/projects-keys.ts`, `hooks/use-projects.ts`, `hooks/use-project-mutations.ts`, `components/ProjectsPage.tsx`, `components/ProjectCard.tsx`, `types.ts`, `index.ts`).
- Test: `ProjectsPage.test.tsx`, `use-project-mutations.test.ts`.

**Interfaces:**
- Produces: `fetchProjects`/`fetchProject`, `projectKeys`, `useProjects()`, `useCreateProject()`/`useUpdateProject()`/`useDeleteProject()` (delete surfaces **409** "has runs" inline); `ProjectsPage` (list recipes with a content-type tag + "New project" → `/projects/new`); `ProjectCard` (name, target host(s), a "New run from this" action, delete).

- [ ] **Step 1: Write failing tests** — `ProjectsPage` lists projects from an injected client; delete on a project with runs shows the 409 message; "New project" navigates to the builder.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add projects list and mutations`

---

### Task 9: Project builder (image-first) with live test

**Files:**
- Create: `src/features/builder/` (`hooks/use-preview.ts`, `components/BuilderPage.tsx`, `components/DetectFilter.tsx`, `components/ImageCandidateGrid.tsx`, `components/ImageRuleForm.tsx`, `components/TextFieldList.tsx`, `components/UnenforcedWarning.tsx`, `components/SaveProjectBar.tsx`, `types.ts`, `index.ts`).
- Test: `BuilderPage.test.tsx`, `ImageCandidateGrid.test.tsx`, `ImageRuleForm.test.tsx`, `use-preview.test.ts`.

**Interfaces:**
- Consumes: `POST /api/preview/image` + `/api/preview/text`, `GET /api/thumb?url=`, `useCreateProject` (Task 8).
- Produces: `usePreviewImage()`/`usePreviewText()` mutations; `BuilderPage` — paste URL + `DetectFilter` (Images / Text / Links / Tables scope) → "Fetch & detect" → **image-first**: `ImageCandidateGrid` renders each candidate as a thumbnail via `/api/thumb?url=` with a keep/drop checkbox and dimensions. **Keep/drop is a test-page preview affordance that DERIVES a generalizing rule, not a stored list of URLs** (the run can't reference specific test-page images — it enforces url/bytes + min dimensions). `ImageRuleForm` holds the actual saved rule — min width/height (pre-filled from the smallest kept / largest dropped image so it separates them), include/exclude URL substring — and the grid re-highlights which candidates the current rule would keep so the operator sees the rule generalize. Selector/position inputs are shown **disabled or clearly marked preview-only**; `UnenforcedWarning` renders the preview's `unenforcedRuleKeys`. A **Text** tab uses `TextFieldList` (toggle detected fields with their values). `SaveProjectBar` assembles the `recipe` (name, contentType, `image.rules` from the ImageRuleForm + pipeline, or `text`, + output defaults) and calls `useCreateProject`; "Re-test on another URL" re-runs preview against the saved rule. A broken thumbnail shows a placeholder.

- [ ] **Step 1: Write failing tests** — pasting a URL and fetching renders candidate thumbnails whose `src` points at `/api/thumb?url=<encoded>`; dropping the small/ad images raises the derived `minWidth` so the grid re-highlights only the kept ones; editing `ImageRuleForm` changes which candidates are highlighted; `unenforcedRuleKeys:["excludeSelector"]` renders the warning and the selector input is marked preview-only; Save posts a recipe whose `image.rules` holds the min-dimension/url rule (NOT a list of specific test-page image URLs); a 404 thumbnail falls back to a placeholder (no crash).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the builder; keep heavy preview calls behind injected hooks for tests.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): add image-first project builder with live preview`

---

### Task 10: Settings & Drive

**Files:**
- Create: `src/features/settings/` (`api/drive-api.ts`, `hooks/use-drive-status.ts`, `components/SettingsPage.tsx`, `components/DriveStatusCard.tsx`, `components/AppearanceCard.tsx`, `index.ts`).
- Test: `SettingsPage.test.tsx`.

**Interfaces:**
- Produces: `useDriveStatus()` (`GET /api/drive/status`); `SettingsPage` — `DriveStatusCard` (connected / not-connected with the `authorize.mjs` hint and the credential/token paths) and `AppearanceCard` (theme + grain toggles from `usePreferencesStore`). No OAuth is performed in-app (status only).

- [ ] **Step 1: Write failing tests** — connected status shows "connected"; disconnected shows the `authorize.mjs` hint; the grain toggle flips the preference.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS, then full `cd dashboard/web && npm test` + `npm run build` green.
- [ ] **Step 5: Commit** — `feat(web): add settings and Drive status`

---

## Done when

- `cd dashboard/web && npm test` passes and `npm run build` is clean (types + lint).
- Running the backend (`dashboard/server`) + `dashboard/web` dev server, the operator can: see runs grouped with live segmented-meter progress, resume a stopped run, create/import a run, build and **test** an image-first project (paste URL → thumbnail grid → pick images + rules → save) with the preview-only warning for selector/position rules, browse projects, and see Drive status — all in the vintage dark theme.
- Thumbnails load through `/api/thumb`; a WS drop degrades to polling, not a frozen UI; a Zod/HTTP failure shows an ErrorState with retry.

## Notes

- This plan does not add authentication, hosting, or the SSRF/arbitrary-path gating the backend deferred — those remain pre-hosting work.
- A one-command dev launcher (run server + web together) and an end-to-end smoke test against a live backend are reasonable follow-ups once both halves are on `main`.
