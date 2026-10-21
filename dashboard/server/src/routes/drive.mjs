import { randomBytes, timingSafeEqual } from "node:crypto";

const STATE_COOKIE = "drive_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

// Used when no driveAuth is injected (e.g. bare test apps): Drive reports
// "not configured" instead of the routes failing.
const unconfiguredDriveAuth = {
  isConfigured: () => false,
  status: () => ({ configured: false, connected: false, reason: "not-configured" }),
  authUrl: () => {
    throw new Error("Drive is not configured");
  },
  exchangeCode: async () => {
    throw new Error("Drive is not configured");
  },
  disconnect: () => {},
};

const HINTS = {
  "not-configured":
    "Google Drive sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and APP_SECRET_KEY on the server.",
  "needs-reconnect":
    "The stored Google Drive token can't be read (the secret key changed or the token is corrupt). Reconnect Drive.",
  connected: "Google Drive is connected.",
  disconnected: "Drive is not connected. Connect it to upload results.",
};

function hintFor({ connected, reason }) {
  if (reason === "not-configured") return HINTS["not-configured"];
  if (reason === "needs-reconnect") return HINTS["needs-reconnect"];
  return connected ? HINTS.connected : HINTS.disconnected;
}

function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// OAuth CSRF protection: /connect issues a random single-use `state`, kept
// server-side (10 min TTL) AND set as an HttpOnly cookie. /callback only
// exchanges the code when the `state` query param is a pending state and
// matches the cookie, so a forged callback link (login CSRF) can't bind an
// attacker's Google account to this dashboard.
export async function driveRoutes(app, { driveAuth = unconfiguredDriveAuth, now = Date.now } = {}) {
  const pending = new Map(); // state -> expiry ms

  function prune() {
    const t = now();
    for (const [s, exp] of pending) if (exp <= t) pending.delete(s);
  }

  function consumeState(state, cookieState) {
    prune();
    if (!state || !cookieState || !safeEqual(state, cookieState)) return false;
    return pending.delete(state);
  }

  const clearCookie = `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/drive; Max-Age=0`;

  app.get("/api/drive/status", async () => {
    const status = driveAuth.status();
    return { ...status, hint: hintFor(status) };
  });

  app.get("/api/drive/connect", async (req, reply) => {
    if (!driveAuth.isConfigured()) {
      return reply.code(409).send({ error: HINTS["not-configured"] });
    }
    prune();
    const state = randomBytes(24).toString("base64url");
    pending.set(state, now() + STATE_TTL_MS);
    reply.header(
      "set-cookie",
      `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/api/drive; Max-Age=${STATE_TTL_MS / 1000}`,
    );
    return { url: driveAuth.authUrl(state) };
  });

  // Mutating GET (Google redirects the browser here): always ends in a redirect
  // to /settings with a `drive` outcome, never a 500.
  app.get("/api/drive/callback", async (req, reply) => {
    const { code, state, error } = req.query ?? {};
    const cookieState = readCookie(req.headers.cookie, STATE_COOKIE);
    const done = (outcome) => {
      reply.header("set-cookie", clearCookie);
      return reply.redirect(`/settings?drive=${outcome}`, 302);
    };
    if (error) return done("denied");
    if (typeof code !== "string" || !code) return done("error");
    if (typeof state !== "string" || !consumeState(state, cookieState)) return done("error");
    try {
      await driveAuth.exchangeCode(code);
    } catch (err) {
      // Log only message/code: a gaxios error's `config` carries the auth code
      // and client_secret, so never log the error object itself.
      req.log.warn({ message: err?.message, code: err?.code }, "drive code exchange failed");
      return done("error");
    }
    return done("connected");
  });

  app.post("/api/drive/disconnect", async () => {
    driveAuth.disconnect();
    return { disconnected: true };
  });
}
