// Maps configured strategy names to instances and resolves the ordered pipeline.
// Adding a strategy = create its file + add one line to STRATEGY_FACTORIES.
import { BrowserKeyboardStrategy } from "./browser-keyboard.mjs";
import { ChapterAwareStrategy } from "./chapter-aware.mjs";

export const STRATEGY_FACTORIES = {
  current: () => new BrowserKeyboardStrategy(),
  "chapter-aware": () => new ChapterAwareStrategy()
};

// Mechanism factories: name → (params) => strategy. A profile's pipeline names
// these; `params` are per-site overrides merged over config at execute time.
export const MECHANISMS = {
  current: (params = {}) => new BrowserKeyboardStrategy({ params }),
  "chapter-aware": (params = {}) => new ChapterAwareStrategy({ params })
};

// Default pipeline when config.strategies is omitted: today's behaviour as
// Stage 1, then the chapter-aware fallback.
export const DEFAULT_PIPELINE = [
  { name: "current", maxAttempts: 2 },
  { name: "chapter-aware", maxAttempts: 1 }
];

// Resolve config.strategies into an ordered [{ strategy, maxAttempts }] list,
// dropping disabled/invalid/unknown entries with a warning. null/undefined →
// the default pipeline. maxAttempts:0 (or enabled:false) disables an entry.
export function resolveStrategies(config, logger, factories = STRATEGY_FACTORIES) {
  const specs = Array.isArray(config?.strategies) ? config.strategies : DEFAULT_PIPELINE;
  const resolved = [];
  for (const spec of specs) {
    if (!spec || typeof spec.name !== "string") {
      logger?.warn?.(`ignoring invalid strategy entry: ${JSON.stringify(spec)}`);
      continue;
    }
    if (spec.enabled === false) continue;
    const factory = factories[spec.name];
    if (!factory) {
      logger?.warn?.(`unknown strategy "${spec.name}" — skipping`);
      continue;
    }
    const strategy = factory();
    const maxAttempts = Number.isInteger(spec.maxAttempts) ? spec.maxAttempts : (strategy.defaultMaxAttempts ?? 1);
    if (maxAttempts < 1) continue; // 0 disables, same as enabled:false
    resolved.push({ strategy, maxAttempts });
  }
  return resolved;
}
