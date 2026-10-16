export type ApiErrorKind =
  | "network" // fetch() itself threw (offline / CORS / DNS)
  | "timeout" // request exceeded the client timeout
  | "http" // non-2xx response (status is set)
  | "parse" // body was not valid JSON
  | "shape"; // JSON did not match the schema

export class ApiError extends Error {
  public readonly kind: ApiErrorKind;
  public readonly status?: number;

  constructor(
    message: string,
    options: { kind: ApiErrorKind; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.kind = options.kind;
    this.status = options.status;
  }
}
