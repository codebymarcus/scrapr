// src/text/scrape-text.mjs
// The text content path: resolve the extraction mode, acquire the page (HTTP-first,
// escalating to the browser), run the extractor, and write output: a .md for
// article mode, or a record appended to the run's aggregate CSV/JSON for
// pattern/selector. Returns the batch loop's result shape (with `via`).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireAndExtract as defaultAcquire } from "./acquire.mjs";
import { buildMarkdownDoc } from "./markdown.mjs";
import { resolveTargets } from "../naming.mjs";
import { resolvePatterns } from "./extractors/pattern.mjs";
import { FailureCode } from "../strategies/strategy.mjs";
import { BandwidthMeter } from "../bandwidth.mjs";

const fail = (code, bytes = 0, requests = 0) => ({ ok: false, complete: false, saved: 0, contentType: "text", attempts: [{ name: "text", status: "failed", code }], bytes, requests });

export function resolveMode(config, profile) {
  if (config.textMode && config.textMode !== "article") return config.textMode;
  if (profile?.text?.mode) return profile.text.mode;
  return config.textMode || "article";
}

// Build the extractor opts for a mode from CLI config + profile.
export function buildOpts(mode, config, profile) {
  const pt = profile?.text || {};
  if (mode === "pattern") {
    return { patterns: resolvePatterns(config.textPatterns?.length ? config.textPatterns : (pt.patterns || [])) };
  }
  if (mode === "selector") {
    const fromCli = (config.textSelect || []).map((s) => {
      const eq = s.indexOf("=");
      const name = eq > 0 && /^[A-Za-z0-9_-]+$/.test(s.slice(0, eq)) ? s.slice(0, eq) : null;
      return name ? { name, selector: s.slice(eq + 1) } : { name: "text", selector: s };
    });
    return { fields: fromCli.length ? fromCli : (pt.fields || (pt.selector ? [{ name: "text", selector: pt.selector }] : [])) };
  }
  // article
  return { selector: pt.selector };
}

// Shape a non-empty extractor payload into one aggregate record for the URL.
export function toRecord(url, payload) {
  if (payload.kind === "pattern") {
    const rec = { url };
    for (const m of payload.matches) (rec[m.type] ||= []).push(m.value);
    return rec;
  }
  return { url, ...payload.fields };
}

export async function scrapeText(session, job, config, logger, profile, deps = {}) {
  const acquireAndExtract = deps.acquireAndExtract || defaultAcquire;
  const recordWriter = deps.recordWriter || null;
  const mode = resolveMode(config, profile);
  let opts;
  try {
    opts = buildOpts(mode, config, profile);
  } catch (e) {
    logger.error?.(`text config error for ${job.url}: ${e?.message || e}`);
    return fail(FailureCode.PARSER_ERROR);
  }

  const acq = await acquireAndExtract({
    url: job.url, mode, opts, session, config, logger,
    deps: { BandwidthMeter }
  });
  if (acq.status !== "ok") {
    logger.error?.(`text scrape failed on ${job.url}: ${acq.code}`);
    return fail(acq.code, acq.bytes, acq.requests);
  }

  const { payload, via, bytes, requests } = acq;
  try {
    if (mode === "article") {
      const title = payload.title;
      const targets = resolveTargets(config, job, { outputName: title || undefined });
      const doc = buildMarkdownDoc({ title, source: job.url, date: new Date().toISOString().slice(0, 10), byline: payload.byline, excerpt: payload.excerpt, markdown: payload.markdown });
      await mkdir(path.dirname(targets.mdPath), { recursive: true });
      await writeFile(targets.mdPath, doc);
      logger.success?.(`wrote Markdown (${doc.length} bytes, via ${via}) → ${targets.mdPath}`);
      return { ok: true, complete: true, saved: 1, contentType: "text", bytes, requests, via };
    }
    // pattern / selector → record
    const record = toRecord(job.url, payload);
    const saved = mode === "pattern" ? payload.matches.length : Object.keys(payload.fields).filter((k) => { const v = payload.fields[k]; return Array.isArray(v) ? v.length : v != null; }).length;
    if (recordWriter && saved > 0) await recordWriter.append(record);
    logger.success?.(`extracted ${saved} ${mode} value(s) from ${job.url} (via ${via})`);
    return { ok: true, complete: true, saved, contentType: "text", bytes, requests, via };
  } catch (e) {
    logger.error?.(`text write failed on ${job.url}: ${e?.message || e}`);
    return fail(FailureCode.UNKNOWN_ERROR, bytes, requests);
  }
}
