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
  listAccounts: () => [],
  renameAccount: () => {},
};

const MAX_LABEL_LENGTH = 100;

// Returns the trimmed label, or null when it is not a usable account label.
function parseLabel(body) {
  const label = body?.label;
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LABEL_LENGTH ? trimmed : null;
}

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
// attacker's Google account to this dashboard. An optional reconnect target
// account id is bound to the state in the server-side map value; the callback
// reads it from there, never from the request.
export async function driveRoutes(app, { driveAuth = unconfiguredDriveAuth, now = Date.now } = {}) {
  const pending = new Map(); // state -> { expiry ms, targetAccountId }

  function prune() {
    const t = now();
    for (const [s, entry] of pending) if (entry.expiry <= t) pending.delete(s);
  }

  function consumeState(state, cookieState) {
    prune();
    if (!state || !cookieState || !safeEqual(state, cookieState)) return null;
    const entry = pending.get(state);
    if (!entry) return null;
    pending.delete(state);
    return entry;
  }

  function hasAccount(id) {
    return driveAuth.listAccounts().some((a) => a.id === id);
  }

  const clearCookie = `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/drive; Max-Age=0`;

  app.get("/api/drive/status", async () => {
    const status = driveAuth.status();
    return { ...status, hint: hintFor(status) };
  });

  app.get("/api/drive/accounts", async () => ({
    configured: driveAuth.isConfigured(),
    accounts: driveAuth.listAccounts(),
  }));

  app.get("/api/drive/connect", async (req, reply) => {
    if (!driveAuth.isConfigured()) {
      return reply.code(409).send({ error: HINTS["not-configured"] });
    }
    const { accountId } = req.query ?? {};
    let targetAccountId;
    if (accountId !== undefined) {
      if (typeof accountId !== "string" || !hasAccount(accountId)) {
        return reply.code(404).send({ error: "Drive account not found" });
      }
      targetAccountId = accountId;
    }
    prune();
    const state = randomBytes(24).toString("base64url");
    pending.set(state, { expiry: now() + STATE_TTL_MS, targetAccountId });
    reply.header(
      "set-cookie",
      `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/api/drive; Max-Age=${STATE_TTL_MS / 1000}`,
    );
    return { url: driveAuth.authUrl(state) };
  });

  // Mutating GET (Google redirects the browser here): always ends in a redirect
  // to /settings with a `drive` outcome — never a 500.
  app.get("/api/drive/callback", async (req, reply) => {
    const { code, state, error } = req.query ?? {};
    const cookieState = readCookie(req.headers.cookie, STATE_COOKIE);
    const done = (outcome) => {
      reply.header("set-cookie", clearCookie);
      return reply.redirect(`/settings?drive=${outcome}`, 302);
    };
    if (error) return done("denied");
    if (typeof code !== "string" || !code) return done("error");
    const entry = typeof state === "string" ? consumeState(state, cookieState) : null;
    if (!entry) return done("error");
    try {
      await driveAuth.exchangeCode(code, { targetAccountId: entry.targetAccountId });
    } catch (err) {
      // Log only message/code: a gaxios error's `config` carries the auth code
      // and client_secret, so never log the error object itself.
      req.log.warn({ message: err?.message, code: err?.code }, "drive code exchange failed");
      return done("error");
    }
    return done("connected");
  });

  // Back-compat: the pre-multi-account UI has one "Disconnect" button.
  app.post("/api/drive/disconnect", async () => {
    for (const { id } of driveAuth.listAccounts()) driveAuth.disconnect(id);
    return { disconnected: true };
  });

  app.post("/api/drive/accounts/:id/disconnect", async (req, reply) => {
    const { id } = req.params;
    if (!hasAccount(id)) return reply.code(404).send({ error: "Drive account not found" });
    driveAuth.disconnect(id);
    return { disconnected: true };
  });

  app.patch("/api/drive/accounts/:id", async (req, reply) => {
    const { id } = req.params;
    const label = parseLabel(req.body);
    if (label === null) {
      return reply
        .code(400)
        .send({ error: `label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters` });
    }
    if (!hasAccount(id)) return reply.code(404).send({ error: "Drive account not found" });
    driveAuth.renameAccount(id, label);
    return { id, label };
  });
}
