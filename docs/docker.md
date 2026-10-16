# Running the scraper dashboard with Docker

Two services are orchestrated by Docker Compose:

- **server** — the Fastify API that drives the scraper engine (Playwright +
  Chromium) in-process and owns the queue in SQLite. Built from the repo root
  (it imports the engine from `src/`).
- **web** — the React/Vite dashboard. In production it is a static build served
  by **nginx**, which also reverse-proxies `/api` (and the `/api/ws` WebSocket)
  to `server`, so the browser talks to one same-origin host.

State (the queue DB and run outputs) lives in the `scrapr-data` named volume and
survives restarts.

## Production

```bash
docker compose up --build
```

Open **http://localhost:8080**.

- Change the port: `WEB_PORT=9000 docker compose up --build` → http://localhost:9000.
- Serve from another host/port: the SPA's API origin is baked at build time, so
  set it to match, e.g.
  `PUBLIC_API_BASE=http://my-box:8080 PUBLIC_WS_BASE=ws://my-box:8080 WEB_PORT=8080 docker compose up --build`.

Only the `web` port is published; `server` is reachable only inside the compose
network (which also keeps its `/api/thumb` and import endpoints off the public
interface — see the pre-hosting notes in the design spec before exposing it).

## Development (hot reload)

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

Open **http://localhost:5173** (Vite).

- `web`: Vite HMR; source is bind-mounted.
- `server`: `node --watch` restarts on change; `src/`, `scrape.mjs`, and
  `dashboard/server/src` are bind-mounted.
- Vite dev-proxies `/api` (incl. the WebSocket) to `server`, so the SPA stays
  same-origin with no CORS. The server is also published on `:5174` for poking
  the API directly.

## One-off CLI scrape

The `server` image contains the engine and Chromium, so the original CLI runs in it:

```bash
docker compose run --rm server node scrape.mjs <reader-url> [options]
```

## Google Drive uploads (optional)

Drive upload needs OAuth credentials. Run the one-time authorization **on the
host** to produce `credentials.json` + `token.json`:

```bash
node authorize.mjs
```

Then uncomment the two credential volume lines in `compose.yaml` (`server`
service) and restart. The dashboard's Settings → Drive page shows the status.

## Notes

- The `server` image installs Chromium with its OS libraries
  (`playwright install --with-deps chromium`) so the browser matches the
  resolved Playwright version; the first build is therefore large.
- `better-sqlite3` is a native addon; the image includes the build toolchain as
  a fallback when no prebuilt binary is available.
