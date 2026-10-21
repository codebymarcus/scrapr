// Decide a download's outcome from the counts. `seeded` is how many pages were
// already in the cache before this run; `downloaded` is the total now held.
//   - complete: enough pages to package (reached total, or total unknown).
//   - stagnant: an incomplete rerun that produced no new pages; the reader has
//     nothing more to give (over-counted total, or a genuinely missing page).
//   - acceptedPartial: a stagnant rerun the user chose to keep (--accept-partial).
export function decideOutcome({ downloaded, total, seeded, acceptPartial }) {
  const complete = downloaded > 0 && (!(total > 0) || downloaded >= total);
  if (complete) return { complete: true, acceptedPartial: false, stagnant: false };
  const stagnant = seeded > 0 && downloaded - seeded <= 0;
  if (stagnant && acceptPartial && downloaded > 0) {
    return { complete: true, acceptedPartial: true, stagnant: true };
  }
  return { complete: false, acceptedPartial: false, stagnant };
}
