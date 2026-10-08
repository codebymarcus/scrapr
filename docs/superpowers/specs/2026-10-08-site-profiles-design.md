# Site Profiles — Design

**Date:** 2026-10-08
**Status:** Draft for review
**Author:** Mark Aquiatin (with Claude)
**Related:** [roadmap audit](../notes/2026-10-08-roadmap-audit.md) ·
[multi-stage scraping strategies](2026-09-25-multi-stage-scraping-strategies-design.md)

---

## 1. Purpose & Intent

Today each site's scraping knowledge is hard-coded inside the strategy modules:
`chapter-aware.mjs` embeds batcave-specific behaviour (`#page-N` addressing, the
"Page X / N" counter, the underscore filename format), and the pipeline that runs
for a job is a single **global** list (`config.strategies`, default
`[current, chapter-aware]`) applied to every URL regardless of site.

**Goal:** introduce a **site profile** layer — per-site *data* that declares, in
order, which scraping **mechanisms** to use for that site — so adding or adjusting
a site is mostly declarative instead of editing core logic. The existing
orchestrator, result-validator, and image-capture are reused unchanged; a profile
simply supplies the orchestrator's mechanism list **per job**, resolved from the
job's URL. This is the foundation layer the roadmap calls *Site Adapter
Architecture* + *Config-Driven Extraction* + (a comics-scoped) *Universal Schema*
+ *Selector Fallbacks*.

### Content-agnostic from day one (text-ready, images-only build)

The scraper currently produces **images** (comic/manga pages). The architecture
must **not** bake in an image-only assumption: **text scraping (strip HTML →
Markdown/plaintext) is a planned future content type** — lower priority, built
later, but the schema and extraction/output seams accept it now.

- A profile declares `contentType` (`"image"` today; `"text"` later).
- Extraction is pluggable by content type: passive image-capture is one
  content-producing mechanism; an `html-markdown` mechanism slots into the same
  seam later.
- Output dispatches on `contentType` (cbz/pdf for images now; `.md`/`.txt`
  later).
- **This phase builds images only.** Text is documented as the next content type
  with a clear insertion point and is explicitly out of scope here.

### Agreed context (from brainstorming)

| Question | Decision |
|---|---|
| How is a site described? | **Hybrid** — a declarative profile (JS module, mostly data) that selects named, code-backed mechanisms, with optional function hooks for tricky sites. |
| What does v1 target? | **Batcave + a generic default profile.** Build the framework, convert batcave into a profile, ship a generic `current` (keyboard-advance) profile for everything else. Add real site profiles later. |
| How do profiles integrate? | **Approach A** — a profile supplies the orchestrator's mechanism pipeline per job; orchestrator/validator/capture reused unchanged. |
| Content scope | **Images only now**, content-agnostic seams for text later. |

### Non-goals (this phase)

- Text / HTML→Markdown extraction (the designed-for next content type — not built).
- Metadata extraction & auto-naming (separate sub-project #2; this phase only
  defines the `metadata` seam on the profile).
- Failure-aware strategy *selection*, circuit breaker, HTTP-first escalation
  (sub-project #3).
- Automatic site detection beyond simple host matching, generic DOM heuristics,
  self-healing, confidence scoring, LLM assist, Studio (later roadmap items).
- Concurrency, queues, scheduling, persistent browser profiles.
- User-defined profiles loaded from `scraper.config.json` (built-in profile
  modules only in v1; config can still override the pipeline globally — see §7).

---

## 2. What exists today (reused vs. changed)

| Concern | Module | This phase |
|---|---|---|
| Orchestrator (retry/fallback, attempts) | `src/orchestrator.mjs` | **Reused unchanged** |
| Result validator (completeness) | `src/result-validator.mjs` | **Reused unchanged** |
| Image capture (passive, dir-lock, backoff) | `src/capture.mjs` | **Reused unchanged** |
| Mechanisms (the two strategies) | `src/strategies/browser-keyboard.mjs`, `chapter-aware.mjs` | **Gain a `params` bag** (merged over config) |
| Strategy registry | `src/strategies/registry.mjs` | **Evolves**: `STRATEGY_FACTORIES` → `MECHANISMS` (`name → (params)=>strategy`) |
| Per-job run | `src/pipeline.mjs` (`BatchRunner`, `scrapeJob`) | **Per-job profile resolution**; thread `contentType`/`metadata` |
| Config | `src/config.mjs` | `strategies` becomes a global **override** of the profile pipeline (kept for back-compat) |
| Packaging / naming | `src/packagers.mjs`, `src/naming.mjs` | **Unchanged** (dispatch on `contentType`; only `image` exists) |

New: `src/profiles/` (profile modules + registry).

---

## 3. Profile shape

Profiles are JS modules — mostly object literals (declarative), with function
hooks where a site needs logic. Lean v1 shape:

```js
// src/profiles/profile.mjs — shape & helpers
export const ContentType = Object.freeze({ IMAGE: "image" /* TEXT: "text" — future */ });

// hostMatch("batcave.biz") → (url) => hostname === or endsWith ".batcave.biz"
export function hostMatch(...hosts) {
  const set = hosts.map((h) => h.toLowerCase());
  return (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return set.some((h) => host === h || host.endsWith(`.${h}`));
    } catch { return false; }
  };
}
```

```js
// src/profiles/batcave.mjs
import { hostMatch, ContentType } from "./profile.mjs";
export default {
  name: "batcave",
  match: hostMatch("batcave.biz"),
  contentType: ContentType.IMAGE,
  // ordered mechanism pipeline (becomes the orchestrator's strategy list)
  pipeline: [
    { mechanism: "chapter-aware", maxAttempts: 1, params: {} },
  ],
  // seam for sub-project #2 (metadata/auto-naming); unused this phase
  metadata: { title: /From:\s*(.+)/, count: /Page\s+\d+\s*\/\s*(\d+)/i },
};
```

```js
// src/profiles/generic.mjs — catch-all; == today's behaviour for non-batcave sites
import { ContentType } from "./profile.mjs";
export default {
  name: "generic",
  match: () => true,
  contentType: ContentType.IMAGE,
  pipeline: [ { mechanism: "current", maxAttempts: 2, params: {} } ],
  metadata: {},
};
```

Field contract:
- `name: string`
- `match: (url: string) => boolean`
- `contentType: "image"` (only value this phase)
- `pipeline: Array<{ mechanism: string, maxAttempts?: number, params?: object }>`
  (order = try order; `maxAttempts` defaults to the mechanism's
  `defaultMaxAttempts`)
- `metadata: object` (reserved seam; may be `{}`)

---

## 4. Mechanisms (parameterized strategies)

A **mechanism** is a factory `(params) => strategy`. The existing strategies
register as mechanisms under their current names, so committed config/tests keep
working:

```js
// src/strategies/registry.mjs (evolved)
import { BrowserKeyboardStrategy } from "./browser-keyboard.mjs";
import { ChapterAwareStrategy } from "./chapter-aware.mjs";

export const MECHANISMS = {
  current: (params) => new BrowserKeyboardStrategy({ params }),        // keyboard-advance
  "chapter-aware": (params) => new ChapterAwareStrategy({ params }),   // hash-addressing
};
```

Each strategy stores `this.params` (from its constructor options, default `{}`)
and merges it over the run config at execute time:

```js
// inside execute({ ..., config, ... })
const cfg = { ...config, ...this.params };   // profile params win over globals
```

Then the strategy reads its knobs (`cfg.advanceKey`, `cfg.countSelector`,
`cfg.settle`, …) from `cfg` instead of `config`. This lets a profile set per-site
knobs (e.g. a different `advanceKey` or `countSelector`) without changing globals,
and is a no-op when `params` is empty (today's behaviour).

Injectable collaborators (`openReader`, `ReaderDriver`, etc.) stay as they are —
the constructor accepts both: `new BrowserKeyboardStrategy({ params, openReader? })`.

---

## 5. Profile registry & resolution

```js
// src/profiles/registry.mjs
import batcave from "./batcave.mjs";
import generic from "./generic.mjs";
import { MECHANISMS } from "../strategies/registry.mjs";

export const PROFILES = [batcave, generic]; // first match wins; generic is last

export function resolveProfile(url, profiles = PROFILES) {
  return profiles.find((p) => { try { return p.match(url); } catch { return false; } })
    || generic;
}

// Build the orchestrator's [{ strategy, maxAttempts }] list for a job.
// Back-compat: a global config.strategies overrides the profile's pipeline.
export function resolvePipeline(profile, config, logger, mechanisms = MECHANISMS) {
  const specs = Array.isArray(config?.strategies) && config.strategies.length
    ? config.strategies                 // global override (existing behaviour)
    : profile.pipeline;
  const out = [];
  for (const spec of specs) {
    if (!spec || typeof spec.mechanism !== "string" && typeof spec.name !== "string") {
      logger?.warn?.(`ignoring invalid pipeline entry: ${JSON.stringify(spec)}`);
      continue;
    }
    const key = spec.mechanism || spec.name; // profile uses `mechanism`; config override uses `name`
    if (spec.enabled === false) continue;
    const make = mechanisms[key];
    if (!make) { logger?.warn?.(`unknown mechanism "${key}" — skipping`); continue; }
    const strategy = make(spec.params || {});
    const maxAttempts = Number.isInteger(spec.maxAttempts) ? spec.maxAttempts
      : (strategy.defaultMaxAttempts ?? 1);
    if (maxAttempts < 1) continue; // 0 disables
    out.push({ strategy, maxAttempts });
  }
  return out;
}
```

`resolvePipeline` accepts both the profile's `{ mechanism }` entries and the
config-override's `{ name }` entries (the shape `resolveStrategies` used), so the
global override path is unchanged for existing users.

---

## 6. Pipeline integration (`pipeline.mjs`)

`BatchRunner` moves pipeline construction from once-per-run to **per-job** (the
profile depends on the URL):

```js
// in _runJobs, per job, before calling _scrapeJob:
const profile = this._resolveProfile(job.url);
const strategies = this._resolvePipeline(profile, this.config, this.logger);
if (!strategies.length) { this.logger.error(`no mechanisms for ${job.url}`); /* mark retry */ }
const orchestrator = new ScrapingOrchestrator(strategies, this._validate, this.logger);
this.logger.verbose?.(`profile=${profile.name} contentType=${profile.contentType} pipeline=[${strategies.map(s=>s.strategy.name).join(", ")}]`);
const r = await this._scrapeJob(session, job, this.config, processor, packagers, uploader, this.logger, orchestrator, profile);
```

- Injectable seams on `BatchRunner`: `_resolveProfile`, `_resolvePipeline`
  (default to the registry fns), alongside the existing `_validate`/`_scrapeJob`.
  The one-time `run()`-level `resolveStrategies` + empty-guard is removed (the
  per-job resolution replaces it; an empty per-job pipeline marks that row retry
  and continues the batch rather than aborting the run).
- `scrapeJob` gains a trailing `profile` arg and threads `profile.contentType`
  onto its return (`{ ..., contentType }`). For `contentType === "image"` the
  package/upload/cleanup path is exactly as today. Packaging dispatch is a thin
  guard: non-image content types are not produced this phase, so a defensive
  `if (contentType !== "image") throw new Error("unsupported contentType")`
  documents the seam.

CLI output gains one line per job: `profile=<name> pipeline=[…]`.

---

## 7. Backward compatibility & deliberate behaviour change

- **Per-site pipelines replace the global default.** Today every site runs
  `[current, chapter-aware]`. After this:
  - **batcave → `[chapter-aware]`** — drops the keyboard pass that always fails on
    batcave (it only ever reached 1/29), so batcave is faster and no longer wastes
    a Stage-1 attempt.
  - **every other site → `[current]`** — drops `chapter-aware`, whose
    `#page-N` addressing only works on batcave-style readers.
  This is intended: pipelines are now correct per site.
- **`config.strategies` still works as a global override.** If set, it applies to
  all jobs exactly as before (via `resolvePipeline`'s override branch), so any
  existing config keeps its behaviour. Document that profiles are the new default
  and `strategies` overrides them.
- `scraper.config.example.json`: update the `strategies` comment to explain it now
  **overrides** the per-site profile pipeline.
- `src/strategies/registry.mjs`: `DEFAULT_PIPELINE` and `resolveStrategies` are
  removed/replaced by `MECHANISMS` + the profile registry. Their unit tests are
  replaced by profile/registry tests (§9).

---

## 8. Content & metadata seam (not built this phase)

- `contentType` is defined on the profile and threaded onto the job result; only
  `"image"` is produced. Adding text later: a `"text"` profile `contentType`, an
  `html-markdown` content-producing mechanism, and a markdown/text packager keyed
  on `contentType` — no change to profile resolution or the orchestrator.
- `profile.metadata` is a reserved object (selectors/patterns) consumed by
  sub-project #2 (metadata + auto-naming). This phase defines and carries it but
  does not read it.

---

## 9. Testing

`node --test`, fakes, no real browser (mirrors existing tests).

New:
- `test/profiles.test.mjs`
  - `hostMatch`: exact host, subdomain (`.batcave.biz`), non-match, bad URL.
  - `resolveProfile`: a batcave URL → batcave; any other URL → generic; bad URL →
    generic; order (first match wins).
  - content type: batcave & generic both `"image"`.
- `test/profile-registry.test.mjs` (or fold into profiles.test)
  - `resolvePipeline(batcave)` → one entry, mechanism `chapter-aware`,
    maxAttempts 1; `resolvePipeline(generic)` → `current`, maxAttempts 2.
  - params are passed into the mechanism (fake `MECHANISMS` capturing params).
  - **override:** `config.strategies = [{name:"current"}]` → used instead of the
    profile pipeline; unknown mechanism warned+skipped; `maxAttempts:0` disables.
- Mechanism params: a strategy with `params:{advanceKey:"ArrowDown"}` reads
  `ArrowDown` even when `config.advanceKey` differs (unit-test the merge via the
  existing fake-page strategy tests).
- `test/pipeline.test.mjs` additions: `BatchRunner` resolves the profile **per
  job** — inject fake `_resolveProfile`/`_resolvePipeline`, assert a batcave URL
  yields the `chapter-aware` mechanism and a generic URL yields `current`; assert
  `scrapeJob`'s result carries `contentType: "image"`.

Changed/removed:
- Replace `test/registry.test.mjs` (which tested `resolveStrategies`/
  `DEFAULT_PIPELINE`) with the profile-registry tests above.

Unchanged suites (orchestrator, validator, capture, processor, strategy contract)
must stay green.

Live smoke (manual, documented): batcave `/395` still downloads 29/29 via the
batcave profile; a non-batcave reader still runs `current`.

---

## 10. File structure

```
src/profiles/
  profile.mjs          NEW  ContentType, hostMatch, shape docs
  batcave.mjs          NEW  batcave profile ([chapter-aware])
  generic.mjs          NEW  generic default ([current])
  registry.mjs         NEW  PROFILES, resolveProfile, resolvePipeline
src/strategies/
  registry.mjs         EDIT STRATEGY_FACTORIES → MECHANISMS (params); drop DEFAULT_PIPELINE/resolveStrategies
  browser-keyboard.mjs EDIT accept { params }, merge over config at execute
  chapter-aware.mjs    EDIT accept { params }, merge over config at execute
src/pipeline.mjs       EDIT per-job profile resolution; thread contentType; drop run()-level resolveStrategies
src/config.mjs         EDIT comment: strategies now overrides the profile pipeline
scraper.config.example.json  EDIT document the override semantics
test/profiles.test.mjs            NEW
test/profile-registry.test.mjs    NEW
test/pipeline.test.mjs            EDIT per-job profile resolution + contentType
test/registry.test.mjs            REPLACE with profile-registry coverage
```

---

## 11. Acceptance criteria

- A job's scraping pipeline is resolved from its URL via a profile; batcave uses
  `[chapter-aware]`, everything else uses `[current]`.
- Adding a new site = add a profile module + one registry line; no change to the
  orchestrator/validator/capture.
- Profiles carry per-site mechanism params that override globals at execute time.
- `config.strategies`, when set, still overrides the pipeline globally (back-compat).
- `contentType` is defined on profiles and threaded through results; packaging is
  content-type-dispatched (image only), with a documented seam for text.
- batcave `/395` still scrapes 29/29; full existing test suite stays green; new
  profile/registry/pipeline tests pass.
- No concurrency, queues, scheduling, metadata extraction, or text extraction
  introduced.
