import { google } from "googleapis";
import { decryptSecret, encryptSecret } from "./secrets/crypto.mjs";

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const TOKEN_KEY = "drive_token";

const defaultOauthFactory = (id, secret, redirect) =>
  new google.auth.OAuth2(id, secret, redirect);

// In-app Google Drive auth. The OAuth token is stored encrypted (AES-GCM, key
// from APP_SECRET_KEY) in the secrets table; the store only sees opaque blobs.
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

  async function exchangeCode(code) {
    const { tokens } = await client().getToken(code);
    if (!tokens || typeof tokens !== "object") {
      throw new Error("Google returned no token");
    }
    store.setSecret(TOKEN_KEY, encryptSecret(JSON.stringify(tokens), key));
  }

  // Never throws: null when there is no key, no token, or it won't decrypt.
  function getToken() {
    if (!key) return null;
    const blob = store.getSecret(TOKEN_KEY);
    if (blob == null) return null;
    try {
      return JSON.parse(decryptSecret(blob, key));
    } catch {
      return null;
    }
  }

  function status() {
    if (!isConfigured()) {
      return { configured: false, connected: false, reason: "not-configured" };
    }
    if (getToken() !== null) {
      return { configured: true, connected: true, reason: "ok" };
    }
    if (store.getSecret(TOKEN_KEY) != null) {
      return { configured: true, connected: false, reason: "needs-reconnect" };
    }
    return { configured: true, connected: false, reason: "ok" };
  }

  function disconnect() {
    store.deleteSecret(TOKEN_KEY);
  }

  function loadAuthConfig() {
    if (!isConfigured()) return null;
    const token = getToken();
    return token ? { clientId, clientSecret, token } : null;
  }

  return { isConfigured, authUrl, exchangeCode, getToken, status, disconnect, loadAuthConfig };
}
