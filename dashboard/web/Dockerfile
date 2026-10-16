# Scraper dashboard web (React + Vite). Multi-stage:
#   dev   -> vite dev server (source bind-mounted by compose.dev.yaml)
#   prod  -> static build served by nginx, which also reverse-proxies /api
# Build context is dashboard/web.

# --- base: install dependencies, copy source ---
FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# --- dev: hot-reloading vite dev server ---
FROM base AS dev
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

# --- build: produce static assets ---
FROM base AS build
# Same-origin with the nginx host: the SPA calls <origin>/api, nginx proxies it.
ARG VITE_API_BASE=http://localhost:8080
ARG VITE_WS_BASE=ws://localhost:8080
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_WS_BASE=$VITE_WS_BASE
RUN npm run build

# --- prod: nginx serves the SPA and proxies the API to the server ---
FROM nginx:1.27-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
