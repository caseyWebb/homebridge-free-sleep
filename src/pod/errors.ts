/**
 * The client's error taxonomy (design.md, "Client: concurrency, dedupe, retry" ->
 * "Error taxonomy"). Every failure `PodClient` can raise extends `PodError`, so a caller can
 * `catch (e) { if (e instanceof PodError) … }` and, if it needs to, branch further on the
 * concrete subclass without inspecting message strings.
 *
 * No imports — this module is the dependency-graph leaf alongside `types.ts`
 * (design.md, "Module dependency direction").
 */

export abstract class PodError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Connection refused, reset, or DNS failure — never reached the Pod. Retryable. */
export class PodNetworkError extends PodError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Our own per-attempt `AbortSignal.timeout` fired. Retryable. */
export class PodTimeoutError extends PodError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * HTTP 400 — the Pod's strict schema rejected the payload. Never retryable.
 *
 * Fields are assigned in the constructor body rather than declared as TypeScript parameter
 * properties (`constructor(..., readonly status: number)`): parameter properties need real
 * transformation, not just type erasure, so they would break `node
 * --experimental-strip-types scripts/smoke.ts`, which imports this module via
 * `client.ts` (design.md, "Smoke script").
 */
export class PodBadRequestError extends PodError {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Any other non-2xx HTTP status. Retryable only for 5xx. */
export class PodHttpError extends PodError {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** The response body did not parse against the vendored read schema. Not retryable. */
export class PodResponseError extends PodError {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.path = path;
  }
}

/** Our own pre-flight validation rejected the payload before any request was sent. */
export class PodRequestError extends PodError {
  constructor(message: string) {
    super(message);
  }
}

/** The caller's own `AbortSignal` aborted the request. Never retryable. */
export class PodAbortError extends PodError {
  constructor(message: string) {
    super(message);
  }
}
