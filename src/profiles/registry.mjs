// Profile registry: resolve a URL to a profile, and a profile to the
// orchestrator's ordered [{ strategy, maxAttempts }] mechanism list.
import batcave from "./batcave.mjs";
import generic from "./generic.mjs";
import { MECHANISMS } from "../strategies/registry.mjs";

// First match wins; `generic` matches everything and is last.
export const PROFILES = [batcave, generic];

export function resolveProfile(url, profiles = PROFILES) {
  for (const p of profiles) {
    try { if (p.match(url)) return p; } catch { /* ignore a bad matcher */ }
  }
  return generic;
}

// Build the mechanism pipeline for a job. A non-empty config.strategies overrides
// the profile's pipeline globally (back-compat); its entries use `name`, a
// profile's entries use `mechanism` — both are accepted.
export function resolvePipeline(profile, config, logger, mechanisms = MECHANISMS) {
  const override = Array.isArray(config?.strategies) && config.strategies.length ? config.strategies : null;
  const specs = override || profile.pipeline || [];
  const out = [];
  for (const spec of specs) {
    const key = spec && (spec.mechanism || spec.name);
    if (!spec || typeof key !== "string") {
      logger?.warn?.(`ignoring invalid pipeline entry: ${JSON.stringify(spec)}`);
      continue;
    }
    if (spec.enabled === false) continue;
    const make = mechanisms[key];
    if (!make) { logger?.warn?.(`unknown mechanism "${key}" — skipping`); continue; }
    const strategy = make(spec.params || {});
    const maxAttempts = Number.isInteger(spec.maxAttempts) ? spec.maxAttempts : (strategy.defaultMaxAttempts ?? 1);
    if (maxAttempts < 1) continue; // 0 disables
    out.push({ strategy, maxAttempts });
  }
  return out;
}
