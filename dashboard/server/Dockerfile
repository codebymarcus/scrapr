# Scraper dashboard server: Fastify API that drives the scraper engine
# (Playwright/Chromium) in-process. Build context is the REPO ROOT, because the
# server imports the engine from ../../src.
FROM node:22-bookworm-slim

# Build tools for better-sqlite3's native addon (used only if no prebuilt binary
# is available for this platform) + certs for Playwright's downloads.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5174 \
    # Skip the engine postinstall's browser download; we install Chromium with
    # its OS libraries below so it matches the resolved Playwright version.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# 1) Engine dependencies (root package.json).
COPY package.json package-lock.json ./
RUN npm ci

# 2) Chromium + its system libraries, matching the installed Playwright version.
RUN npx playwright install --with-deps chromium

# 3) Dashboard server dependencies (fastify, better-sqlite3, zod, ...).
COPY dashboard/server/package.json dashboard/server/package-lock.json ./dashboard/server/
RUN npm ci --prefix dashboard/server

# 4) Application source: the engine and the server.
COPY src ./src
COPY scrape.mjs ./scrape.mjs
COPY dashboard/server ./dashboard/server

EXPOSE 5174
CMD ["node", "dashboard/server/src/server.mjs"]
