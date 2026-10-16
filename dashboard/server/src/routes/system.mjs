import { existsSync } from "node:fs";
import { DRIVE_CREDENTIALS_PATH, DRIVE_TOKEN_PATH } from "../config.mjs";

export function defaultDriveStatus() {
  return {
    connected: existsSync(DRIVE_CREDENTIALS_PATH) && existsSync(DRIVE_TOKEN_PATH),
    credentialsPath: DRIVE_CREDENTIALS_PATH,
    tokenPath: DRIVE_TOKEN_PATH,
  };
}

export async function systemRoutes(app, { driveStatus = defaultDriveStatus } = {}) {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/drive/status", async () => {
    const { connected, credentialsPath, tokenPath } = await driveStatus();
    return {
      connected: Boolean(connected),
      credentialsPath,
      tokenPath,
      hint: connected
        ? "Google Drive is connected."
        : "Drive is not connected. Run `node authorize.mjs` from the repo root to authorize.",
    };
  });
}
