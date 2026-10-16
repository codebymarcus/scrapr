import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@/lib/schemas";
import { makeItem, makeRun } from "../test/fixtures";
import type { CachedRunDetail } from "../types";
import { runKeys } from "./runs-keys";
import { useRunEvents } from "./use-run-events";
import type { RunSocket } from "./use-run-events";

class FakeSocket {
  onopen: RunSocket["onopen"] = null;
  onmessage: RunSocket["onmessage"] = null;
  onerror: RunSocket["onerror"] = null;
  onclose: RunSocket["onclose"] = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }

  emit(event: RunEvent) {
    this.send(JSON.stringify(event));
  }

  send(data: string) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      { data } as MessageEvent,
    );
  }

  drop() {
    this.onclose?.call(this as unknown as WebSocket, new Event("close") as CloseEvent);
  }

  fail() {
    this.onerror?.call(this as unknown as WebSocket, new Event("error"));
  }
}

function setup(options: { enabled?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const socketFactory = vi.fn((url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as RunSocket;
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(
    (props: { enabled?: boolean }) =>
      useRunEvents(1, { enabled: props.enabled ?? true, socketFactory }),
    { wrapper, initialProps: { enabled: options.enabled } },
  );
  return { sockets, socketFactory, queryClient, ...hook };
}

const run = makeRun({ id: 1, state: "running" });
const seededDetail: CachedRunDetail = {
  run,
  items: [
    makeItem({ id: 10, run_id: 1 }),
    makeItem({ id: 11, run_id: 1 }),
  ],
};

describe("useRunEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a socket for the run and reports connected once open", () => {
    const { sockets, result } = setup();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://localhost:5174/api/ws?runId=1");
    expect(result.current.connected).toBe(false);

    act(() => sockets[0].open());
    expect(result.current.connected).toBe(true);
  });

  it("does not open a socket when disabled", () => {
    const { socketFactory } = setup({ enabled: false });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("applies a progress event to the cached run detail", () => {
    const { sockets, queryClient } = setup();
    queryClient.setQueryData(runKeys.detail(1), seededDetail);
    act(() => sockets[0].open());

    act(() =>
      sockets[0].emit({ type: "progress", current: 3, total: 12, label: "img" }),
    );

    const cached = queryClient.getQueryData<CachedRunDetail>(runKeys.detail(1));
    expect(cached?.live).toEqual({ current: 3, total: 12, label: "img" });

    act(() => sockets[0].emit({ type: "progress-end" }));
    expect(
      queryClient.getQueryData<CachedRunDetail>(runKeys.detail(1))?.live,
    ).toBeUndefined();
  });

  it("patches a cached item from an item event", () => {
    const { sockets, queryClient } = setup();
    queryClient.setQueryData(runKeys.detail(1), seededDetail);

    act(() =>
      sockets[0].emit({ type: "item", id: 10, saved: 4, total: 4, ok: true }),
    );

    const cached = queryClient.getQueryData<CachedRunDetail>(runKeys.detail(1));
    expect(cached?.items.find((item) => item.id === 10)).toMatchObject({
      saved: 4,
      total: 4,
    });
    expect(cached?.items.find((item) => item.id === 11)?.saved).toBeNull();
  });

  it("refetches the detail when an item event names an unknown item", () => {
    const { sockets, queryClient } = setup();
    queryClient.setQueryData(runKeys.detail(1), seededDetail);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    act(() => sockets[0].emit({ type: "item", id: 99, saved: 1, total: 1 }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.detail(1) });
  });

  it("applies a state event to the detail and list caches", () => {
    const { sockets, queryClient } = setup();
    queryClient.setQueryData(runKeys.detail(1), seededDetail);
    queryClient.setQueryData(runKeys.lists(), [run, makeRun({ id: 2 })]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    act(() => sockets[0].emit({ type: "state", state: "stopped" }));

    expect(
      queryClient.getQueryData<CachedRunDetail>(runKeys.detail(1))?.run.state,
    ).toBe("stopped");
    expect(
      queryClient.getQueryData<{ id: number; state: string }[]>(
        runKeys.lists(),
      )?.map((r) => r.state),
    ).toEqual(["stopped", "queued"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.lists() });
  });

  it("does not invalidate lists for a non-terminal state event", () => {
    const { sockets, queryClient } = setup();
    queryClient.setQueryData(runKeys.detail(1), seededDetail);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    act(() => sockets[0].emit({ type: "state", state: "running" }));

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("ignores malformed frames", () => {
    const { sockets, queryClient } = setup();
    queryClient.setQueryData(runKeys.detail(1), seededDetail);

    act(() => {
      sockets[0].send("not json");
      sockets[0].send(JSON.stringify({ type: "progress", current: "x" }));
      sockets[0].send(JSON.stringify({ type: "mystery" }));
    });

    expect(queryClient.getQueryData(runKeys.detail(1))).toEqual(seededDetail);
  });

  it("flips connected false on close and reconnects after a backoff", () => {
    const { sockets, socketFactory, result } = setup();
    act(() => sockets[0].open());
    expect(result.current.connected).toBe(true);

    act(() => sockets[0].drop());
    expect(result.current.connected).toBe(false);
    expect(socketFactory).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(socketFactory).toHaveBeenCalledTimes(2);

    act(() => sockets[1].open());
    expect(result.current.connected).toBe(true);
  });

  it("backs off exponentially, capped, and resets after a successful open", () => {
    const { sockets, socketFactory } = setup();

    // Fail repeatedly without ever opening: 500, 1000, 2000, 4000, 8000, 10000...
    const delays = [500, 1000, 2000, 4000, 8000, 10_000, 10_000];
    delays.forEach((delay, index) => {
      act(() => sockets[index].fail());
      act(() => {
        vi.advanceTimersByTime(delay - 1);
      });
      expect(socketFactory).toHaveBeenCalledTimes(index + 1);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(socketFactory).toHaveBeenCalledTimes(index + 2);
    });

    const last = sockets.length - 1;
    act(() => sockets[last].open());
    act(() => sockets[last].drop());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(socketFactory).toHaveBeenCalledTimes(sockets.length);
  });

  it("treats an error followed by a close as a single reconnect", () => {
    const { sockets, socketFactory } = setup();
    act(() => {
      sockets[0].fail();
      sockets[0].drop();
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(socketFactory).toHaveBeenCalledTimes(2);
  });

  it("closes the socket and stops reconnecting on unmount", () => {
    const { sockets, socketFactory, unmount } = setup();
    act(() => sockets[0].drop());
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(socketFactory).toHaveBeenCalledTimes(1);

    const second = setup();
    act(() => second.sockets[0].open());
    second.unmount();
    expect(second.sockets[0].closed).toBe(true);
  });

  it("closes the socket when disabled and reports disconnected", () => {
    const { sockets, result, rerender } = setup();
    act(() => sockets[0].open());

    rerender({ enabled: false });

    expect(sockets[0].closed).toBe(true);
    expect(result.current.connected).toBe(false);
  });
});
