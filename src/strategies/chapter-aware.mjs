// Stage 2 (the real fallback) for continuous / looping multi-chapter readers
// like batcave.biz's "event" reader.
//
// On such a reader, opening a chapter URL (e.g. /event/ultimate-marvel/395) shows
// the target chapter, but pressing the advance key flows OUT into adjacent
// chapters and only loops back to the target's remaining pages much later — so
// Stage 1 (keyboard-advance) stalls (its stagnant-limit trips while it traverses
// a neighbouring chapter whose images are filtered out) and never collects the
// target chapter.
//
// This strategy instead addresses the target chapter's pages DIRECTLY by URL
// fragment: the reader exposes page N as `<chapterUrl>#page-N`. It reads the
// chapter's page count from the reader's own "Page X / N" counter (falling back
// to the image count), locks the shared capture onto the target chapter's image
// directory (so a neighbouring chapter's preloaded images can't hijack the
// directory filter), then visits #page-1 … #page-N in order. Pages arrive in
// order, so the output is ordered by capture sequence even though the image
// filenames carry no parseable page number.
//
// The browser-touching steps (detectTotal / readTargetDir / gotoPage) are
// instance methods so they can be overridden in unit tests without a real page.
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { sleep, withJitter } from "../time.mjs";
import { ok, failed, mapError, FailureCode } from "./strategy.mjs";

// The reader's page-image elements (same selector family as the count selector).
const READER_IMG_SEL = "img.reader__item, .reader img, #reader img";

// The directory portion of an image URL (everything up to and including the last
// "/"), used to identify which chapter an image belongs to.
export function imageDir(u) {
  if (!u) return null;
  const s = String(u);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i + 1) : null;
}

export class ChapterAwareStrategy {
  constructor({ openReader = defaultOpenReader } = {}) {
    this.name = "chapter-aware";
    this.defaultMaxAttempts = 1;
    this._openReader = openReader;
  }

  async execute({ session, job, config, capture, meter, logger }) {
    const page = await session.newPage();
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, config, logger);
      const total = await this._collect(page, capture, config, logger);
      const downloaded = capture.size;
      if (!(downloaded > 0)) return failed(FailureCode.EMPTY_RESULT, "no pages captured");
      return ok({ downloaded, total });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // --- browser-touching seams (overridden in tests) ---

  // The target chapter's page count: prefer the reader's own "Page X / N"
  // counter, fall back to the number of page-image elements, then to --pages.
  async detectTotal(page, config) {
    if (config.forcePages) return config.forcePages;
    return page
      .evaluate((sel) => {
        const m = (document.body?.innerText || "").match(/Page\s+\d+\s*\/\s*(\d+)/i);
        if (m) return parseInt(m[1], 10);
        return document.querySelectorAll(sel).length;
      }, READER_IMG_SEL)
      .catch(() => 0);
  }

  // The target chapter's image directory, from the currently shown page image.
  async readTargetDir(page) {
    const url = await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        return el?.currentSrc || el?.src || el?.getAttribute("data-src") || null;
      }, READER_IMG_SEL)
      .catch(() => null);
    return imageDir(url);
  }

  // Navigate the reader to page N via its URL fragment.
  async gotoPage(page, n) {
    await page.evaluate((nn) => { window.location.hash = `#page-${nn}`; }, n).catch(() => {});
  }

  async _collect(page, capture, config, logger) {
    const total = await this.detectTotal(page, config);
    if (!(total > 0)) {
      logger.warn?.("chapter-aware: could not detect a page count; leaving to other strategies");
      return total;
    }

    const dir = await this.readTargetDir(page);
    if (dir) {
      capture.lockIssueDir?.(dir);
      logger.verbose?.(`chapter-aware: locked target chapter dir ${dir}`);
    }

    // NB: do NOT click inside the reader — on a continuous reader a click
    // advances into the next chapter, moving the URL off the target chapter so
    // #page-N would then address the wrong chapter. Fragment navigation alone
    // keeps us pinned to the opened chapter.
    logger.info?.(`chapter-aware: addressing ${total} page(s) directly by #page-N`);

    const settle = config.settle || 700;
    const got = new Set(); // page indices that produced a new captured image
    logger.progressBar?.(capture.size, total, "pages");

    // Two passes: visit each page by fragment; a page that didn't yield a new
    // image (transient load miss) is retried on the second pass. Stop as soon as
    // every page is captured.
    for (let pass = 0; pass < 2 && capture.size < total; pass++) {
      for (let n = 1; n <= total; n++) {
        if (capture.size >= total) break;
        if (got.has(n)) continue;
        const before = capture.size;
        await this.gotoPage(page, n);
        await sleep(withJitter(settle, config.jitter));

        const backoff = capture.takeBackoff?.() || 0;
        if (backoff > 0) {
          logger.warn?.(`rate-limited by server; pausing ${Math.round(backoff / 1000)}s`);
          await sleep(backoff);
        }

        if (capture.size > before) {
          got.add(n);
          logger.progressBar?.(capture.size, total, "pages");
        }
      }
    }

    await page.waitForTimeout?.(1000); // let the last image settle
    logger.progressBar?.(capture.size, total, "pages");
    return total;
  }
}
