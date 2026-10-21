// Shared resolution of a run's chosen Drive account to in-memory OAuth
// credentials. Used by both scrape-time upload (run-manager) and on-demand /
// bulk re-upload (upload-item), so the account a run was created with is honored
// everywhere an upload happens.
//
// Returns the account's auth config ({ clientId, clientSecret, token }) or null.
// Null is never a signal to fall back to a different account or to repo-root
// credential files: callers treat null as "the chosen account is unavailable".
//
//   - overrides.driveAccountId set: resolve exactly that account (null if it is
//     gone or its token will not decrypt). No fallback to any other account.
//   - no driveAccountId: back-compat for pre-existing runs created before the
//     per-run selector existed. Resolve the single connected account when there
//     is exactly one; with zero or multiple connected accounts there is nothing
//     to guess, so return null.
export function resolveRunDriveAuth(driveAuthService, overrides) {
  const load = driveAuthService?.loadAuthConfig;
  if (typeof load !== "function") return null;

  const accountId = overrides?.driveAccountId;
  if (accountId) return load.call(driveAuthService, accountId) ?? null;

  const list = driveAuthService?.listAccounts;
  if (typeof list !== "function") return null;
  let connected;
  try {
    connected = (list.call(driveAuthService) ?? []).filter((a) => a?.connected);
  } catch {
    return null;
  }
  if (connected.length !== 1) return null;
  return load.call(driveAuthService, connected[0].id) ?? null;
}
