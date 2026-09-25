// Stage 2 (the real fallback): the batcave.biz reader auto-navigates to the NEXT
// chapter URL when you press past the last page, so Stage 1 loses the true last
// page and reports e.g. 39/40 forever. This strategy avoids that by (a) using a
// longer settle so the last page's image finishes loading, (b) never pressing
// past the last page when the count is known, and (c) if the reader still jumps
// (over-detected count), detecting the URL change, navigating back, and stopping
// with whatever it has. It shares the same ImageCapture, so it only needs to
// pick up pages Stage 1 missed. Collaborators are injectable for testing.
import { openReader as defaultOpenReader, navigateWithRetry as defaultNavigateWithRetry } from "../navigation.mjs";
import { sleep, withJitter } from "../time.mjs";
import { ok, failed, mapError, FailureCode } from "./strategy.mjs";

const STAGNANT_LIMIT = 5;

// Two reader URLs are the same issue when origin + pathname match (ignoring hash
// and query, which readers use for in-chapter page state). The next-chapter jump
// changes the pathname (.../394 → .../395), so it is detected as a different issue.
export function sameIssue(a, b) {
  const key = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname.replace(/\/$/, "");
    } catch {
      return u;
    }
  };
  return key(a) === key(b);
}

export class ChapterAwareStrategy {
  constructor({ openReader = defaultOpenReader, navigateWithRetry = defaultNavigateWithRetry } = {}) {
    this.name = "chapter-aware";
    this.defaultMaxAttempts = 1;
    this._openReader = openReader;
    this._navigateWithRetry = navigateWithRetry;
  }

  async execute({ session, job, config, capture, meter, logger }) {
    const page = await session.newPage();
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, config, logger);
      const openUrl = page.url() || job.url;
      const { total, jumped } = await this._drive(page, capture, config, logger, openUrl);
      const downloaded = capture.size;
      if (!(downloaded > 0)) return failed(jumped ? FailureCode.NAVIGATION_JUMP : FailureCode.EMPTY_RESULT, "no pages captured");
      return ok({ downloaded, total });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async detectTotal(page, config) {
    if (config.forcePages) return config.forcePages;
    return page.evaluate((sel) => document.querySelectorAll(sel).length, config.countSelector).catch(() => 0);
  }

  async _drive(page, capture, config, logger, openUrl) {
    const total = await this.detectTotal(page, config);
    const target = total && total > 0 ? total : Infinity;
    // Never press PAST the last page when the count is known: total-1 presses take
    // page 1 → page `total`. A longer settle lets that last page's image load.
    const budget = total && total > 0 ? total - 1 : 600;
    // A longer settle than Stage 1 so the last page's image finishes loading
    // before we would otherwise advance. Driven by config.settle (kept small in
    // tests), doubled; defaults to 700 → 1400ms in production.
    const endSettle = (config.settle || 700) * 2;

    await page.mouse.click(640, 450).catch(() => {}); // give the reader keyboard focus
    await page.waitForTimeout(300);

    let stagnant = 0;
    let last = capture.size;
    let jumped = false;
    logger.progressBar?.(capture.size, total, "pages");

    for (let i = 0; i < budget; i++) {
      if (capture.size >= target) break;
      const before = page.url();
      await page.keyboard.press(config.advanceKey).catch(() => {});
      await sleep(withJitter(endSettle, config.jitter));
      const after = page.url();

      if (!sameIssue(before, after)) {
        // Over-detected count still pressed us into the next chapter. Go back to
        // the reader, let the last page settle, and stop with what we have.
        logger.warn(`end-of-chapter jump detected (${after}); recovering and stopping`);
        jumped = true;
        await this._navigateWithRetry(page, openUrl, config, logger);
        await sleep(withJitter(endSettle, config.jitter));
        break;
      }

      const backoff = capture.takeBackoff?.() || 0;
      if (backoff > 0) {
        logger.warn(`rate-limited by server; pausing ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
      }

      if (capture.size === last) {
        if (++stagnant >= STAGNANT_LIMIT) break;
      } else {
        stagnant = 0;
        last = capture.size;
      }
      logger.progressBar?.(capture.size, total, "pages");
    }

    await page.waitForTimeout(1000); // let the last page's image finish loading
    return { total, jumped };
  }
}
