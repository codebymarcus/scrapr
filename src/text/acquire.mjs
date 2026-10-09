// src/text/acquire.mjs
// HTTP-first acquisition with extraction-aware escalation. Fetch the URL over
// built-in fetch; parse to a linkedom doc; run the chosen extractor. Escalate to
// the browser (existing openReader) only when the static path fails OR the
// extractor finds nothing. Never throws into the caller.
import { parseHtml as defaultParseHtml } from "./dom.mjs";
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { EXTRACTORS as defaultExtractors } from "./extractors/registry.mjs";
import { mapError, FailureCode } from "../strategies/strategy.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export async function acquireAndExtract({ url, mode, opts, session, config, logger, deps = {} }) {
  const fetchFn = deps.fetchFn || globalThis.fetch;
  const openReader = deps.openReader || defaultOpenReader;
  const parseHtml = deps.parseHtml || defaultParseHtml;
  const extractors = deps.extractors || defaultExtractors;
  const extract = extractors[mode];
  if (!extract) return { status: "fail", code: FailureCode.PARSER_ERROR, bytes: 0, requests: 0 };

  let bytes = 0, requests = 0;

  // 1) STATIC
  if (config.httpFirst !== false) {
    try {
      const res = await fetchFn(url, {
        redirect: "follow",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(config.navTimeout || 45000)
      });
      requests += 1;
      const ctype = (res.headers?.get?.("content-type") || "").toLowerCase();
      if (res.ok && (ctype === "" || ctype.includes("html") || ctype.includes("xml"))) {
        const html = await res.text();
        bytes += Buffer.byteLength(html || "", "utf8");
        const { document } = parseHtml(html);
        const payload = extract(document, html, opts);
        if (!payload.empty) return { status: "ok", payload, via: "http", bytes, requests };
        logger.verbose?.(`static fetch yielded nothing for ${url} — escalating to browser`);
      } else {
        logger.verbose?.(`static fetch not usable (status=${res.status} type=${ctype || "?"}) — escalating`);
      }
    } catch (e) {
      logger.verbose?.(`static fetch failed for ${url} (${e?.message || e}) — escalating`);
    }
  }

  // 2) ESCALATE → browser
  let page;
  try {
    page = await session.newPage();
    const BandwidthMeter = deps.BandwidthMeter; // optional in tests
    const meter = BandwidthMeter ? new BandwidthMeter() : null;
    meter?.attach?.(page);
    await openReader(page, url, config, logger);
    const html = await page.content();
    if (meter) { bytes += meter.bytes; requests += meter.count; }
    const { document } = parseHtml(html);
    const payload = extract(document, html, opts);
    if (!payload.empty) return { status: "ok", payload, via: "browser", bytes, requests };
    return { status: "fail", code: FailureCode.EMPTY_RESULT, bytes, requests };
  } catch (e) {
    logger.error?.(`browser acquisition failed for ${url}: ${e?.message || e}`);
    return { status: "fail", code: mapError(e), bytes, requests };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
