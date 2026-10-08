// src/text/markdown.mjs
// Pure HTML→Markdown conversion + .md document assembly. turndown bundles its own
// Node DOM (@mixmark-io/domino), so this needs no jsdom.
import TurndownService from "turndown";

export function htmlToMarkdown(html) {
  if (!html) return "";
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  // turndown's default renders "-   item" (marker + 3 spaces); emit the compact "- item".
  td.addRule("listItem", {
    filter: "li",
    replacement(content, node, options) {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n");
      const parent = node.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }
      const indented = body.replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      return prefix + indented + (node.nextSibling && !/\n$/.test(indented) ? "\n" : "");
    },
  });
  return td.turndown(String(html)).trim();
}

// Assemble the final .md: YAML frontmatter (present fields only) + an H1 title +
// the Markdown body. String values are quoted and escaped for YAML.
export function buildMarkdownDoc({ title, source, date, byline, excerpt, markdown } = {}) {
  const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const fm = [];
  if (title) fm.push(`title: ${q(title)}`);
  if (source) fm.push(`source: ${q(source)}`);
  if (date) fm.push(`date: ${q(date)}`);
  if (byline) fm.push(`author: ${q(byline)}`);
  if (excerpt) fm.push(`excerpt: ${q(excerpt)}`);
  const front = fm.length ? `---\n${fm.join("\n")}\n---\n\n` : "";
  const head = title ? `# ${title}\n\n` : "";
  return `${front}${head}${markdown || ""}\n`;
}
