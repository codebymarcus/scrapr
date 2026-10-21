// Judge an acquire pass's completeness from the shared capture's counts, the
// single authority every strategy is measured by, kept separate from the
// strategies so "how to scrape" and "is it valid" stay independent.
import { decideOutcome } from "./outcome.mjs";
import { missingPages } from "./processor.mjs";
import { FailureCode } from "./strategies/strategy.mjs";

export function validate({ downloaded, total, seeded = 0, images = [], acceptPartial = false }) {
  const t = total || 0;
  if (!(downloaded > 0)) {
    return { status: "failed", code: FailureCode.EMPTY_RESULT, downloaded: downloaded || 0, total: t, missing: [], stagnant: false, acceptedPartial: false };
  }
  const o = decideOutcome({ downloaded, total, seeded, acceptPartial });
  if (o.complete) return { status: "success", downloaded, total: t, missing: [], stagnant: o.stagnant, acceptedPartial: o.acceptedPartial };
  return { status: "incomplete", code: FailureCode.INCOMPLETE_RESULT, downloaded, total: t, missing: missingPages(images, total), stagnant: o.stagnant, acceptedPartial: false };
}
