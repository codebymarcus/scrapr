// Stage 1: the existing flow, unchanged in behaviour: open the reader past its
// JS gate, then press the advance key through the virtualized reader while the
// shared ImageCapture collects images. Collaborators are injectable for testing.
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { ReaderDriver as DefaultReaderDriver } from "../reader.mjs";
import { ok, failed, mapError } from "./strategy.mjs";
import { extractMetadata as defaultExtractMetadata } from "../metadata.mjs";

export class BrowserKeyboardStrategy {
  constructor({ openReader = defaultOpenReader, ReaderDriver = DefaultReaderDriver, params = {}, extractMetadata = defaultExtractMetadata } = {}) {
    this.name = "current";
    this.defaultMaxAttempts = 2;
    this._openReader = openReader;
    this._ReaderDriver = ReaderDriver;
    this.params = params;
    this.extractMetadata = extractMetadata;
  }

  async execute({ session, job, config, capture, meter, logger, profile }) {
    const page = await session.newPage();
    const cfg = { ...config, ...this.params };
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, cfg, logger);
      const { total } = await new this._ReaderDriver(page, capture, cfg, logger).run();
      const metadata = await this.extractMetadata(page, profile?.metadata || {}).catch(() => ({ title: null, count: null }));
      return ok({ downloaded: capture.size, total, metadata });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }
}
