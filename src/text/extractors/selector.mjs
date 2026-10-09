// src/text/extractors/selector.mjs
// Named-field extraction by CSS selector. attr → element attribute, else trimmed
// textContent; many:true → array of all matches, else first (or null). Pure.
export function extractSelector(doc, html, { fields = [] } = {}) {
  const read = (el, attr) => {
    if (!el) return null;
    const v = attr ? el.getAttribute(attr) : el.textContent;
    return v == null ? null : String(v).trim();
  };
  // An invalid CSS selector throws SyntaxError; treat it as "no match".
  const safeAll = (sel) => { try { return [...doc.querySelectorAll(sel)]; } catch { return []; } };
  const safeOne = (sel) => { try { return doc.querySelector(sel); } catch { return null; } };
  const out = {};
  let any = false;
  for (const f of fields) {
    if (f.many) {
      const vals = safeAll(f.selector).map((el) => read(el, f.attr)).filter((v) => v != null && v !== "");
      out[f.name] = vals;
      if (vals.length) any = true;
    } else {
      const v = read(safeOne(f.selector), f.attr);
      out[f.name] = v && v !== "" ? v : null;
      if (out[f.name] != null) any = true;
    }
  }
  return { kind: "selector", empty: !any, fields: out };
}
