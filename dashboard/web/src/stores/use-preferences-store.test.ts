import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "scrapr-preferences";

function createLocalStorageMock() {
  const data = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    clear: vi.fn(() => data.clear()),
    key: vi.fn((index: number) => [...data.keys()][index] ?? null),
    get length() {
      return data.size;
    },
  };
}

type LocalStorageMock = ReturnType<typeof createLocalStorageMock>;

let storage: LocalStorageMock;

async function loadStore() {
  vi.resetModules();
  const module = await import("./use-preferences-store");
  return module.usePreferencesStore;
}

function readPersisted() {
  return JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
}

beforeEach(() => {
  storage = createLocalStorageMock();
  vi.stubGlobal("localStorage", storage);
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-grain");
});

describe("usePreferencesStore", () => {
  it("defaults to the dark theme with grain on", async () => {
    const usePreferencesStore = await loadStore();

    expect(usePreferencesStore.getState().theme).toBe("dark");
    expect(usePreferencesStore.getState().grain).toBe(true);
  });

  it("toggleTheme flips between dark and light", async () => {
    const usePreferencesStore = await loadStore();

    usePreferencesStore.getState().toggleTheme();
    expect(usePreferencesStore.getState().theme).toBe("light");

    usePreferencesStore.getState().toggleTheme();
    expect(usePreferencesStore.getState().theme).toBe("dark");
  });

  it("setTheme and setGrain set explicit values", async () => {
    const usePreferencesStore = await loadStore();

    usePreferencesStore.getState().setTheme("light");
    usePreferencesStore.getState().setGrain(false);

    expect(usePreferencesStore.getState().theme).toBe("light");
    expect(usePreferencesStore.getState().grain).toBe(false);
  });

  it("toggleGrain flips the grain flag", async () => {
    const usePreferencesStore = await loadStore();

    usePreferencesStore.getState().toggleGrain();
    expect(usePreferencesStore.getState().grain).toBe(false);

    usePreferencesStore.getState().toggleGrain();
    expect(usePreferencesStore.getState().grain).toBe(true);
  });

  it("persists only theme and grain under scrapr-preferences", async () => {
    const usePreferencesStore = await loadStore();

    usePreferencesStore.getState().toggleTheme();
    usePreferencesStore.getState().toggleGrain();

    expect(readPersisted().state).toEqual({ theme: "light", grain: false });
  });

  it("rehydrates the saved preferences", async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { theme: "light", grain: false }, version: 0 }),
    );

    const usePreferencesStore = await loadStore();

    expect(usePreferencesStore.getState().theme).toBe("light");
    expect(usePreferencesStore.getState().grain).toBe(false);
  });

  it("applies data-theme and data-grain to the document element", async () => {
    const usePreferencesStore = await loadStore();
    const root = document.documentElement;

    expect(root.dataset.theme).toBe("dark");
    expect(root.hasAttribute("data-grain")).toBe(true);

    usePreferencesStore.getState().toggleTheme();
    usePreferencesStore.getState().toggleGrain();

    expect(root.dataset.theme).toBe("light");
    expect(root.hasAttribute("data-grain")).toBe(false);

    usePreferencesStore.getState().toggleGrain();
    expect(root.hasAttribute("data-grain")).toBe(true);
  });
});
