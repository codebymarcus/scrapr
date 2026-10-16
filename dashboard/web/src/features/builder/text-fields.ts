import type { TextFieldEntry } from "./types";

const ARTICLE_KEYS = ["title", "byline", "excerpt", "markdown"];

function valueToString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => valueToString(item))
      .filter((item): item is string => item !== null)
      .join("\n");
  }
  return null;
}

/**
 * Turns the text preview's loosely typed `fields` into a flat list. The
 * server sends an array of `{name, value}` for selector/pattern modes (value
 * a string or a list of strings) and an object for article mode. Anything
 * unrecognized is skipped rather than thrown on.
 */
export function normalizeTextFields(fields: unknown): TextFieldEntry[] {
  if (Array.isArray(fields)) {
    const entries: TextFieldEntry[] = [];
    for (const item of fields) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const { name, value } = item as { name?: unknown; value?: unknown };
      const text = valueToString(value);
      if (typeof name === "string" && name !== "" && text !== null) {
        entries.push({ name, value: text });
      }
    }
    return entries;
  }

  if (typeof fields === "object" && fields !== null) {
    const record = fields as Record<string, unknown>;
    const names = [
      ...ARTICLE_KEYS.filter((key) => key in record),
      ...Object.keys(record).filter((key) => !ARTICLE_KEYS.includes(key)),
    ];
    const entries: TextFieldEntry[] = [];
    for (const name of names) {
      const text = valueToString(record[name]);
      if (text !== null && text !== "") {
        entries.push({ name, value: text });
      }
    }
    return entries;
  }

  return [];
}
