import type { ZodType } from "zod";
import { ApiError } from "./api-error";

type Params = Record<string, string | number | boolean>;

export type ApiClient = {
  get<T>(
    path: string,
    options: { schema: ZodType<T>; signal?: AbortSignal; params?: Params },
  ): Promise<T>;
  post<T>(
    path: string,
    options: { body?: unknown; schema: ZodType<T>; signal?: AbortSignal },
  ): Promise<T>;
  post(
    path: string,
    options: { body?: unknown; schema?: undefined; signal?: AbortSignal },
  ): Promise<void>;
  del(path: string, options?: { signal?: AbortSignal }): Promise<void>;
};

type RequestOptions = {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  schema?: ZodType<unknown>;
  signal?: AbortSignal;
  params?: Params;
};

export function createApiClient(config: {
  baseUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): ApiClient {
  const { baseUrl, timeoutMs = 10_000 } = config;
  const fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);

  async function request(
    path: string,
    { method, body, schema, signal, params }: RequestOptions,
  ): Promise<unknown> {
    const query = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params).map(([key, value]) => [key, String(value)]),
        ).toString()
      : "";
    const url = `${baseUrl}${path}${query}`;

    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const init: RequestInit = { method, signal: requestSignal };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      if (signal?.aborted) {
        throw error; // caller cancellation — keep it a cancellation
      }
      if (timeout.aborted) {
        throw new ApiError("The request took too long to respond.", {
          kind: "timeout",
          cause: error,
        });
      }
      throw new ApiError("Couldn't reach the dashboard server.", {
        kind: "network",
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ApiError(`Request failed (HTTP ${response.status}).`, {
        kind: "http",
        status: response.status,
      });
    }

    if (!schema) {
      return undefined;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new ApiError("The server returned an invalid response.", {
        kind: "parse",
        cause: error,
      });
    }

    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ApiError("The server returned data in an unexpected format.", {
        kind: "shape",
        cause: result.error,
      });
    }

    return result.data;
  }

  async function get<T>(
    path: string,
    options: { schema: ZodType<T>; signal?: AbortSignal; params?: Params },
  ): Promise<T> {
    return (await request(path, { method: "GET", ...options })) as T;
  }

  async function post<T>(
    path: string,
    options: { body?: unknown; schema: ZodType<T>; signal?: AbortSignal },
  ): Promise<T>;
  async function post(
    path: string,
    options: { body?: unknown; schema?: undefined; signal?: AbortSignal },
  ): Promise<void>;
  async function post(
    path: string,
    options: {
      body?: unknown;
      schema?: ZodType<unknown>;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    return request(path, { method: "POST", ...options });
  }

  async function del(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await request(path, { method: "DELETE", signal: options?.signal });
  }

  return { get, post, del };
}
