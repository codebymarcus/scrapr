// src/preview/text-preview.mjs
// No-write text/field preview for a dashboard's project builder. Resolves the
// extraction mode/opts from a recipe, runs the existing acquire+extract step, and
// returns the detected fields/values. It never touches the filesystem.
import { acquireAndExtract as defaultAcquire } from "../text/acquire.mjs";
import { buildOpts, resolveMode } from "../text/scrape-text.mjs";
import { recipeToProfile } from "../recipes/recipe.mjs";
import { FailureCode } from "../strategies/strategy.mjs";

// Order `entries` ([name, value]) by `declared` names first, then the rest in
// their original (payload) order. Declared names absent from the payload are skipped.
function orderByDeclared(entries, declared) {
  const byName = new Map(entries);
  const out = [];
  for (const name of declared) {
    if (byName.has(name)) { out.push({ name, value: byName.get(name) }); byName.delete(name); }
  }
  for (const [name, value] of byName) out.push({ name, value });
  return out;
}

function normalize(payload, opts) {
  if (payload.kind === "selector") {
    const declared = (opts.fields || []).map((f) => f.name);
    return orderByDeclared(Object.entries(payload.fields || {}), declared);
  }
  if (payload.kind === "pattern") {
    const grouped = new Map();
    for (const m of payload.matches || []) {
      if (!grouped.has(m.type)) grouped.set(m.type, []);
      grouped.get(m.type).push(m.value);
    }
    const declared = (opts.patterns || []).map((p) => p.name);
    return orderByDeclared([...grouped], declared);
  }
  const { title, byline, excerpt, markdown } = payload;
  return { title, byline, excerpt, markdown };
}

export async function previewText({ url, recipe, session, config, logger, deps = {} }) {
  const acquire = deps.acquireAndExtract || defaultAcquire;
  let mode;
  let opts;
  try {
    const profile = recipeToProfile(recipe);
    mode = resolveMode(config || {}, profile);
    opts = buildOpts(mode, config || {}, profile);
  } catch (err) {
    return { status: "fail", code: FailureCode.PARSER_ERROR, message: err.message };
  }
  const res = await acquire({ url, mode, opts, session, config, logger, deps });
  if (res.status !== "ok") return { status: "fail", code: res.code };
  return { status: "ok", via: res.via, mode, fields: normalize(res.payload, opts) };
}
