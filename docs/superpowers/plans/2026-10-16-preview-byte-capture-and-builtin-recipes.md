# Preview Byte-Capture + Built-in Recipe Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's image preview show thumbnails for aggressively-protected sites (whose images only load in-page and 403 every out-of-page fetch), and tell the operator when a pasted URL is already handled by a built-in engine recipe so they can run it directly instead of hitting a dead generic preview.

**Architecture:** Two independent improvements. (1) **Byte-capture preview** — `imagePreview` captures image bytes from the page's own network responses (the only way protected sites yield images), downscales each to a small data-URI thumbnail with `sharp`, and returns them on the candidates; the builder shows the data URI and only falls back to the `/api/thumb` referer proxy when no bytes were captured. No cache or new endpoint needed. (2) **Built-in recipe detection** — the preview responses report whether the URL matches a non-generic engine profile (`resolveProfile`), the builder surfaces a "use the built-in recipe" shortcut, and a run can be created that uses the engine's own URL-matched profile instead of a data recipe.

**Tech Stack:** Node ESM engine (`sharp`, Playwright — already deps), Fastify backend, React/TS + Zod frontend. Tests: `node --test` (engine/server), Vitest + Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-10-16-scraper-dashboard-design.md` (§7.4 builder). Builds on the merged engine/backend/frontend and the committed thumbnail-referer fix (`515b610`).

## Global Constraints

- Engine/server: Node ESM, named exports, 2-space indent, double quotes, trailing commas. Web: React named exports, `type XProps`, `import type`, no fetch in components, Zod-validated responses, token-only colors, a11y. Everything injectable for tests (no real browser/network in tests).
- **Behavior-preserving:** the referer proxy path stays the fallback and is unchanged when no captured bytes exist. Sites that worked before keep working.
- Data-URI thumbnails must be **bounded**: downscale (e.g. max width ~320px) and skip the data URI for anything still over a cap (those fall back to the proxy), so preview responses stay small.
- Built-in recipe detection must not change how existing data-recipe runs resolve.

## Review Focus

- **A protected site (batcave): bytes captured in-page → data-URI thumbnails render** without any out-of-page fetch. Pinned in Tasks 1 + 3.
- **An ordinary site with no in-page capture** → candidates still come from the DOM and thumbnails fall back to the `/api/thumb?...&referer=` proxy (unchanged). Pinned in Tasks 1 + 3.
- **A huge image** → no multi-MB data URI in the response; it falls back to the proxy. Pinned in Task 1.
- **A built-in-recipe URL** → the builder shows the shortcut and a built-in run resolves via the engine's profile, not a bound empty recipe. Pinned in Tasks 4 + 5.
- **A Zod/shape mismatch** on the widened preview response → ErrorState, not a crash. Pinned in Task 3.

---

### Task 1: Engine — capture in-page image bytes as downscaled data-URI thumbnails

**Files:**
- Modify: `src/preview/image-preview.mjs`
- Test: `test/image-preview.test.mjs`

**Interfaces:**
- Consumes: a Playwright `page` (its `on("response")` + `evaluate`), `openReader`, `sharp` (already an engine dep via `src/processor.mjs`).
- Produces:
  - `captureImageBytes(page, deps = {}): Map<string, { buffer, contentType }>` — attaches a `response` listener collecting image responses (resourceType image or `content-type: image/*`, `ok`, not `data:`), reading `resp.body()`; deduped by URL; bounded by a max raw size. Returns the map after the caller has driven the page (listener attached before `openReader`). Injectable collection for tests.
  - `async toThumbnail(buffer, contentType, deps = {}): string | null` — downscale to max width 320 via `sharp(buffer).resize({ width: 320, withoutEnlargement: true }).toBuffer()` and return a `data:<type>;base64,...` URI; returns `null` on failure or if the result exceeds a cap (`THUMB_DATA_CAP`, ~64KB). `sharp` injectable.
  - `imagePreview(...)` now: attach `captureImageBytes` **before** `openReader`; after collecting DOM candidates (unchanged `collectCandidateImages`), **merge** network-captured URLs not already present (as extra candidates with width/height 0, selector ""), and for every candidate whose URL was captured, attach `thumbnail` (data URI from `toThumbnail`). Candidates keep `{ url, width, height, selector, index, thumbnail? }`. Returns `{ status, via, images }` as before (now with optional `thumbnail`). Not-captured candidates have no `thumbnail` (frontend proxies them).

- [ ] **Step 1: Write failing tests** — `captureImageBytes` collects image responses from a fake page emitting `response` events (image + non-image), deduped, and ignores over-cap bodies; `toThumbnail` returns a `data:image/...;base64,` string for a small buffer (inject a fake sharp) and `null` when over cap; `imagePreview` attaches `thumbnail` to a candidate whose URL was captured and leaves it absent otherwise (inject fake page/openReader/sharp).
- [ ] **Step 2: Run** `node --test test/image-preview.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the two helpers + the merge/attach in `imagePreview`.
- [ ] **Step 4: Run** `node --test test/image-preview.test.mjs` → PASS; `node --test "test/**/*.test.mjs"` → green.
- [ ] **Step 5: Commit** — `feat(engine): capture in-page image bytes as data-URI thumbnails in image preview`

---

### Task 2: Backend — pass thumbnails through, report built-in recipe

**Files:**
- Modify: `dashboard/server/src/routes/preview.mjs`
- Test: `dashboard/server/test/preview.test.mjs`

**Interfaces:**
- Consumes: `imagePreview`/`previewText` (as today), `resolveProfile` from `../../../src/profiles/registry.mjs`.
- Produces: `POST /api/preview/image` response gains nothing to do for `thumbnail` (it is already inside each image object from Task 1 — just ensure it is not stripped). BOTH preview responses gain `builtInRecipe: string | null` = the resolved profile's name when `resolveProfile(url).name !== "generic"`, else `null`. (Compute from the request `url`.)

- [ ] **Step 1: Write failing tests** — image preview response includes a candidate's `thumbnail` passthrough (inject a fake imagePreview returning one) and `builtInRecipe:"batcave"` for a batcave URL, `null` for a generic URL; text preview also reports `builtInRecipe`.
- [ ] **Step 2: Run** `cd dashboard/server && node --test` → FAIL.
- [ ] **Step 3: Implement** — add `builtInRecipe` to both handlers via `resolveProfile`; confirm `thumbnail` is passed through untouched.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(server): report built-in recipe match and pass preview thumbnails through`

---

### Task 3: Frontend — prefer the data-URI thumbnail, fall back to the proxy

**Files:**
- Modify: `dashboard/web/src/lib/schemas.ts`, `dashboard/web/src/features/builder/components/ImageCandidateGrid.tsx`
- Test: `dashboard/web/src/features/builder/components/ImageCandidateGrid.test.tsx`, `dashboard/web/src/lib/schemas.test.ts`

**Interfaces:**
- Consumes: the widened preview response.
- Produces: `previewImageSchema` image items gain `thumbnail: z.string().optional()` and `builtInRecipe: z.string().nullish()` on the preview payload (and `ImagePreview`/`ImageCandidate` types). `ImageCandidateGrid` `Thumbnail` src = `candidate.thumbnail` when present, else `thumbUrl(apiBase, url, pageUrl)` (the referer proxy from `515b610`). The broken-image placeholder fallback is unchanged.

- [ ] **Step 1: Write failing tests** — a candidate with a `thumbnail` data URI renders an `<img>` whose `src` is that data URI (not `/api/thumb`); a candidate without one still uses the `/api/thumb?...&referer=` proxy; `previewImageSchema` accepts `thumbnail` + `builtInRecipe`.
- [ ] **Step 2: Run** `cd dashboard/web && npm test` → FAIL.
- [ ] **Step 3: Implement** schema + grid changes.
- [ ] **Step 4: Run** `npm test` + `npm run build` → green.
- [ ] **Step 5: Commit** — `feat(web): render captured data-URI thumbnails, proxy fallback`

---

### Task 4: Backend — built-in recipe runs

**Files:**
- Modify: `dashboard/server/src/schemas.mjs` (recipe), `dashboard/server/src/build-run-config.mjs`, `dashboard/server/src/run-manager.mjs`
- Test: `dashboard/server/test/build-run-config.test.mjs`, `dashboard/server/test/run-manager.test.mjs`

**Interfaces:**
- Consumes: engine `resolveProfile` (the default `BatchRunner` resolver), `boundResolver` (data recipes).
- Produces: `recipeSchema` gains `builtIn: z.boolean().optional()` and `builtInProfile: z.string().optional()`. `buildRunConfig(recipe, {runOutDir})`: a built-in recipe builds an image config with standard output defaults and **no `imageRules`/text wiring** (the engine profile drives it). The run manager, when `recipe.builtIn` is true, **omits `deps.resolveProfile`** so `BatchRunner` uses its own URL-matched `resolveProfile` (the built-in profile), instead of `boundResolver(recipe)`.

- [ ] **Step 1: Write failing tests** — `buildRunConfig` for a built-in recipe leaves url/listFile null, sets image output defaults, and sets no `imageRules`; the run manager does not pass a `resolveProfile` dep for a built-in recipe (assert via the injected runner factory capturing deps) but still does for a data recipe.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(server): support runs that use a built-in engine recipe`

---

### Task 5: Frontend — built-in recipe hint & shortcut

**Files:**
- Modify: `dashboard/web/src/features/builder/components/BuilderPage.tsx`, add `dashboard/web/src/features/builder/components/BuiltInRecipeNotice.tsx`
- Test: `dashboard/web/src/features/builder/components/BuilderPage.test.tsx`

**Interfaces:**
- Consumes: `builtInRecipe` from the preview response, `useCreateProject` + the run-create mutation (from the runs feature).
- Produces: when a fetch returns `builtInRecipe` non-null, the builder renders `BuiltInRecipeNotice` (role="note") — "This site has a built-in recipe (<name>). You can run it directly." — with a "Create a run with the built-in recipe" button that creates a built-in project (`{ name, contentType:"image", builtIn:true, builtInProfile:<name> }`) and a run bound to it, then navigates to Runs. The generic candidate grid is secondary when a built-in recipe exists.

- [ ] **Step 1: Write failing tests** — a preview returning `builtInRecipe:"batcave"` shows the notice naming batcave and a create-run button; clicking it posts a built-in project + a run; a `null` builtInRecipe shows no notice.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` + `npm run build` → green.
- [ ] **Step 5: Commit** — `feat(web): surface built-in recipe shortcut in the builder`

---

## Done when

- `node --test "test/**/*.test.mjs"`, `cd dashboard/server && node --test`, and `cd dashboard/web && npm test` + `npm run build` all pass.
- The image preview attaches in-page-captured data-URI thumbnails (verified end-to-end against a protected site: batcave's loaded pages display without any out-of-page fetch); ordinary sites still proxy via `/api/thumb?...&referer=`.
- Pasting a batcave URL shows a "built-in recipe" notice and can create a run that scrapes it via the engine's batcave profile.

## Notes

- Full enumeration of a reader's pages in the preview (driving `chapter-aware`/`#page-N`) remains out of scope; batcave's full chapter is captured by the built-in recipe at run time, which Task 4/5 route the operator to.
