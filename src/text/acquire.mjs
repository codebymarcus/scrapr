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
  let staticFailCode = null; // transport failure observed on the static path (null = none)

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
        // A loaded page with zero matches is a clean success for records modes
        // (pattern/selector); only "article" escalates (it may be JS-rendered).
        if (!payload.empty || mode !== "article") return { status: "ok", payload, via: "http", bytes, requests };
        logger.verbose?.(`static fetch yielded nothing for ${url}, escalating to browser`);
      } else {
        if (!res.ok) staticFailCode = FailureCode.HTTP_ERROR; // 2xx non-HTML stays null
        logger.verbose?.(`static fetch not usable (status=${res.status} type=${ctype || "?"}), escalating`);
      }
    } catch (e) {
      staticFailCode = mapError(e);
      logger.verbose?.(`static fetch failed for ${url} (${e?.message || e}), escalating`);
    }
  }

  // 2) ESCALATE → browser
  let page;
  try {
    page = await session.newPage();
    const BandwidthMeter = deps.BandwidthMeter; // optional in tests
    const meter = BandwidthMeter ? new BandwidthMeter() : null;
    meter?.attach?.(page);
    const resp = await openReader(page, url, config, logger);
    const html = await page.content();
    if (meter) { bytes += meter.bytes; requests += meter.count; }
    const { document } = parseHtml(html);
    const payload = extract(document, html, opts);
    if (!payload.empty) return { status: "ok", payload, via: "browser", bytes, requests };
    // openReader never throws on a failed navigation: it returns null (or the
    // final response). Classify so transport failures feed the circuit breaker.
    const status = resp?.status?.();
    if (resp == null) return { status: "fail", code: staticFailCode || FailureCode.NETWORK_ERROR, bytes, requests };
    if (typeof status === "number" && status >= 400) return { status: "fail", code: FailureCode.HTTP_ERROR, bytes, requests };
    if (mode !== "article") return { status: "ok", payload, via: "browser", bytes, requests }; // nav ok, legit zero-match
    return { status: "fail", code: FailureCode.EMPTY_RESULT, bytes, requests }; // article genuinely empty
  } catch (e) {
    logger.error?.(`browser acquisition failed for ${url}: ${e?.message || e}`);
    return { status: "fail", code: mapError(e), bytes, requests };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
