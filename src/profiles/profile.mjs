// Site profile shape and helpers. A profile is per-site DATA (optionally with
// function hooks) that maps a URL to an ordered pipeline of named mechanisms.
//
// Profile = {
//   name: string,
//   match: (url: string) => boolean,
//   contentType: "image",                 // "text" is a future content type
//   pipeline: Array<{ mechanism: string, maxAttempts?: number, params?: object }>,
//   metadata: object                      // reserved seam (sub-project #2); may be {}
// }
export const ContentType = Object.freeze({ IMAGE: "image" });

// Build a matcher for one or more hosts: true when the URL's hostname equals a
// host or is a subdomain of it. Safe on malformed URLs (returns false).
export function hostMatch(...hosts) {
  const set = hosts.map((h) => String(h).toLowerCase());
  return (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return set.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };
}
