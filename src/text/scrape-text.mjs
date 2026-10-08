// src/text/scrape-text.mjs
// The text content path: open the page (past the JS gate), extract the main
// content, convert to Markdown, and write a .md. Returns the batch loop's result
// shape so the circuit breaker / status / reason column work like the image path.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { extractArticle as defaultExtractArticle } from "./extract.mjs";
import { htmlToMarkdown, buildMarkdownDoc } from "./markdown.mjs";
import { extractMetadata as defaultExtractMetadata } from "../metadata.mjs";
import { resolveTargets } from "../naming.mjs";
import { BandwidthMeter } from "../bandwidth.mjs";
import { mapError, FailureCode } from "../strategies/strategy.mjs";

// A failed text result. The code lives ONLY in `attempts` (no top-level `error`
// string) — matching the image failed-result shape — so `failureCodeOf` reports
// this exact code (it prefers a top-level `error` when present) in the reason
// column and to the breaker. The human message is logged, not returned.
const fail = (code) => ({ ok: false, complete: false, saved: 0, contentType: "text", attempts: [{ name: "text", status: "failed", code }] });

export async function scrapeText(session, job, config, logger, profile, deps = {}) {
  const openReader = deps.openReader || defaultOpenReader;
  const extractArticle = deps.extractArticle || defaultExtractArticle;
  const extractMetadata = deps.extractMetadata || defaultExtractMetadata;
  const page = await session.newPage();
  const meter = new BandwidthMeter();
  try {
    meter.attach?.(page);
    await openReader(page, job.url, config, logger);
    const art = await extractArticle(page, { selector: profile?.text?.selector });
    if (!art || !art.html) {
      logger.warn?.(`no article content extracted from ${job.url}`);
      return { ...fail(FailureCode.EMPTY_RESULT), bytes: meter.bytes, requests: meter.count };
    }
    const markdown = htmlToMarkdown(art.html);
    if (!markdown) return { ...fail(FailureCode.EMPTY_RESULT), bytes: meter.bytes, requests: meter.count };

    let title = art.title;
    if (!title) { try { title = (await extractMetadata(page, profile?.metadata || {})).title; } catch { /* best-effort */ } }

    const targets = resolveTargets(config, job, { outputName: title || undefined });
    const doc = buildMarkdownDoc({ title, source: job.url, date: new Date().toISOString().slice(0, 10), byline: art.byline, excerpt: art.excerpt, markdown });
    await mkdir(path.dirname(targets.mdPath), { recursive: true });
    await writeFile(targets.mdPath, doc);
    logger.success?.(`wrote Markdown (${doc.length} bytes) → ${targets.mdPath}`);
    return { ok: true, complete: true, saved: 1, contentType: "text", bytes: meter.bytes, requests: meter.count };
  } catch (e) {
    logger.error?.(`text scrape failed on ${job.url}: ${e?.message || e}`);
    return { ...fail(mapError(e)), bytes: meter.bytes, requests: meter.count };
  } finally {
    await page.close().catch(() => {});
    logger.info?.(`bandwidth: ${meter.summary(config.costPerGb)}`);
  }
}
