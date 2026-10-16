import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// Dev only: proxy /api (and the /api/ws WebSocket) to the backend so the SPA
// stays same-origin and needs no CORS. Override the target with
// VITE_PROXY_TARGET (e.g. http://server:5174 inside docker compose dev).
const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:5174";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
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
