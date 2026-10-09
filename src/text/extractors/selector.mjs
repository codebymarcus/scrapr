// src/text/extractors/selector.mjs
// Named-field extraction by CSS selector. attr → element attribute, else trimmed
// textContent; many:true → array of all matches, else first (or null). Pure.
export function extractSelector(doc, html, { fields = [] } = {}) {
  const read = (el, attr) => {
    if (!el) return null;
    const v = attr ? el.getAttribute(attr) : el.textContent;
    return v == null ? null : String(v).trim();
  };
  const out = {};
  let any = false;
  for (const f of fields) {
    if (f.many) {
      const vals = [...doc.querySelectorAll(f.selector)].map((el) => read(el, f.attr)).filter((v) => v != null && v !== "");
      out[f.name] = vals;
      if (vals.length) any = true;
    } else {
      const v = read(doc.querySelector(f.selector), f.attr);
      out[f.name] = v && v !== "" ? v : null;
      if (out[f.name] != null) any = true;
    }
  }
  return { kind: "selector", empty: !any, fields: out };
}
