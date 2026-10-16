import { describe, expect, it } from "vitest";
import {
  applySizeRule,
  deriveSizeRule,
  draftToRules,
  EMPTY_DRAFT,
  keepsCandidate,
} from "./rules";
import type { ImageCandidate } from "./types";

const hero: ImageCandidate = { url: "https://x.test/hero.jpg", width: 800, height: 1200 };
const page: ImageCandidate = { url: "https://x.test/page2.jpg", width: 780, height: 1180 };
const ad: ImageCandidate = { url: "https://x.test/ad.gif", width: 300, height: 250 };
const icon: ImageCandidate = { url: "https://x.test/icon.png", width: 64, height: 64 };

describe("draftToRules", () => {
  it("keeps only the fields that are set and valid", () => {
    expect(
      draftToRules({
        minWidth: " 500 ",
        minHeight: "abc",
        includeUrl: "",
        excludeUrl: " ads/ ",
      }),
    ).toEqual({ minWidth: 500, excludeUrl: "ads/" });
    expect(draftToRules(EMPTY_DRAFT)).toEqual({});
  });
});

describe("keepsCandidate", () => {
  it("applies size and url rules, inclusively", () => {
    expect(keepsCandidate(hero, { minWidth: 800 })).toBe(true);
    expect(keepsCandidate(ad, { minWidth: 800 })).toBe(false);
    expect(keepsCandidate(hero, { includeUrl: "hero" })).toBe(true);
    expect(keepsCandidate(hero, { excludeUrl: "hero" })).toBe(false);
  });

  it("fails a size rule for a candidate of unknown size", () => {
    expect(keepsCandidate({ url: "https://x.test/a.jpg" }, { minWidth: 1 })).toBe(
      false,
    );
  });
});

describe("deriveSizeRule", () => {
  const candidates = [hero, page, ad, icon];

  it("uses the smallest kept size when it exceeds every dropped size", () => {
    expect(deriveSizeRule(candidates, [true, true, false, false])).toEqual({
      minWidth: 780,
      minHeight: 1180,
    });
  });

  it("derives nothing when nothing is dropped", () => {
    expect(deriveSizeRule(candidates, [true, true, true, true])).toEqual({});
  });

  it("skips a dimension that cannot separate kept from dropped", () => {
    const tall = { url: "https://x.test/tall.jpg", width: 200, height: 900 };
    // kept: hero + tall; dropped: ad. Width: 200 < 300 does not separate.
    expect(deriveSizeRule([hero, tall, ad], [true, true, false])).toEqual({
      minHeight: 900,
    });
  });

  it("gives up on a dimension when a kept image has no size", () => {
    const unknown = { url: "https://x.test/u.jpg" };
    expect(deriveSizeRule([hero, unknown, ad], [true, true, false])).toEqual({});
  });
});

describe("applySizeRule", () => {
  it("replaces the min fields and leaves the url filters alone", () => {
    const draft = { ...EMPTY_DRAFT, minWidth: "10", includeUrl: "hero" };
    expect(applySizeRule(draft, { minHeight: 900 })).toEqual({
      minWidth: "",
      minHeight: "900",
      includeUrl: "hero",
      excludeUrl: "",
    });
  });
});
