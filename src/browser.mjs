// BrowserSession: owns the Chromium browser + context lifecycle and the small
// bit of stealth needed to pass automation-sniffing gates. Callers get pages
// from it and never touch Playwright's launch details directly.
import { chromium } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class BrowserSession {
  constructor(browser, context) {
    this.browser = browser;
    this.context = context;
  }

  static async launch(config) {
    const browser = await chromium.launch({
      headless: !config.headed,
      // Full "new" headless engine, not the headless shell (some gates block it).
      args: config.headed ? [] : ["--headless=new"]
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: "en-US"
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    });
    return new BrowserSession(browser, context);
  }

  newPage() {
    return this.context.newPage();
  }

  async close() {
    await this.browser.close().catch(() => {});
  }
}
