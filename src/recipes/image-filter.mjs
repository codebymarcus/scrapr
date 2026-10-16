// Pure image filter rules: "keep the hero, drop the ad".
//
// filterImages(candidates, rules) returns the subset of Candidate descriptors
// ({ url, width, height, selector, index, bytes? }) that satisfy every configured
// rule. ImageRules fields are all optional and ANDed together:
//   minWidth, minHeight, minBytes  numeric lower bounds (inclusive)
//   includeSelector, excludeSelector  substring match on candidate.selector
//   includeUrl, excludeUrl            substring match on candidate.url
//   position                          { from?, to? } inclusive range over candidate.index
//
// Choices made here:
//   - null, undefined, or an empty rules object returns `candidates` itself (same array).
//   - Missing data fails the rule that needs it. A candidate with no width fails
//     minWidth, a candidate with no bytes fails minBytes, and so on, because we cannot
//     confirm it passes. Rules that do not reference a missing field are unaffected.
//   - Include rules (includeSelector, includeUrl, position) fail when the field is missing.
//     Exclude rules pass when the field is missing, since nothing can match the substring.
//   - An unset rule value (undefined, null, or "" for string rules) is ignored. An empty
//     string would otherwise match every candidate, and excludeSelector "" would drop all.
//
// Pure: no I/O, no dependencies.

const isSet = (value) => value !== undefined && value !== null && value !== "";

const numericAtLeast = (value, min) => typeof value === "number" && value >= min;

// Returns a predicate that tests one candidate against every configured rule.
function buildPredicate(rules) {
  const checks = [];

  if (isSet(rules.minWidth)) checks.push((c) => numericAtLeast(c.width, rules.minWidth));
  if (isSet(rules.minHeight)) checks.push((c) => numericAtLeast(c.height, rules.minHeight));
  if (isSet(rules.minBytes)) checks.push((c) => numericAtLeast(c.bytes, rules.minBytes));

  if (isSet(rules.includeSelector)) {
    checks.push((c) => typeof c.selector === "string" && c.selector.includes(rules.includeSelector));
  }
  if (isSet(rules.excludeSelector)) {
    checks.push((c) => !(typeof c.selector === "string" && c.selector.includes(rules.excludeSelector)));
  }

  if (isSet(rules.includeUrl)) {
    checks.push((c) => typeof c.url === "string" && c.url.includes(rules.includeUrl));
  }
  if (isSet(rules.excludeUrl)) {
    checks.push((c) => !(typeof c.url === "string" && c.url.includes(rules.excludeUrl)));
  }

  const { from, to } = rules.position ?? {};
  if (isSet(from) || isSet(to)) {
    checks.push((c) => {
      if (typeof c.index !== "number") return false;
      if (isSet(from) && c.index < from) return false;
      if (isSet(to) && c.index > to) return false;
      return true;
    });
  }

  return (candidate) => checks.every((check) => check(candidate));
}

// Keep only the candidates that satisfy every rule in `rules`.
export function filterImages(candidates, rules) {
  if (!rules || Object.keys(rules).length === 0) return candidates;
  const keep = buildPredicate(rules);
  return candidates.filter(keep);
}
