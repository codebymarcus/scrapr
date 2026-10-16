// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const themePath = fileURLToPath(
  new URL("./settings/_theme.scss", import.meta.url),
);

// Guards the vintage palette from drift: if a token value changes, this fails.
const VINTAGE_TOKENS: Record<string, string> = {
  "--color-base": "#060F1A",
  "--color-background": "#0B192C",
  "--color-surface": "#102A45",
  "--color-surface-hover": "#1E3E62",
  "--color-border": "#23405F",
  "--color-border-strong": "#1E3E62",
  "--color-text": "#EFE3CC",
  "--color-text-secondary": "#A99F86",
  "--color-accent": "#FF6500",
  "--color-accent-hover": "#FF7D2B",
  "--color-accent-burnt": "#D9550A",
  "--color-focus": "#FF6500",
  "--color-positive": "#7FAE63",
  "--color-warn": "#D9A441",
  "--color-negative": "#CF5B4C",
};

describe("vintage theme tokens", () => {
  const scss = readFileSync(themePath, "utf8");

  it.each(Object.entries(VINTAGE_TOKENS))("declares %s: %s", (name, value) => {
    expect(scss).toContain(`${name}: ${value}`);
  });

  it("makes the dark theme the default", () => {
    expect(scss).toContain(':root[data-theme="dark"]');
  });
});
