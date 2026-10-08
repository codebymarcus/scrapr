# Scraper Enhancement Roadmap — Audit vs. Current Code

**Date:** 2026-10-08
**Purpose:** Map a proposed enhancement roadmap (P0–P4) against what the codebase
already does, so new work builds on existing pieces instead of re-inventing them.
Status legend: ✅ done · 🟡 partial · ⬜ missing.

## Domain framing (important)

This is a **web content scraper driven through a real browser**. Today it scrapes
**comic/manga reader images**, but the architecture must **not** bake in an
image-only assumption: **text scraping (strip HTML → Markdown/plaintext) is a
planned future content type** — lower priority, built later, but the core schema
and extraction/output seams are designed to accept it now.

- **Content-agnostic schema:** Collection → Item → **Content[]**, where a Content
  block is an **image page** (today) or a **text block** (future). Shared
  metadata (title, source URL, ordering) sits above the content type.
- **Pluggable extraction by content type:** passive image-capture is one
  *content extractor*; an **HTML→Markdown extractor** slots into the same seam
  later. The profile/adapter declares which content kind(s) an item yields.
- **Extensible output:** cbz/pdf for images today; the seam stays open for
  `.md`/`.txt` text outputs later without reworking the core.
- **Scope now:** build the seams (content-type field, content-extractor
  interface, output-type hook) but implement **images only**. Text is documented
  as the next content type with a clear insertion point — not built yet.

## P0 — Foundation
| Item | Status | Where it stands |
|---|---|---|
| Universal Data Schema | ⬜ | No Collection/Item/Content/Metadata model. Output is image buffers → cbz/pdf; only `job={url,name,status}` + capture entries. `ScrapingResult` is control-flow, not content. |
| Site Adapter Architecture | 🟡 | `strategies/` + `orchestrator` + `registry` separate *how to scrape*, but logic is per-strategy, not per-site; batcave specifics live in `chapter-aware.mjs`. No per-host adapter. |
| Config-Driven Extraction | 🟡 | `config.mjs` exposes `countSelector`, `advanceKey`, `forcePages`, `hostFilter`, `issuePrefix`, `minBytes` — **global, not per-site**; no URL-pattern/pagination rules. |
| Request/Browser Layer | 🟡 | `browser.mjs` (launch/UA/stealth) + `navigation.mjs` (retry/backoff) + `capture.mjs` (429/503). No cookie/profile persistence, no concurrency, no non-browser HTTP path. |
| Validation & Data Quality | 🟡 | `result-validator.mjs` + `missingPages` + empty-buffer drop validate **page** completeness; no chapter/series-count sanity (no series layer exists). |

## P1
| Item | Status | Where it stands |
|---|---|---|
| Selector Fallbacks | 🟡 | `countSelector` comma-list; `chapter-aware.detectTotal` falls back "Page X/N" → count → `forcePages`. Ad hoc, not general. |
| Metadata Extraction | ⬜ | Title/count read only in throwaway probes; nothing in `src/` (no OG/JSON-LD/meta). |
| Pagination Engine | 🟡 | Two advance modes (keyboard in `reader.mjs`, hash in `chapter-aware.mjs`). No scroll/load-more/next-link; not generalized. |
| URL Normalization & Dedup | 🟡 | Image dedup by URL (`images.has`) + `PageCache` keyed by URL. No URL normalization, no chapter-level dedup. |
| Caching & Incremental | 🟡 | `cache.mjs` resume + SheetSource `done/skip` → incremental at row/page level. No content-change detection / only-new-chapters. |
| Rate Limiting & Backoff | 🟡 | Strong reactive: 429/503 detection + exp backoff + `retry-after` + settle/jitter/itemDelay. Missing concurrency control / global adaptive limiter. |
| Persistent Browser Profiles | ⬜ | Fresh context each run (no `userDataDir`/`storageState`). |

## P2
| Item | Status | Where it stands |
|---|---|---|
| Automatic Site Detection | ⬜ | No URL→adapter mapping (needs adapters first). |
| Generic DOM Heuristics | 🟡 | `countSelector` + issue-dir lock + `minBytes` infer page images; no title/chapter inference. |
| API/Embedded Data Detection | ⬜ | DOM/network-image capture only. |
| Browser Escalation (HTTP→browser) | ⬜ | Always launches a browser. Architecture-ready as an "http-first" strategy — high ROI for metered proxy. |
| Circuit Breaker | ⬜ | No per-domain failure tracking. |
| Scraper Health Monitoring | 🟡 | Per-run summary + bandwidth + attempts log; no cross-run metrics / site-change detection. |
| Structured Logging / Job IDs | 🟡 | Leveled logger + `--log-file` + attempts log; no job IDs, not JSONL/structured. |

## P3 — all ⬜ missing
Self-Healing Selectors · Confidence Scoring · LLM-Assisted Extraction · Scraper
Learning · Visual Debugger (`--headed` lets you watch, no element highlighting) ·
Scraper Studio.

## P4 — all ⬜ missing
Distributed Queue (explicit non-goal in the strategy spec) · Scheduling (designed
in the unbuilt `2026-09-24-hosted-scraper-triggers` spec) · Change Detection ·
Multi-Source Reconciliation.

**Tally: 0 fully done, ~12 partial, ~16 missing.** The bones (strategy pipeline,
backoff, caching, validation, packaging) are solid; the generalize + observe +
self-heal layers are open.

## Considerations
1. **Cost beats concurrency here.** Metered proxy (`costPerGb`), deliberately
   single-threaded/polite. Parallelism/queues multiply proxy cost and site load;
   **Browser Escalation (HTTP-first)** *cuts* cost — likely higher ROI than
   concurrency.
2. **One dependency spine.** P0 Universal Schema + Site Adapter + Config-Driven is
   one foundation layer ("Site profiles"). Auto Site Detection, Selector
   Fallbacks, Generic Heuristics, Self-Healing, Confidence, LLM-assist all hang
   off it — build it first to unlock that column.
3. **Cheap finishers (~80% there):** Structured logging + Job IDs (add `jobId` +
   a JSONL sink to the logger), Circuit Breaker (reuses `FailureCode`), Budget cap
   (metering exists), chapter-count Validation (once a series layer exists).

## Chosen sub-projects → roadmap mapping & order
1. **Site profiles** → P0 *Site Adapter* + P0 *Config-Driven Extraction* +
   content-agnostic *Universal Schema* + P1 *Selector Fallbacks*; unlocks P2
   *Auto Site Detection*. (Images-only build, text-ready seams.)
2. **Metadata + auto-naming** → P1 *Metadata Extraction* (feeds the schema).
3. **Failure-aware selection** → shares machinery with P2 *Browser Escalation* +
   P2 *Circuit Breaker* + P3 *Confidence*.

Deferred (big, low ROI for a single-operator tool): Studio, LLM-assist,
self-healing, distributed queue, multi-source reconciliation.
