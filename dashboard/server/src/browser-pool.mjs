import { BrowserSession } from "../../../src/browser.mjs";
import { DEFAULTS } from "../../../src/config.mjs";

// Engine config used for preview sessions: the repo defaults, always headless.
export function previewConfig() {
  return { ...DEFAULTS, headed: false };
}

// Lazily launches ONE BrowserSession and reuses it for every preview. The
// launcher is injectable so tests never start real Chromium. Concurrent
// getBrowser() calls share one in-flight launch; a failed launch is not cached.
export function createBrowserPool({ launcher = (config) => BrowserSession.launch(config) } = {}) {
  let pending = null;

  async function getBrowser() {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => launcher(previewConfig()))
        .catch((err) => {
          pending = null;
          throw err;
        });
    }
    return pending;
  }

  async function closeBrowser() {
    const current = pending;
    pending = null;
    if (!current) return;
    const session = await current.catch(() => null);
    await session?.close?.();
  }

  return { getBrowser, closeBrowser };
}

const shared = createBrowserPool();
export const getBrowser = shared.getBrowser;
export const closeBrowser = shared.closeBrowser;
