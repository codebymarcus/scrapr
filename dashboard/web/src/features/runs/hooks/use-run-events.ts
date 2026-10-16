import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { runEventSchema } from "@/lib/schemas";
import { deriveWsBase } from "@/lib/ws-base";
import type { Run, RunEvent } from "@/lib/schemas";
import type { CachedRunDetail } from "../types";
import { runKeys } from "./runs-keys";

const WS_BASE = deriveWsBase({
  VITE_WS_BASE: import.meta.env.VITE_WS_BASE,
  VITE_API_BASE: import.meta.env.VITE_API_BASE,
});

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;

/** The slice of `WebSocket` this hook relies on (a fake in tests). */
export type RunSocket = Pick<
  WebSocket,
  "onopen" | "onmessage" | "onerror" | "onclose" | "close"
>;

export type SocketFactory = (url: string) => RunSocket;

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url);

type UseRunEventsOptions = {
  enabled?: boolean;
  /** Injectable for tests; defaults to the browser `WebSocket`. */
  socketFactory?: SocketFactory;
};

const TERMINAL_STATES = new Set<Run["state"]>(["done", "failed", "stopped"]);

function applyEvent(
  queryClient: QueryClient,
  runId: number,
  event: RunEvent,
): void {
  const detailKey = runKeys.detail(runId);

  switch (event.type) {
    case "progress": {
      queryClient.setQueryData<CachedRunDetail>(detailKey, (detail) =>
        detail
          ? {
              ...detail,
              live: {
                current: event.current,
                total: event.total,
                label: event.label,
              },
            }
          : detail,
      );
      return;
    }
    case "progress-end": {
      queryClient.setQueryData<CachedRunDetail>(detailKey, (detail) => {
        if (!detail?.live) {
          return detail;
        }
        return { run: detail.run, items: detail.items };
      });
      return;
    }
    case "item": {
      const detail = queryClient.getQueryData<CachedRunDetail>(detailKey);
      if (!detail?.items.some((item) => item.id === event.id)) {
        // Unknown item (or nothing cached): let the server be the source.
        void queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }
      queryClient.setQueryData<CachedRunDetail>(detailKey, {
        ...detail,
        items: detail.items.map((item) =>
          item.id === event.id
            ? {
                ...item,
                saved: event.saved ?? item.saved,
                total: event.total ?? item.total,
                needs_review: event.needsReview ?? item.needs_review,
              }
            : item,
        ),
      });
      return;
    }
    case "state": {
      queryClient.setQueryData<CachedRunDetail>(detailKey, (detail) =>
        detail
          ? { ...detail, run: { ...detail.run, state: event.state } }
          : detail,
      );
      queryClient.setQueryData<Run[]>(runKeys.lists(), (runs) =>
        runs?.map((run) =>
          run.id === runId ? { ...run, state: event.state } : run,
        ),
      );
      if (TERMINAL_STATES.has(event.state)) {
        void queryClient.invalidateQueries({ queryKey: runKeys.lists() });
      }
      return;
    }
    case "log":
      return;
  }
}

function parseEvent(data: unknown): RunEvent | null {
  if (typeof data !== "string") {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const result = runEventSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Streams a run's events into the React Query cache. Reconnects with capped
 * exponential backoff. `connected` is false whenever the socket is down, so
 * callers can poll (`refetchInterval`) as a fallback.
 */
export function useRunEvents(
  runId: number,
  { enabled = true, socketFactory = defaultSocketFactory }: UseRunEventsOptions = {},
): { connected: boolean } {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const factoryRef = useRef(socketFactory);

  useEffect(() => {
    factoryRef.current = socketFactory;
  }, [socketFactory]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const url = `${WS_BASE}/api/ws?runId=${encodeURIComponent(String(runId))}`;
    let disposed = false;
    let socket: RunSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function scheduleReconnect() {
      if (disposed || timer !== null) {
        return;
      }
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    }

    function connect() {
      let ws: RunSocket;
      try {
        ws = factoryRef.current(url);
      } catch {
        setConnected(false);
        scheduleReconnect();
        return;
      }
      socket = ws;

      ws.onopen = () => {
        if (socket !== ws) {
          return;
        }
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (message) => {
        if (socket !== ws) {
          return;
        }
        const event = parseEvent(message.data);
        if (event) {
          applyEvent(queryClient, runId, event);
        }
      };
      // An error and its following close collapse into one reconnect: the
      // first handler detaches this socket, so the second is ignored.
      const lost = () => {
        if (socket !== ws) {
          return;
        }
        socket = null;
        setConnected(false);
        try {
          ws.close();
        } catch {
          // already closed
        }
        scheduleReconnect();
      };
      ws.onerror = lost;
      ws.onclose = lost;
    }

    connect();

    return () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      const current = socket;
      socket = null;
      if (current) {
        current.close();
      }
      setConnected(false);
    };
  }, [enabled, runId, queryClient]);

  return { connected: enabled && connected };
}
