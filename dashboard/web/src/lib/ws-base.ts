const DEFAULT_WS_BASE = "ws://localhost:5174";

type WsEnv = { VITE_WS_BASE?: string; VITE_API_BASE?: string };

/**
 * WebSocket base URL: `VITE_WS_BASE`, else `VITE_API_BASE` with its scheme
 * swapped (http→ws, https→wss) so REST and WS stay on the same host, else
 * the local dev server.
 */
export function deriveWsBase(env: WsEnv): string {
  if (env.VITE_WS_BASE) {
    return env.VITE_WS_BASE;
  }
  if (env.VITE_API_BASE) {
    return env.VITE_API_BASE.replace(/^http/i, "ws").replace(/\/+$/, "");
  }
  return DEFAULT_WS_BASE;
}
