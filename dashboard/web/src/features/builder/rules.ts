import type { ImageCandidate, ImageRules, RuleDraft } from "./types";

export const EMPTY_DRAFT: RuleDraft = {
  minWidth: "",
  minHeight: "",
  includeUrl: "",
  excludeUrl: "",
};

function positiveNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmpty(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The rule that is saved: only the fields that are set. */
export function draftToRules(draft: RuleDraft): ImageRules {
  const rules: ImageRules = {};
  const minWidth = positiveNumber(draft.minWidth);
  const minHeight = positiveNumber(draft.minHeight);
  const includeUrl = nonEmpty(draft.includeUrl);
  const excludeUrl = nonEmpty(draft.excludeUrl);
  if (minWidth !== undefined) {
    rules.minWidth = minWidth;
  }
  if (minHeight !== undefined) {
    rules.minHeight = minHeight;
  }
  if (includeUrl !== undefined) {
    rules.includeUrl = includeUrl;
  }
  if (excludeUrl !== undefined) {
    rules.excludeUrl = excludeUrl;
  }
  return rules;
}

/**
 * Whether the rule keeps a candidate. Mirrors the engine's `filterImages`
 * for the rules the form edits: all set rules must pass, and a candidate
 * missing the data a rule needs (no width for `minWidth`) fails it.
 */
export function keepsCandidate(
  candidate: ImageCandidate,
  rules: ImageRules,
): boolean {
  const { minWidth, minHeight, includeUrl, excludeUrl } = rules;
  if (minWidth !== undefined && !((candidate.width ?? -1) >= minWidth)) {
    return false;
  }
  if (minHeight !== undefined && !((candidate.height ?? -1) >= minHeight)) {
    return false;
  }
  if (includeUrl !== undefined && !candidate.url.includes(includeUrl)) {
    return false;
  }
  if (excludeUrl !== undefined && candidate.url.includes(excludeUrl)) {
    return false;
  }
  return true;
}

type Dimension = "width" | "height";

// The threshold for one dimension that keeps every kept image and drops
// every dropped one, or undefined when none does. Thresholds are inclusive
// (>=), so the smallest kept value separates exactly when it exceeds the
// largest dropped value.
function separatingThreshold(
  candidates: readonly ImageCandidate[],
  kept: readonly boolean[],
  dimension: Dimension,
): number | undefined {
  const keptValues: number[] = [];
  const droppedValues: number[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const value = candidate[dimension];
    if (kept[index]) {
      // A kept image of unknown size would fail the rule: give up.
      if (value === undefined) {
        return undefined;
      }
      keptValues.push(value);
    } else if (value !== undefined) {
      droppedValues.push(value);
    }
  }
  if (keptValues.length === 0 || droppedValues.length === 0) {
    return undefined;
  }
  const smallestKept = Math.min(...keptValues);
  const largestDropped = Math.max(...droppedValues);
  return largestDropped < smallestKept ? smallestKept : undefined;
}

/**
 * Derives the generalizing size rule from the operator's keep/drop picks on
 * the test page: per dimension, the smallest kept size when it is larger
 * than every dropped size. A dimension that cannot separate the two sets
 * contributes nothing. The picks themselves are never saved.
 */
export function deriveSizeRule(
  candidates: readonly ImageCandidate[],
  kept: readonly boolean[],
): Pick<ImageRules, "minWidth" | "minHeight"> {
  const rule: Pick<ImageRules, "minWidth" | "minHeight"> = {};
  const minWidth = separatingThreshold(candidates, kept, "width");
  const minHeight = separatingThreshold(candidates, kept, "height");
  if (minWidth !== undefined) {
    rule.minWidth = minWidth;
  }
  if (minHeight !== undefined) {
    rule.minHeight = minHeight;
  }
  return rule;
}

/** Replaces the draft's min width/height with the derived size rule. */
export function applySizeRule(
  draft: RuleDraft,
  rule: Pick<ImageRules, "minWidth" | "minHeight">,
): RuleDraft {
  return {
    ...draft,
    minWidth: rule.minWidth === undefined ? "" : String(rule.minWidth),
    minHeight: rule.minHeight === undefined ? "" : String(rule.minHeight),
  };
}
