# Setup — files to create before running

This project keeps secrets and local data **out of git**. A fresh clone needs a
few files created first; each has a committed `*.example` template to copy. None
of the real files below are committed (they're in `.gitignore`).

## Prerequisites

- Node.js **>= 22**
- (Optional) Docker + Docker Compose, to run the whole stack

## Files you must create

| Create | Copy from | Needed for | Required? |
|--------|-----------|------------|-----------|
| `dashboard/server/.env` | `dashboard/server/.env.example` | Dashboard server: Google Drive OAuth + token-encryption key | Required for in‑app Drive upload; the app otherwise runs and shows Drive as "not configured" |
| `dashboard/web/.env` | `dashboard/web/.env.example` | Web dev server (local, non‑Docker `vite` only) | Only for local `vite` dev; Compose sets these itself |
| `scraper.config.json` | `scraper.config.example.json` | CLI scraper settings | Optional (CLI has defaults; `--config` overrides) |
| `credentials.json` | `credentials.json.example` | **CLI only** (`node authorize.mjs`) — a Google OAuth **Desktop** client | Only if you use the terminal Drive upload path |
| `token.json` | — (generated) | CLI Drive auth token | Created automatically by `node authorize.mjs` |

> The **dashboard** and the **CLI** use *different* Google OAuth clients:
> the dashboard uses a **Web application** client via `dashboard/server/.env`;
> the CLI uses a **Desktop app** client saved as `credentials.json`.

## 1. Server environment (`dashboard/server/.env`)

```bash
cp dashboard/server/.env.example dashboard/server/.env
```

Then fill it in:

- **`APP_SECRET_KEY`** — generate once and keep it stable (changing it makes the
  stored Drive token undecryptable):
  ```bash
  openssl rand -base64 32
  ```
- **`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`** — from a Google Cloud
  Console OAuth **"Web application"** client (APIs & Services → Credentials), with
  the Google Drive API enabled.
- **`GOOGLE_OAUTH_REDIRECT_URI`** — must *exactly* equal the origin you browse the
  dashboard from plus `/api/drive/callback`, and be registered under the OAuth
  client's **Authorized redirect URIs**:
  - Compose (nginx): `http://localhost:8080/api/drive/callback`
  - Compose dev (Vite): `http://localhost:5173/api/drive/callback`
  - Local `npm start`: `http://localhost:5174/api/drive/callback`

Without these the dashboard still runs — Drive just reports "not configured".

## 2. Web environment (local `vite` dev only)

Skip this when running via Docker Compose (it injects these). For a bare
`npm run dev` in `dashboard/web`:

```bash
cp dashboard/web/.env.example dashboard/web/.env
```

## 3. CLI Drive auth (optional — terminal upload path)

Only if you run the scraper from the terminal with `--drive`:

1. Download a Google OAuth **"Desktop app"** client JSON, save it as
   `credentials.json` at the repo root (see `credentials.json.example` for the shape).
2. Authorize once — this writes `token.json`:
   ```bash
   node authorize.mjs
   ```

## Running

**Docker Compose (production-like):**
```bash
docker compose up --build
# open http://localhost:8080
```

**Docker Compose (hot-reload dev):**
```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
# open http://localhost:5173
```

**Local (no Docker):**
```bash
# server
cd dashboard/server && npm install && npm start      # :5174
# web (separate terminal)
cd dashboard/web && npm install && npm run dev        # :5173
```

**CLI scraper:**
```bash
npm install
node scrape.mjs --help
```

## Security notes

- The real `.env`, `credentials.json`, `token.json`, `scraper.config.json`, and
  the SQLite DB (`dashboard/server/data/`) are **gitignored** — don't commit them.
- The Drive token is stored **AES‑256‑GCM encrypted** in the DB; the key is
  `APP_SECRET_KEY` (kept only in your environment / `.env`).
- `git add .` will not stage any secret, but treat your OAuth client secret as
  sensitive and rotate it if it's ever exposed.
