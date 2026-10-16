import type { ImageCandidate } from "../types";

export const HERO_1: ImageCandidate = {
  url: "https://cdn.test/ch1/hero-1.jpg",
  width: 800,
  height: 1200,
};
export const HERO_2: ImageCandidate = {
  url: "https://cdn.test/ch1/hero-2.jpg",
  width: 820,
  height: 1230,
};
export const AD: ImageCandidate = {
  url: "https://cdn.test/ads/banner.gif",
  width: 300,
  height: 250,
};
export const ICON: ImageCandidate = {
  url: "https://cdn.test/ui/icon.png?x=1&y=2",
  width: 64,
  height: 64,
};

/** Two real pages plus an ad and an icon: the classic "drop the junk" page. */
export const CANDIDATES: ImageCandidate[] = [HERO_1, HERO_2, AD, ICON];

export function thumbSrc(base: string, url: string, pageUrl?: string): string {
  const referer = pageUrl ? `&referer=${encodeURIComponent(pageUrl)}` : "";
  return `${base}/api/thumb?url=${encodeURIComponent(url)}${referer}`;
}
