import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyAppearance, type Theme } from "@/app/theme";

export type { Theme };

type PreferencesState = {
  theme: Theme;
  grain: boolean;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleGrain: () => void;
  setGrain: (grain: boolean) => void;
};

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: "dark",
      grain: true,
      toggleTheme: () =>
        set((state) => ({
          theme: state.theme === "light" ? "dark" : "light",
        })),
      setTheme: (theme) => set({ theme }),
      toggleGrain: () => set((state) => ({ grain: !state.grain })),
      setGrain: (grain) => set({ grain }),
    }),
    {
      name: "scrapr-preferences",
      partialize: (state) => ({ theme: state.theme, grain: state.grain }),
    },
  ),
);

// Appearance is an app-global concern: keep <html> in sync with the store,
// including the initial (possibly rehydrated) state. The pre-paint script in
// index.html covers the first frame before this module loads.
usePreferencesStore.subscribe(applyAppearance);
applyAppearance(usePreferencesStore.getState());
