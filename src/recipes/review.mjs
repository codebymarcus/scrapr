// Needs-review classification: flags a run item whose job "succeeded" but whose
// output looks suspicious, so a human can check it.
//
// needsReview(result, recipe) takes the batch result shape from scrapeJob/scrapeText
// ({ complete, saved, total, contentType }) and the recipe. It returns true when:
//   - the job completed (complete === true) but nothing was saved (saved === 0), or
//   - the recipe sets image.expectCount and the total does not match it.
// A failed job (complete !== true) is never flagged; it is a retry, not a review.
// Pure; no I/O.

export function needsReview(result, recipe) {
  if (result.complete !== true) return false;
  if (result.saved === 0) return true;
  const expectCount = recipe?.image?.expectCount;
  if (expectCount != null && result.total !== expectCount) return true;
  return false;
}
