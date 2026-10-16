export type Theme = "light" | "dark";

type AppearancePreferences = {
  theme: Theme;
  grain: boolean;
};

// Reflect appearance preferences onto <html>: `data-theme` selects the palette
// and the presence of `data-grain` opts in to the film-grain overlay.
export function applyAppearance({ theme, grain }: AppearancePreferences) {
  const root = document.documentElement;

  root.dataset.theme = theme;

  if (grain) {
    root.setAttribute("data-grain", "");
  } else {
    root.removeAttribute("data-grain");
  }
}
