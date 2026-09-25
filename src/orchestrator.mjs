// The orchestrator decides WHICH strategy runs next: it retries a strategy for
// transient (retryable) failures up to its maxAttempts, then falls back to the
// next strategy. It stops on the first valid result and records every attempt.
// It contains no strategy-specific scraping logic.
import { isRetryable, failed, mapError, FailureCode } from "./strategies/strategy.mjs";
import { formatPageList } from "./processor.mjs";

export class ScrapingOrchestrator {
  // strategies: [{ strategy, maxAttempts }] (resolved & ordered)
  // validate:   the result-validator function (injected for testability)
  constructor(strategies, validate, logger) {
    this.strategies = strategies;
    this.validate = validate;
    this.logger = logger;
  }

  async run(ctx) {
    const attempts = [];
    const N = this.strategies.length;
    let last = { downloaded: 0, total: 0 };

    for (let s = 0; s < N; s++) {
      const { strategy, maxAttempts } = this.strategies[s];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.logger.info(`[${s + 1}/${N}] strategy=${strategy.name} attempt ${attempt}/${maxAttempts}`);
        const t0 = Date.now();
        let res;
        try {
          // Inject the orchestrator's logger so every strategy logs consistently,
          // regardless of what the caller put in ctx.
          res = await strategy.execute({ ...ctx, logger: this.logger });
        } catch (e) {
          res = failed(mapError(e), e?.message);
        }
        const durationMs = Date.now() - t0;

        let status, code, downloaded, total, missing = [];
        if (res.status === "failed") {
          status = "failed";
          code = res.error?.code ?? FailureCode.UNKNOWN_ERROR;
          downloaded = res.data?.downloaded ?? ctx.capture.size;
          total = res.data?.total ?? last.total;
        } else {
          const v = this.validate({
            downloaded: res.data?.downloaded ?? ctx.capture.size,
            total: res.data?.total,
            seeded: ctx.seeded,
            images: ctx.capture.list(),
            acceptPartial: ctx.config?.acceptPartial
          });
          status = v.status;
          code = v.code;
          downloaded = v.downloaded;
          total = v.total;
          missing = v.missing || [];
        }
        last = { downloaded, total };
        attempts.push({ name: strategy.name, attempt, status, code, downloaded, total, durationMs });
        this.logger.info(`      → ${status.toUpperCase()} (${downloaded}/${total || "?"})`);
        if (status === "incomplete" && missing.length) this.logger.warn(`      missing page(s): ${formatPageList(missing)}`);

        if (status === "success") {
          this.logger.success(`✓ completed using strategy: ${strategy.name}`);
          return { status: "success", usedStrategy: strategy.name, downloaded, total, attempts };
        }
        // Retry the SAME strategy only for retryable transport failures.
        if (status === "failed" && isRetryable(code) && attempt < maxAttempts) continue;
        break; // otherwise fall back to the next strategy
      }
    }

    reportFailure(this.logger, ctx.job, attempts);
    return { status: "failed", usedStrategy: null, downloaded: last.downloaded, total: last.total, attempts };
  }
}

// The final-failure table: one line per recorded attempt.
export function reportFailure(logger, job, attempts) {
  logger.warn(`✗ failed: ${job?.url ?? ""}`);
  logger.warn("  strategies attempted:");
  attempts.forEach((a, i) => {
    const detail = a.code ? a.code : `${a.downloaded}/${a.total || "?"}`;
    logger.warn(`    ${i + 1}. ${a.name} (attempt ${a.attempt}) → ${a.status.toUpperCase()} (${detail})`);
  });
  logger.warn("  final status: FAILED");
}
