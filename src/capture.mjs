// ImageCapture: passively collects the page images the browser downloads, with
// filtering (host / min size / chapter-directory lock) and rate-limit detection.
// It never drives the page — the ReaderDriver does — it only listens.
import { pageNumberFromUrl } from "./processor.mjs";

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

export class ImageCapture {
  constructor(config, logger, cache = null) {
    this.config = config;
    this.logger = logger;
    this.cache = cache; // optional PageCache — seed from it and write through to it
    this.images = new Map(); // url -> { buffer, contentType, seq }
    this._servedFromCache = new Set(); // URLs fulfilled from disk (skip in bandwidth accounting)
    this._seq = 0; // monotonic capture order, used to order unnumbered pages
    this._backoffMs = 0;
    this._rlHits = 0;
    this._issueDir = config.issuePrefix || null;
  }

  // Listen for downloaded images, and (when a cache is present) route requests
  // for pages we already have to the cache instead of the network.
  async attach(page) {
    page.on("response", (resp) => this._onResponse(resp));
    if (this.cache) {
      await page.route("**/*", async (route) => {
        try {
          const req = route.request();
          if (req.resourceType() === "image" && this.cache.has(req.url())) {
            const hit = await this.cache.get(req.url());
            if (hit) {
              this._markServed(req.url());
              this.logger.debug?.(`cache hit → served from disk: ${req.url()}`);
              return await route.fulfill({ status: 200, contentType: hit.contentType, body: hit.buffer });
            }
          }
        } catch {
          /* fall through to the network */
        }
        return route.continue();
      });
    }
  }

  // Preload cached pages so `size` reflects them, the seq continues past them,
  // and the issue-directory lock is restored. Returns the number seeded.
  async seedFromCache() {
    if (!this.cache) return 0;
    const entries = await this.cache.readAll();
    let seeded = 0;
    for (const e of entries) {
      // Skip a stale empty-buffer entry from an older run so it isn't re-counted
      // as a page (and doesn't crash conversion); it will be re-fetched.
      if (!e.buffer || e.buffer.length === 0) continue;
      this.images.set(e.url, { buffer: e.buffer, contentType: e.contentType, seq: e.seq });
      if (e.seq >= this._seq) this._seq = e.seq + 1;
      seeded++;
    }
    if (!this.config.allImages && !this.config.issuePrefix && this.cache.issueDir) {
      this._issueDir = this.cache.issueDir;
    }
    return seeded;
  }

  get size() {
    return this.images.size;
  }

  has(url) {
    return this.images.has(url);
  }

  _markServed(url) {
    this._servedFromCache.add(url);
  }

  // Was this URL fulfilled from the local cache (i.e. it never hit the network)?
  wasServedFromCache(url) {
    return this._servedFromCache.has(url);
  }

  // Force the target chapter's image directory. A strategy that navigates a known
  // chapter directly (e.g. by #page-N fragment) calls this so a neighbouring
  // chapter's preloaded images can't hijack the "first image wins" directory lock.
  lockIssueDir(dir) {
    if (!dir) return;
    this._issueDir = dir;
    if (this.cache) this.cache.issueDir = dir;
  }

  list() {
    return [...this.images.entries()].map(([url, v]) => ({ url, ...v }));
  }

  // Return and clear any pending rate-limit pause (ms) the ReaderDriver honours.
  takeBackoff() {
    const b = this._backoffMs;
    this._backoffMs = 0;
    return b;
  }

  _dirOf(u) {
    return u.slice(0, u.lastIndexOf("/") + 1);
  }

  async _onResponse(resp) {
    try {
      const status = resp.status();
      if (status === 429 || status === 503) {
        const ra = parseInt(resp.headers()["retry-after"] || "", 10);
        const wait = Number.isFinite(ra) ? ra * 1000 : this.config.rateLimitBase * 2 ** this._rlHits;
        this._rlHits++;
        this._backoffMs = Math.max(this._backoffMs, wait);
        this.logger.debug?.(`rate-limit HTTP ${status} (retry-after=${Number.isFinite(ra) ? ra + "s" : "n/a"}) → backoff ${wait}ms: ${resp.url()}`);
        return;
      }
      if (resp.request().resourceType() !== "image" || !resp.ok()) return;
      const ct = (resp.headers()["content-type"] || "").split(";")[0].toLowerCase();
      if (!ct.startsWith("image/")) return;
      const u = resp.url();
      if (u.startsWith("data:")) return;
      if (this.images.has(u)) return; // already captured (this run or seeded from cache)

      const { hostFilter, issuePrefix, allImages, minBytes } = this.config;
      if (hostFilter && !u.includes(hostFilter)) {
        this.logger.verbose?.(`skipped (host filter "${hostFilter}"): ${u}`);
        return;
      }

      const body = await resp.body().catch(() => null);
      // An empty (0-byte) body is a failed/aborted fetch, not a real page. Never
      // capture it — even for a numbered page (which otherwise bypasses minBytes)
      // — because it would be counted as a page and then crash image conversion
      // ("Input Buffer is empty"). Dropping it leaves the page missing so a later
      // pass or fallback strategy can re-fetch it.
      if (!body || body.length === 0) {
        if (body) this.logger.verbose?.(`skipped (empty image body): ${u}`);
        return;
      }
      this.logger.debug?.(`image response ${ct} ${kb(body.length)} ${u}`);
      // minBytes skips site chrome (icons, thumbnails, spinners). A URL that
      // matches the numbered-page pattern is a real page even when it's small,
      // so it bypasses the size gate — otherwise a genuinely small page (e.g. a
      // sparse 19 KB page under a 20 KB threshold) is silently dropped, leaving
      // the download stuck one short forever.
      const page = pageNumberFromUrl(u);
      const isNumberedPage = page != null;
      if (!isNumberedPage && body.length < minBytes) {
        this.logger.verbose?.(`skipped (below minBytes ${body.length}<${minBytes}, not a numbered page): ${u}`);
        return;
      }

      // Lock onto the first large image's directory so preloaded neighbouring
      // chapters are ignored (unless disabled or an explicit prefix is given).
      if (!allImages) {
        if (issuePrefix) {
          if (!u.includes(issuePrefix)) {
            this.logger.verbose?.(`skipped (no issue-prefix "${issuePrefix}"): ${u}`);
            return;
          }
        } else if (!this._issueDir) {
          this._issueDir = this._dirOf(u);
          if (this.cache) this.cache.issueDir = this._issueDir;
          this.logger.verbose?.(`locked issue directory: ${this._issueDir}`);
        } else if (this._dirOf(u) !== this._issueDir) {
          this.logger.verbose?.(`skipped (other chapter dir ${this._dirOf(u)}): ${u}`);
          return;
        }
      }

      const seq = this._seq++;
      this.images.set(u, { buffer: body, contentType: ct, seq });
      this.logger.verbose?.(`captured page ${page ?? "?"} (${kb(body.length)})`);
      // Write through to the cache so progress survives an interrupted run.
      if (this.cache) await this.cache.put(u, body, ct, seq).catch(() => {});
      // Progress is rendered by the ReaderDriver (single writer for the bar).
    } catch {
      /* ignore individual response errors */
    }
  }
}
