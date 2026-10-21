import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { decryptSecret, encryptSecret } from "./secrets/crypto.mjs";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
];
// Legacy single-account secret, migrated into drive_accounts on first use.
const LEGACY_TOKEN_KEY = "drive_token";
const LEGACY_LABEL = "Drive account";

const defaultOauthFactory = (id, secret, redirect) =>
  new google.auth.OAuth2(id, secret, redirect);

// Decodes the claims from a Google id_token (a JWT) without verifying the
// signature; we only read it to key the account. Never throws: returns {} on
// any malformed input.
function decodeIdToken(idToken) {
  try {
    const payload = String(idToken).split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

// In-app Google Drive auth, one row per connected account. Each account's
// OAuth token is stored encrypted (AES-GCM, key from APP_SECRET_KEY) in the
// drive_accounts table; the store only ever sees opaque blobs.
export function createDriveAuth({
  store,
  key,
  clientId,
  clientSecret,
  redirectUri,
  oauthFactory = defaultOauthFactory,
}) {
  const isConfigured = () => Boolean(clientId && clientSecret && key);
  const client = () => oauthFactory(clientId, clientSecret, redirectUri);

  function authUrl(state) {
    return client().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
    });
  }

  // Moves a legacy single-account token into drive_accounts, reusing the
  // encrypted blob as-is (no decrypt). Idempotent: only seeds when the legacy
  // secret exists and no accounts exist yet; then drops the legacy secret.
  function ensureMigratedLegacyAccount() {
    const legacy = store.getSecret(LEGACY_TOKEN_KEY);
    if (legacy == null) return;
    if (store.listDriveAccounts().length > 0) return;
    store.upsertDriveAccount({
      id: randomUUID(),
      sub: null,
      label: LEGACY_LABEL,
      email: null,
      token: legacy,
    });
    store.deleteSecret(LEGACY_TOKEN_KEY);
  }

  // Exchanges an auth code, reads sub/email from the returned id_token, then
  // either refreshes a card-scoped target row, refreshes the row owning that
  // sub (preserving its label), or inserts a new row keyed by sub. Returns the
  // account id.
  async function exchangeCode(code, { targetAccountId } = {}) {
    const { tokens } = await client().getToken(code);
    if (!tokens || typeof tokens !== "object") {
      throw new Error("Google returned no token");
    }
    const { sub = null, email = null } = decodeIdToken(tokens.id_token);
    const token = encryptSecret(JSON.stringify(tokens), key);

    if (targetAccountId) {
      store.updateDriveAccountToken(targetAccountId, { token, sub, email });
      return targetAccountId;
    }

    const existing = sub != null ? store.getDriveAccountBySub(sub) : null;
    if (existing) {
      store.updateDriveAccountToken(existing.id, { token, sub, email });
      return existing.id;
    }

    store.upsertDriveAccount({ id: sub, sub, label: email, email, token });
    return sub;
  }

  // Never throws: null when there is no key, no such account, no token, or it
  // won't decrypt.
  function getToken(accountId) {
    if (!key || accountId == null) return null;
    const row = store.getDriveAccount(accountId);
    if (!row || row.token == null) return null;
    try {
      return JSON.parse(decryptSecret(row.token, key));
    } catch {
      return null;
    }
  }

  function loadAuthConfig(accountId) {
    if (!isConfigured()) return null;
    const token = getToken(accountId);
    return token ? { clientId, clientSecret, token } : null;
  }

  function listAccounts() {
    ensureMigratedLegacyAccount();
    return store.listDriveAccounts().map((row) => ({
      id: row.id,
      label: row.label,
      email: row.email,
      connected: getToken(row.id) !== null,
    }));
  }

  function disconnect(accountId) {
    store.deleteDriveAccount(accountId);
  }

  function renameAccount(accountId, label) {
    store.renameDriveAccount(accountId, label);
  }

  // Account-independent overall status, kept for the legacy status route.
  function status() {
    if (!isConfigured()) {
      return { configured: false, connected: false, reason: "not-configured" };
    }
    const accounts = listAccounts();
    if (accounts.some((a) => a.connected)) {
      return { configured: true, connected: true, reason: "ok" };
    }
    if (accounts.length > 0) {
      return { configured: true, connected: false, reason: "needs-reconnect" };
    }
    return { configured: true, connected: false, reason: "ok" };
  }

  return {
    isConfigured,
    authUrl,
    exchangeCode,
    getToken,
    loadAuthConfig,
    listAccounts,
    disconnect,
    renameAccount,
    status,
    ensureMigratedLegacyAccount,
  };
}
