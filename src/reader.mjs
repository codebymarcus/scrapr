// ReaderDriver: drives a virtualized reader — detects the page count, then
// presses the advance key through every page (politely, honouring rate-limit
// backoff and stopping when no new images appear). Capture happens in parallel
// via the injected ImageCapture; this class only decides when to advance.
import { sleep, withJitter } from "./time.mjs";

const STAGNANT_LIMIT = 5; // presses with no new image before we call it the end

export class ReaderDriver {
  constructor(page, capture, config, logger) {
    this.page = page;
    this.capture = capture;
    this.config = config;
    this.logger = logger;
  }

  async detectTotal() {
    if (this.config.forcePages) return this.config.forcePages;
    return this.page
      .evaluate((sel) => document.querySelectorAll(sel).length, this.config.countSelector)
      .catch(() => 0);
  }

  async run() {
    const total = await this.detectTotal();
    if (!total || total < 1) {
      this.logger.info("couldn't detect a page count; advancing until images stop appearing.");
    } else {
      this.logger.info(`detected ${total} pages; advancing with "${this.config.advanceKey}"`);
    }

    await this.page.mouse.click(640, 450).catch(() => {}); // give the reader keyboard focus
    await this.page.waitForTimeout(300);

    const target = total && total > 0 ? total : Infinity;
    const maxPresses = total && total > 0 ? total + 4 : 600;
    let stagnant = 0;
    let last = this.capture.size;

    this.logger.progressBar(this.capture.size, total, "pages");
    for (let i = 0; i < maxPresses; i++) {
      if (this.capture.size >= target) break;
      await this.page.keyboard.press(this.config.advanceKey).catch(() => {});
      await sleep(withJitter(this.config.settle, this.config.jitter));

      const backoff = this.capture.takeBackoff();
      if (backoff > 0) {
        this.logger.warn(`rate-limited by server; pausing ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
      }

      if (this.capture.size === last) {
        this.logger.debug?.(`press ${i + 1}/${maxPresses} "${this.config.advanceKey}" → ${this.capture.size} page(s) (no change, stagnant ${stagnant + 1}/${STAGNANT_LIMIT})`);
        if (++stagnant >= STAGNANT_LIMIT) {
          this.logger.verbose?.(`stopping: ${STAGNANT_LIMIT} presses with no new page (have ${this.capture.size}${total ? "/" + total : ""})`);
          break;
        }
      } else {
        this.logger.debug?.(`press ${i + 1}/${maxPresses} "${this.config.advanceKey}" → ${this.capture.size} page(s)`);
        stagnant = 0;
        last = this.capture.size;
      }
      this.logger.progressBar(this.capture.size, total, "pages");
    }
    if (this.capture.size >= target && total > 0) this.logger.verbose?.(`reached page count ${total}`);

    await this.page.waitForTimeout(1000); // let late loads settle
    this.logger.progressBar(this.capture.size, total, "pages");
    const done = total > 0 ? this.capture.size >= total : this.capture.size > 0;
    const msg = `downloaded ${this.capture.size}${total ? "/" + total : ""} pages`;
    if (done) this.logger.success(msg);
    else this.logger.warn(msg + " (incomplete)");
    return { total };
  }
}
