// Navigation: resilient page loading — exponential backoff on errors and
// 429/503, plus clearing a JS interstitial that bounces to a /_c?… gate.
import { sleep, withJitter } from "./time.mjs";

export async function navigateWithRetry(page, url, config, logger) {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      logger.debug?.(`goto attempt ${attempt + 1}/${config.maxRetries + 1}: ${url}`);
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
      const st = resp?.status();
      logger.debug?.(`goto → HTTP ${st ?? "?"} (${page.url()})`);
      if (st === 429 || st === 503) {
        const ra = parseInt(resp.headers()["retry-after"] || "", 10);
        const wait = Number.isFinite(ra) ? ra * 1000 : config.rateLimitBase * 2 ** attempt;
        logger.info(`server busy (HTTP ${st}); backing off ${Math.round(wait / 1000)}s`);
        await sleep(withJitter(wait, config.jitter));
        continue;
      }
      return resp;
    } catch (e) {
      if (attempt === config.maxRetries) {
        logger.info(`navigation failed after ${config.maxRetries + 1} attempts: ${e.message}`);
        return null;
      }
      const wait = config.rateLimitBase * 2 ** attempt;
      logger.info(`navigation error (${e.message}); retry ${attempt + 1}/${config.maxRetries} in ${Math.round(wait / 1000)}s`);
      await sleep(withJitter(wait, config.jitter));
    }
  }
  return null;
}

// Open a reader URL, re-requesting it if a JS gate redirects to /_c?… (the gate
// sets a cookie then bounces back).
export async function openReader(page, url, config, logger) {
  logger.info(`opening ${url}`);
  let resp = await navigateWithRetry(page, url, config, logger);
  for (let i = 0; i < 4 && /[/?&]_c\?|\/_c\//.test(page.url()); i++) {
    logger.debug?.(`JS gate detected (${page.url()}); re-requesting (${i + 1}/4)`);
    await sleep(withJitter(3500, config.jitter));
    resp = await navigateWithRetry(page, url, config, logger);
  }
  await sleep(1500);
  return resp;
}
