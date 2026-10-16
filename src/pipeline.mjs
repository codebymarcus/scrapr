// Pipeline: wires the pieces together.
//   scrapeJob  — one URL end to end (open → drive → capture → process → package)
//   BatchRunner — iterates a JobSource, applies status logic, calls scrapeJob,
//                 records status, and reports a summary.
// The runner depends on abstractions (JobSource, Packager, ImageProcessor),
// which are constructed once and injected — so behaviour is easy to extend or
// swap without editing this file.
import { sleep, withJitter } from "./time.mjs";
import { BrowserSession } from "./browser.mjs";
import { ImageCapture } from "./capture.mjs";
import { ImageProcessor } from "./processor.mjs";
import { buildPackagers } from "./packagers.mjs";
import { createJobSource } from "./sources.mjs";
import { DriveUploader } from "./drive.mjs";
import { resolveTargets, resolveRecordBase } from "./naming.mjs";
import { PageCache } from "./cache.mjs";
import { BandwidthMeter, formatBandwidth } from "./bandwidth.mjs";
import sharp from "sharp";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ScrapingOrchestrator } from "./orchestrator.mjs";
import { scrapeText, resolveMode } from "./text/scrape-text.mjs";
import { RecordWriter } from "./text/records.mjs";
import { resolveProfile, resolvePipeline } from "./profiles/registry.mjs";
import { validate } from "./result-validator.mjs";
import { filterImages } from "./recipes/image-filter.mjs";
import { CircuitBreaker, hostOf, failureCodeOf } from "./breaker.mjs";
export { decideOutcome } from "./outcome.mjs";

// Which rows are left alone. Only blank or "retry" are crawled. Shared by the
// batch loop and the --dry-run preview so they never disagree.
export function skipReason(status) {
  if (status === "skip") return "skip";
  if (status === "done") return "already done";
  if (status && status !== "retry") return `status "${status}" — leaving alone`;
  return null;
}

// Build the --dry-run preview: one block per job describing what a real run
// would do (resolved output targets, skip reason, Drive destination) without
// launching the browser or contacting Drive.
export function describeDryRun(config, jobs) {
  const lines = [`dry run — ${jobs.length} job(s), nothing will be downloaded or uploaded:`];
  let driveDest = null;
  if (config.drive) {
    const root = config.driveFolder ? `folder ${config.driveFolder}` : "My Drive root";
    driveDest = config.driveSubfolder ? `${root} / "${config.driveSubfolder}"` : root;
  }
  jobs.forEach((job, i) => {
    const reason = config.listFile ? skipReason(job.status) : null;
    const targets = resolveTargets(config, job);
    lines.push(`(${i + 1}/${jobs.length}) ${job.url}`);
    if (reason) {
      lines.push(`    ${reason} — skipped`);
      return;
    }
    if (config.text) {
      const mode = config.textMode || "article";
      lines.push(`    will scrape (text: ${mode})`);
      if (mode === "article") lines.push(`    md → ${targets.mdPath}`);
      else { const base = resolveRecordBase(config); lines.push(`    records → ${base}.json, ${base}.csv`); }
      return;
    }
    lines.push(`    will scrape`);
    if (config.clearCache) lines.push(`    would clear cache: ${targets.cacheDir}`);
    if (config.keepLoose) lines.push(`    images → ${targets.outDir}/`);
    if (config.cbz) lines.push(`    cbz    → ${targets.cbzPath}`);
    if (config.pdf) lines.push(`    pdf    → ${targets.pdfPath}`);
    if (driveDest) lines.push(`    Drive  → ${driveDest}`);
  });
  return lines;
}

// Delete a job's resume cache (for --clear-cache). Returns whether anything was
// there to remove. Resolved from config, so it works regardless of cwd.
export async function clearJobCache(cacheDir, logger) {
  if (!existsSync(cacheDir)) return false;
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  logger.muted(`cleared cache: ${cacheDir}`);
  return true;
}

// Delete a job's local output (folder + archives) to free disk space.
async function removeJobArtifacts(targets, logger) {
  for (const p of [targets.outDir, targets.cbzPath, targets.pdfPath]) {
    await rm(p, { recursive: true, force: true }).catch(() => {});
  }
  logger.muted(`cleaned up local files (${targets.outDir})`);
}

// Default dimension reader: pixel size from the image header via sharp.
async function sharpDimsOf(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  return { width, height };
}

// Post-capture pass for the dimension-based image rules (minWidth/minHeight),
// which need decoded pixels and so can't run in ImageCapture. Returns `images`
// itself when there is nothing to check. An image whose size can't be read has
// unknown dimensions and fails a dimension rule (matching filterImages).
export async function applyImageDimensionRules(images, rules, { dimsOf = sharpDimsOf } = {}) {
  if (!rules) return images;
  // selector/position rules are intentionally not applied at run (see runtimeUnenforcedImageRuleKeys).
  const { minWidth, minHeight } = rules;
  const dimRules = {};
  if (minWidth !== undefined) dimRules.minWidth = minWidth;
  if (minHeight !== undefined) dimRules.minHeight = minHeight;
  if (Object.keys(dimRules).length === 0) return images;
  const candidates = [];
  for (const img of images) {
    let dims = {};
    try { dims = (await dimsOf(img.buffer)) || {}; } catch { /* unreadable → unknown size */ }
    candidates.push({ img, url: img.url, width: dims.width, height: dims.height });
  }
  return filterImages(candidates, dimRules).map((c) => c.img);
}

// Scrape one URL through the full sequence:
//   acquire (via the strategy orchestrator) → convert/package → upload →
//   clean up local files + cache.
// Returns { saved, total, complete, usedStrategy, attempts }.
export async function scrapeJob(session, job, config, processor, packagers, uploader, logger, orchestrator, profile) {
  const targets = resolveTargets(config, job);
  if (config.clearCache) await clearJobCache(targets.cacheDir, logger);
  const cache = config.cache ? await PageCache.open(targets.cacheDir) : null;
  const capture = new ImageCapture(config, logger, cache);
  const meter = new BandwidthMeter({ skip: (url) => capture.wasServedFromCache(url) });
  const seeded = cache ? await capture.seedFromCache() : 0;
  if (seeded) logger.info(`resuming: ${seeded} page(s) already cached — only missing pages will download`);

  try {
    // Acquire phase: the orchestrator runs each configured strategy in order,
    // retrying a strategy for transient failures and falling back to the next.
    // All strategies share `capture` (and its PageCache), so a fallback only
    // fetches what earlier stages missed.
    const r = await orchestrator.run({ session, job, config, capture, meter, seeded, profile });
    const contentType = profile?.contentType || "image";
    if (cache && r.total) { cache.total = r.total; await cache.saveIndex().catch(() => {}); }

    if (r.status !== "success") {
      if ((r.downloaded ?? capture.size) === 0) {
        logger.error("No images captured. Try --headed to watch, or set --count-selector / --advance-key / --host.");
      }
      return { saved: r.downloaded ?? capture.size, total: r.total, complete: false,
               bytes: meter.bytes, requests: meter.count, usedStrategy: r.usedStrategy, attempts: r.attempts, contentType };
    }

    // Normalize metadata for packaging + naming (best-effort; fields may be null).
    const md = r.metadata || {};
    const metadata = { series: md.title ?? null, title: md.title ?? null, pageCount: r.total ?? null, web: job.url };
    if (Number.isFinite(md.count) && Number.isFinite(r.total) && md.count !== r.total) {
      logger.verbose?.(`metadata page count ${md.count} differs from scraped total ${r.total}`);
    }
    // Final output targets: auto-name from the title when the job has no explicit name.
    const finalTargets = resolveTargets(config, job, { outputName: md.title || undefined });

    // Convert & package.
    if (r.acceptedPartial) logger.warn(`accepting partial download: packaging ${r.downloaded}/${r.total || "?"} page(s) (--accept-partial)`);
    logger.step("→ converting & packaging");
    let captured = capture.list();
    if (config.imageRules) captured = await applyImageDimensionRules(captured, config.imageRules);
    const outputs = await processor.process(captured);
    for (const packager of packagers) await packager.write(outputs, finalTargets, metadata);

    // Upload to Drive; a failed upload → retry, keep local files (unchanged).
    let uploaded = false;
    if (uploader) {
      const uploadCbz = config.cbz && config.driveOnly !== "pdf";
      const uploadPdf = config.pdf && config.driveOnly !== "cbz";
      if (!uploadCbz && !uploadPdf) {
        logger.warn(`--drive had nothing to upload (need ${config.driveOnly || "--cbz or --pdf"} output).`);
      } else {
        logger.step("→ uploading to Drive");
        try {
          if (uploadCbz) await uploader.uploadFile(finalTargets.cbzPath);
          if (uploadPdf) await uploader.uploadFile(finalTargets.pdfPath);
          uploaded = true;
        } catch (e) {
          logger.error(`Drive upload failed: ${e?.message || e}`);
          return { saved: outputs.length, total: r.total, complete: false, bytes: meter.bytes, requests: meter.count, usedStrategy: r.usedStrategy, attempts: r.attempts, contentType };
        }
      }
    }

    // Clean up local files only when there is a safe copy elsewhere (unchanged).
    if (config.cleanup) {
      if (uploaded) { logger.step("→ cleaning up local files"); await removeJobArtifacts(finalTargets, logger); }
      else if (!uploader) logger.warn("cleanup skipped: no --drive, refusing to delete the only local copy");
    }

    if (cache) await cache.clear().catch(() => {});
    return { saved: outputs.length, total: r.total, complete: true, bytes: meter.bytes, requests: meter.count, usedStrategy: r.usedStrategy, attempts: r.attempts, contentType };
  } finally {
    logger.info(`bandwidth: ${meter.summary(config.costPerGb)}`);
  }
}

export class BatchRunner {
  constructor(config, logger, deps = {}) {
    this.config = config;
    this.logger = logger;
    this._stopping = false;
    this._recordWriter = null; // created lazily on the first records-mode text job
    // Injectable so the batch loop can be unit-tested without a real browser.
    this._scrapeJob = deps.scrapeJob || scrapeJob;
    this._scrapeText = deps.scrapeText || scrapeText;
    this._resolveProfile = deps.resolveProfile || resolveProfile;
    this._resolvePipeline = deps.resolvePipeline || resolvePipeline;
    this._validate = deps.validate || validate;
  }

  // Ask the loop to stop after the current job finishes. Idempotent.
  stop() {
    this._stopping = true;
  }

  isStopping() {
    return this._stopping;
  }

  // Returns a process exit code.
  async run() {
    const c = this.config;
    this.logger.verbose(
      `config: format=${c.format} quality=${c.quality} maxEdge=${c.maxEdge} ` +
        `loose=${c.keepLoose} cbz=${c.cbz} pdf=${c.pdf} drive=${c.drive} cache=${c.cache} ` +
        `minBytes=${c.minBytes} settle=${c.settle} jitter=${c.jitter} advanceKey=${c.advanceKey}`
    );
    const source = createJobSource(this.config, this.logger);
    const jobs = await source.load();
    if (this.config.listFile) {
      if (!jobs.length) {
        this.logger.error(`no links found in ${this.config.listFile}. Put URLs in the first column, or a "url" column.`);
        return 1;
      }
      this.logger.info(`${jobs.length} link(s) loaded from ${this.config.listFile}${source.hasStatus ? " (status column active)" : ""}`);
    }

    // --dry-run: preview and exit before any browser/Drive work.
    if (this.config.dryRun) {
      for (const line of describeDryRun(this.config, jobs)) this.logger.info(line);
      return 0;
    }

    const processor = new ImageProcessor(this.config, this.logger);
    const packagers = buildPackagers(this.config, this.logger);

    // Set up Drive upload before scraping so a misconfiguration fails fast.
    let uploader = null;
    if (this.config.drive) {
      try {
        uploader = await DriveUploader.create(this.config, this.logger);
        this.logger.info(`Drive upload enabled${this.config.driveFolder ? ` (folder ${this.config.driveFolder})` : " (My Drive root)"}`);
      } catch (e) {
        this.logger.error(`Drive setup failed: ${e.message}`);
        return 1;
      }
    }

    this.logger.info(`launching ${this.config.headed ? "headed" : "headless"} Chromium`);
    const session = await BrowserSession.launch(this.config);

    // Ctrl-C: stop after the current job finishes (so its files/status stay
    // consistent); a second Ctrl-C forces an immediate exit.
    const onSigint = () => {
      if (this._stopping) {
        this.logger.warn("forcing exit.");
        process.exit(130);
      }
      this.stop();
      this.logger.warn("stopping after the current job finishes… (Ctrl-C again to force)");
    };
    process.on("SIGINT", onSigint);

    const breaker = new CircuitBreaker(this.config.maxDomainFailures, { base: this.config.itemDelay || 3000 });

    let results;
    try {
      results = await this._runJobs({ jobs, source, session, processor, packagers, uploader, breaker });
    } finally {
      process.removeListener("SIGINT", onSigint);
      await session.close();
    }

    if (this._recordWriter && this._recordWriter.count) this.logger.info(`wrote ${this._recordWriter.count} record(s) → ${this._recordWriter.jsonPath}, ${this._recordWriter.csvPath}`);
    return this._summary(jobs, results, breaker);
  }

  // Iterate the jobs, honouring the status column and the stop flag. Extracted
  // from run() so it can be tested with an injected job runner and no browser.
  async _runJobs({ jobs, source, session, processor, packagers, uploader, breaker }) {
    const brk = breaker || new CircuitBreaker(0);
    const results = [];
    let scrapedAny = false;
    for (let i = 0; i < jobs.length; i++) {
      if (this._stopping) {
        const left = jobs.length - i;
        this.logger.warn(`stopped — ${left} job(s) left unprocessed (rerun to resume).`);
        break;
      }
      const job = jobs[i];
      const tag = `(${i + 1}/${jobs.length})`;

      if (source.hasStatus) {
        const skip = skipReason(job.status);
        if (skip) {
          this.logger.muted(`${tag} ${skip} — ${job.url}`);
          results.push({ ...job, skipped: true });
          continue;
        }
      }

      const host = hostOf(job.url);
      if (brk.isTripped(host)) {
        brk.noteSkip();
        this.logger.muted(`${tag} skipped — ${host} circuit-breaker tripped (left to retry) — ${job.url}`);
        results.push({ ...job, skipped: true, breakerSkipped: true });
        source.setReason?.(job, "skipped: domain circuit-breaker");
        continue;
      }

      const extra = brk.extraDelay(host);
      const waitMs = (scrapedAny ? this.config.itemDelay : 0) + extra;
      if (extra > 0) this.logger.verbose?.(`backing off ${host} ${Math.round(extra / 1000)}s`);
      if (waitMs > 0) await sleep(withJitter(waitMs, this.config.jitter));
      scrapedAny = true;

      if (jobs.length > 1) this.logger.section(`=== ${tag}${job.status === "retry" ? " [retry]" : ""} ${job.url} ===`);

      let complete = false;
      let rec;
      try {
        const profile = this._resolveProfile(job.url);
        const contentType = this.config.text ? "text" : (profile.contentType || "image");
        if (contentType === "text") {
          const mode = resolveMode(this.config, profile);
          this.logger.verbose(`profile=${profile.name} contentType=text mode=${mode}`);
          if ((mode === "pattern" || mode === "selector") && !this._recordWriter) {
            this._recordWriter = new RecordWriter(resolveRecordBase(this.config));
          }
          const r = await this._scrapeText(session, job, this.config, this.logger, profile, { recordWriter: this._recordWriter });
          complete = r.complete;
          rec = { ...job, ...r, ok: complete };
        } else {
          const strategies = this._resolvePipeline(profile, this.config, this.logger);
          this.logger.verbose(`profile=${profile.name} contentType=${profile.contentType} pipeline=[${strategies.map((s) => s.strategy.name).join(", ")}]`);

          if (!strategies.length) {
            this.logger.error(`no mechanisms resolved for ${job.url} (profile ${profile.name}) — marking retry`);
            rec = { ...job, saved: 0, ok: false, error: "no mechanisms resolved" };
          } else {
            const orchestrator = new ScrapingOrchestrator(strategies, this._validate, this.logger);
            const r = await this._scrapeJob(session, job, this.config, processor, packagers, uploader, this.logger, orchestrator, profile);
            complete = r.complete;
            rec = { ...job, ...r, ok: complete };
          }
        }
      } catch (e) {
        this.logger.error(`failed on ${job.url}: ${e?.message || e}`);
        rec = { ...job, saved: 0, ok: false, error: String(e?.message || e) };
      }
      results.push(rec);

      const code = failureCodeOf(rec);
      brk.record(host, { ok: complete, code });

      // Persist outcome immediately so an interrupted batch is resumable.
      if (source.hasStatus) {
        source.setStatus(job, complete ? "done" : "retry");
        source.setReason?.(job, complete ? "" : (code || "FAILED"));
      }
    }
    return results;
  }

  _summary(jobs, results, breaker) {
    if (jobs.length > 1) {
      const attempted = results.filter((r) => !r.skipped);
      const ok = attempted.filter((r) => r.ok).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = attempted.filter((r) => !r.ok);
      const summary = `batch done: ${ok}/${attempted.length} crawled succeeded${skipped ? `, ${skipped} skipped` : ""}${failed.length ? `, ${failed.length} to retry` : ""}.`;
      this.logger.section(summary);
      const totalBytes = attempted.reduce((s, r) => s + (r.bytes || 0), 0);
      const totalReqs = attempted.reduce((s, r) => s + (r.requests || 0), 0);
      if (totalBytes > 0) {
        this.logger.info(`total bandwidth: ${formatBandwidth(totalBytes, totalReqs, this.config.costPerGb)}`);
      }
      const viaHttp = attempted.filter((r) => r.via === "http").length;
      const viaBrowser = attempted.filter((r) => r.via === "browser").length;
      if (viaHttp || viaBrowser) this.logger.info(`text acquisition: ${viaHttp} via http, ${viaBrowser} via browser`);
      if (failed.length) {
        this.logger.warn("marked retry:");
        for (const f of failed) {
          const code = failureCodeOf(f);
          const mech = f.usedStrategy || "";
          let detail = code ? `${code}${mech ? `, ${mech}` : ""}` : `${f.saved || 0}/${f.total || "?"} pages`;
          if (code === "UNKNOWN_ERROR" && f.error) detail += `: ${f.error}`;
          this.logger.warn(`  - ${f.url} (${detail})`);
        }
      }
      const tripped = breaker?.trippedHosts?.() || [];
      if (tripped.length) {
        this.logger.warn("circuit breaker tripped:");
        for (const host of tripped) {
          const n = results.filter((r) => r.breakerSkipped && hostOf(r.url) === host).length;
          this.logger.warn(`  - ${host}: too many failures → ${n} row(s) skipped this run (left to retry)`);
        }
      }
      return failed.length && ok === 0 ? 2 : 0;
    }
    return results[0]?.ok ? 0 : 2;
  }
}
