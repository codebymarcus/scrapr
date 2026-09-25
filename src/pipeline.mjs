// Pipeline: wires the pieces together.
//   scrapeJob  — one URL end to end (open → drive → capture → process → package)
//   BatchRunner — iterates a JobSource, applies status logic, calls scrapeJob,
//                 records status, and reports a summary.
// The runner depends on abstractions (JobSource, Packager, ImageProcessor),
// which are constructed once and injected — so behaviour is easy to extend or
// swap without editing this file.
import { sleep, withJitter } from "./time.mjs";
import { BrowserSession } from "./browser.mjs";
import { openReader } from "./navigation.mjs";
import { ImageCapture } from "./capture.mjs";
import { ReaderDriver } from "./reader.mjs";
import { ImageProcessor, missingPages, formatPageList } from "./processor.mjs";
import { buildPackagers } from "./packagers.mjs";
import { createJobSource } from "./sources.mjs";
import { DriveUploader } from "./drive.mjs";
import { resolveTargets } from "./naming.mjs";
import { PageCache } from "./cache.mjs";
import { BandwidthMeter, formatBandwidth } from "./bandwidth.mjs";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { decideOutcome } from "./outcome.mjs";
export { decideOutcome };

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

// Scrape one URL through the full sequence:
//   open cache → seed → download (missing pages only) → (incomplete? keep the
//   cache + retry) → convert/package → upload → clean up local files + cache.
// Returns { saved, total, complete }.
export async function scrapeJob(session, job, config, processor, packagers, uploader, logger) {
  const page = await session.newPage();
  const targets = resolveTargets(config, job);
  // --clear-cache: drop this job's partial cache first so it starts fresh.
  if (config.clearCache) await clearJobCache(targets.cacheDir, logger);
  // Resumable cache: keeps already-downloaded pages between runs so an
  // interrupted job re-fetches only what's missing.
  const cache = config.cache ? await PageCache.open(targets.cacheDir) : null;
  const capture = new ImageCapture(config, logger, cache);
  await capture.attach(page);
  // Measure real network egress (excludes pages served from the resume cache) so
  // metered-proxy data volume/cost can be surfaced.
  const meter = new BandwidthMeter({ skip: (url) => capture.wasServedFromCache(url) });
  meter.attach(page);
  const seeded = cache ? await capture.seedFromCache() : 0;
  if (seeded) logger.info(`resuming: ${seeded} page(s) already cached — only missing pages will download`);
  const since = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
  try {
    // 1. Download every page (cached ones are served from disk by the route).
    const tOpen = Date.now();
    await openReader(page, job.url, config, logger);
    logger.verbose(`opened reader in ${since(tOpen)}`);
    const tDl = Date.now();
    const { total } = await new ReaderDriver(page, capture, config, logger).run();
    const downloaded = capture.size;
    logger.verbose(`download phase: ${downloaded - seeded} new + ${seeded} cached = ${downloaded} page(s) in ${since(tDl)}`);
    if (cache && total) { cache.total = total; await cache.saveIndex().catch(() => {}); }

    const outcome = decideOutcome({ downloaded, total, seeded, acceptPartial: config.acceptPartial });

    // 1a. Incomplete and not accepted → KEEP the cache for the next run, retry.
    if (!outcome.complete) {
      const missing = missingPages(capture.list(), total);
      if (missing.length) logger.warn(`missing page(s): ${formatPageList(missing)}`);
      if (downloaded === 0) {
        logger.error("No images captured. Try --headed to watch, or set --count-selector / --advance-key / --host.");
      } else if (outcome.stagnant) {
        logger.warn(
          `no new pages this run (${downloaded}/${total || "?"}) — the page count may be over-detected or the last page is missing. ` +
            `Rerun with --accept-partial to keep ${downloaded} page(s), or set --pages / --count-selector.`
        );
      } else {
        logger.warn(`incomplete download (${downloaded}/${total || "?"})${cache ? ", cached for resume" : ""} — marking retry`);
      }
      return { saved: downloaded, total, complete: false, bytes: meter.bytes, requests: meter.count };
    }

    if (outcome.acceptedPartial) {
      logger.warn(`accepting partial download: packaging ${downloaded}/${total || "?"} page(s) (--accept-partial)`);
    }

    // 1b. Convert & package (PDF and/or CBZ and/or loose files).
    logger.step("→ converting & packaging");
    const tPk = Date.now();
    const outputs = await processor.process(capture.list());
    for (const packager of packagers) await packager.write(outputs, targets);
    logger.verbose(`packaged ${outputs.length} page(s) in ${since(tPk)}`);

    // 1c. Upload to Drive. A failed upload → retry, and we keep local files.
    let uploaded = false;
    if (uploader) {
      const uploadCbz = config.cbz && config.driveOnly !== "pdf";
      const uploadPdf = config.pdf && config.driveOnly !== "cbz";
      if (!uploadCbz && !uploadPdf) {
        logger.warn(`--drive had nothing to upload (need ${config.driveOnly || "--cbz or --pdf"} output).`);
      } else {
        logger.step("→ uploading to Drive");
        try {
          if (uploadCbz) await uploader.uploadFile(targets.cbzPath);
          if (uploadPdf) await uploader.uploadFile(targets.pdfPath);
          uploaded = true;
        } catch (e) {
          logger.error(`Drive upload failed: ${e?.message || e}`);
          return { saved: outputs.length, total, complete: false, bytes: meter.bytes, requests: meter.count };
        }
      }
    }

    // 1d. Clean up local files to free space — only when there's a safe copy
    // elsewhere (a successful upload). Without --drive we keep the files.
    if (config.cleanup) {
      if (uploaded) {
        logger.step("→ cleaning up local files");
        await removeJobArtifacts(targets, logger);
      } else if (!uploader) {
        logger.warn("cleanup skipped: no --drive, refusing to delete the only local copy");
      }
    }

    // 1e. The job succeeded — the resume cache is scratch and no longer needed.
    if (cache) await cache.clear().catch(() => {});

    return { saved: outputs.length, total, complete: true, bytes: meter.bytes, requests: meter.count };
  } finally {
    logger.info(`bandwidth: ${meter.summary(config.costPerGb)}`);
    await page.close().catch(() => {});
  }
}

export class BatchRunner {
  constructor(config, logger, deps = {}) {
    this.config = config;
    this.logger = logger;
    this._stopping = false;
    // Injectable so the batch loop can be unit-tested without a real browser.
    this._scrapeJob = deps.scrapeJob || scrapeJob;
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
      this._stopping = true;
      this.logger.warn("stopping after the current job finishes… (Ctrl-C again to force)");
    };
    process.on("SIGINT", onSigint);

    let results;
    try {
      results = await this._runJobs({ jobs, source, session, processor, packagers, uploader });
    } finally {
      process.removeListener("SIGINT", onSigint);
      await session.close();
    }

    return this._summary(jobs, results);
  }

  // Iterate the jobs, honouring the status column and the stop flag. Extracted
  // from run() so it can be tested with an injected job runner and no browser.
  async _runJobs({ jobs, source, session, processor, packagers, uploader }) {
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

      if (scrapedAny && this.config.itemDelay > 0) await sleep(withJitter(this.config.itemDelay, this.config.jitter));
      scrapedAny = true;

      if (jobs.length > 1) this.logger.section(`=== ${tag}${job.status === "retry" ? " [retry]" : ""} ${job.url} ===`);

      let complete = false;
      try {
        const r = await this._scrapeJob(session, job, this.config, processor, packagers, uploader, this.logger);
        complete = r.complete;
        results.push({ ...job, ...r, ok: complete });
      } catch (e) {
        this.logger.error(`failed on ${job.url}: ${e?.message || e}`);
        results.push({ ...job, saved: 0, ok: false, error: String(e?.message || e) });
      }

      // Persist outcome immediately so an interrupted batch is resumable.
      if (source.hasStatus) source.setStatus(job, complete ? "done" : "retry");
    }
    return results;
  }

  _summary(jobs, results) {
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
      if (failed.length) {
        this.logger.warn("marked retry:");
        for (const f of failed) {
          this.logger.warn(`  - ${f.url}${f.error ? ` (${f.error})` : ` (${f.saved || 0}/${f.total || "?"} pages)`}`);
        }
      }
      return failed.length && ok === 0 ? 2 : 0;
    }
    return results[0]?.ok ? 0 : 2;
  }
}
