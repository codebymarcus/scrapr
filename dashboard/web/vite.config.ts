import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Resolve bare `@use "styles/..."` from src, at any component depth.
        loadPaths: [srcDir],
      },
    },
  },
});
