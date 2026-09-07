/**
 * `PodClient` — typed, resilient access to a free-sleep Pod's unauthenticated LAN HTTP API.
 *
 * Dumb transport with a resilience policy, nothing more (design.md, "Goals"): an ~8s
 * per-attempt timeout, a concurrency limit of 1 per endpoint with in-flight GET
 * deduplication, one retry with backoff on network errors and 5xx (never on 4xx), and a
 * typed error taxonomy. No polling, no caching beyond in-flight dedup, no write queue, no
 * away-mode guard, no authentication — see proposal.md's "Non-goals".
 *
 * Depends on `./types.ts` and `./errors.ts` only (design.md, "Module dependency direction").
 *
 * Relative imports here use `.ts` extensions rather than the usual NodeNext `.js`
 * convention, because `scripts/smoke.ts` imports this module and runs directly under
 * `node --experimental-strip-types` (no build step) — Node's loader resolves import
 * specifiers literally and does not fall back from `.js` to a sibling `.ts` file. `tsconfig.json`
 * sets `rewriteRelativeImportExtensions: true` so `npm run build` still emits the correct
 * `.js` specifiers in `dist/`.
 */

import { ZodError } from 'zod';

import {
  AlarmRequestSchema,
  DeviceStatusPatchSchema,
  DeviceStatusSchema,
  PresenceSchema,
  SchedulesSchema,
  ServerStatusSchema,
  ServicesSchema,
  SettingsPatchSchema,
  SettingsSchema,
  VitalsResponseSchema,
  type AlarmRequest,
  type DeviceStatus,
  type DeviceStatusPatch,
  type PresenceData,
  type Schedules,
  type ServerStatus,
  type Services,
  type Settings,
  type SettingsPatch,
  type Side,
  type VitalsResponse,
} from './types.ts';
import {
  PodAbortError,
  PodBadRequestError,
  PodHttpError,
  PodNetworkError,
  PodRequestError,
  PodResponseError,
  PodTimeoutError,
} from './errors.ts';

export interface PodClientOptions {
  host: string;
  /** Defaults to 3000 — free-sleep's server port. */
  port?: number;
  /** Per-attempt abort timeout in milliseconds. Defaults to 8000 (design.md, "Timeout"). */
  timeoutMs?: number;
}

interface ReadSchema<T> {
  parse(input: unknown): T;
}

interface Attempt {
  status: number;
  text: string;
}

/** Exported so callers outside this module (e.g. `platform.ts`'s startup-budget timeout) can
 * derive their own worst-case bounds from the client's actual constants rather than guessing
 * or hardcoding a duplicate magic number. */
export const DEFAULT_TIMEOUT_MS = 8000;
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_JITTER_MS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJsonParse(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatZodIssues(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Design.md, "Pre-flight rejection of `isOn` + `secondsRemaining` in one patch" (tech-lead
 * resolution 1, design.md "Resolutions"): `updateSide` applies `isOn` first and
 * `secondsRemaining` last as separate serialised hardware commands, so the explicit duration
 * silently wins. Reject locally rather than let a caller's likely-unintended combination
 * silently pick a winner.
 */
function assertNoConflictingDuration(patch: DeviceStatusPatch): void {
  for (const side of ['left', 'right'] as const) {
    const sidePatch = patch[side];
    if (sidePatch && sidePatch.isOn !== undefined && sidePatch.secondsRemaining !== undefined) {
      throw new PodRequestError(
        `device-status patch sets both isOn and secondsRemaining for the ${side} side; the ` +
          'Pod applies isOn first and secondsRemaining last, so the explicit duration silently ' +
          'wins. Send them as two separate requests, or drop one of the two fields.',
      );
    }
  }
}

export class PodClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  /**
   * One promise chain per `${method} ${pathname-without-its-query-string}` — depth-1
   * serialisation (design.md). Deliberately keyed on the path alone, not the full URL: unlike
   * `inFlightGets` below (where two different queries — e.g. `getVitals`'s rolling
   * `startTime`/`endTime` window — really are two different in-flight requests worth deduping
   * separately), this map exists only to force *one at a time* per endpoint, and every distinct
   * query string used to mint its own permanent entry that nothing ever removed (B1 in the
   * occupancy code review): a vitals poll's ever-advancing window leaked one `Promise` per poll,
   * forever, for the process's lifetime.
   */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** In-flight GET promises, keyed the same way — dedup layer, GET only, never writes. */
  private readonly inFlightGets = new Map<string, Promise<unknown>>();

  constructor(options: PodClientOptions) {
    this.host = options.host;
    this.port = options.port ?? 3000;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = `http://${this.host}:${this.port}`;
  }

  async getDeviceStatus(signal?: AbortSignal): Promise<DeviceStatus> {
    return this.getJson('/api/deviceStatus', DeviceStatusSchema, signal);
  }

  async getSettings(signal?: AbortSignal): Promise<Settings> {
    return this.getJson('/api/settings', SettingsSchema, signal);
  }

  async getSchedules(signal?: AbortSignal): Promise<Schedules> {
    return this.getJson('/api/schedules', SchedulesSchema, signal);
  }

  async getServices(signal?: AbortSignal): Promise<Services> {
    return this.getJson('/api/services', ServicesSchema, signal);
  }

  /**
   * `GET /api/serverStatus`. Not free — a real SQLite round-trip on every call upstream
   * (`hub-accessory` design.md's Context) — callers poll this on the slow cadence only, never
   * per-characteristic.
   */
  async getServerStatus(signal?: AbortSignal): Promise<ServerStatus> {
    return this.getJson('/api/serverStatus', ServerStatusSchema, signal);
  }

  /**
   * `GET /api/metrics/presence` (occupancy change, #19). Read-only — no `postPresence` exists;
   * the biometrics stream is upstream's only writer of this endpoint (proposal.md's Non-Goals).
   */
  async getPresence(signal?: AbortSignal): Promise<PresenceData> {
    return this.getJson('/api/metrics/presence', PresenceSchema, signal);
  }

  /**
   * `GET /api/metrics/vitals`, with `side`/`startTime`/`endTime` sent as query params only when
   * given (occupancy change, #19; pod-client spec, "Vitals reads accept optional filters"). No
   * `side` filter omits the parameter entirely rather than sending it empty — mirrors upstream's
   * own optional-query-param shape (`server/src/routes/metrics/vitals.ts`).
   */
  async getVitals(
    query?: { side?: Side; startTime?: string; endTime?: string },
    signal?: AbortSignal,
  ): Promise<VitalsResponse> {
    const params = new URLSearchParams();
    if (query?.side !== undefined) params.set('side', query.side);
    if (query?.startTime !== undefined) params.set('startTime', query.startTime);
    if (query?.endTime !== undefined) params.set('endTime', query.endTime);
    const qs = params.toString();
    return this.getJson(`/api/metrics/vitals${qs.length > 0 ? `?${qs}` : ''}`, VitalsResponseSchema, signal);
  }

  /**
   * `POST /api/deviceStatus`. Cheap — a device command, not a LowDB write (proposal.md's
   * endpoint table). Pre-flight-validated against the strict request schema; never sends a
   * request for a payload the Pod would reject anyway.
   */
  async postDeviceStatus(patch: DeviceStatusPatch, signal?: AbortSignal): Promise<void> {
    const result = DeviceStatusPatchSchema.safeParse(patch);
    if (!result.success) {
      throw new PodRequestError(`Invalid device-status patch: ${formatZodIssues(result.error)}`);
    }
    assertNoConflictingDuration(result.data);
    await this.request('POST', '/api/deviceStatus', result.data, signal);
  }

  /**
   * `POST /api/settings`. **Expensive** — writes `settingsDB.json`, which rebuilds every
   * scheduled job on the Pod (proposal.md's endpoint table). Implemented and mock-tested per
   * design.md's tech-lead resolution 2; no caller in this change.
   *
   * Returns `void`, not the merged document: the response body is in fact the same read
   * contract as `GET /api/settings` (`res.json(settingsDB.data)`, `id` and all —
   * `server/src/routes/settings/settings.ts`), but nothing in this change reads it, so there
   * is no caller to hand a parsed `Settings` to.
   */
  async postSettings(patch: SettingsPatch, signal?: AbortSignal): Promise<void> {
    const result = SettingsPatchSchema.safeParse(patch);
    if (!result.success) {
      throw new PodRequestError(`Invalid settings patch: ${formatZodIssues(result.error)}`);
    }
    await this.request('POST', '/api/settings', result.data, signal);
  }

  /**
   * `POST /api/alarm`. Fire-and-forget, non-idempotent at the hardware layer (`hub-accessory`
   * design.md's Decision 6 and Context: `executeAlarm` silently returns before its own promise
   * settles, so a retried POST landing while the first is still in progress risks a double-fire).
   * Unlike every other write this client exposes, a failed attempt is **never retried** — this
   * calls `singleAttempt` directly, still through the same per-endpoint `enqueue` serialization
   * every other endpoint gets, rather than `requestWithRetry`.
   */
  async postAlarm(request: AlarmRequest, signal?: AbortSignal): Promise<void> {
    const result = AlarmRequestSchema.safeParse(request);
    if (!result.success) {
      throw new PodRequestError(`Invalid alarm request: ${formatZodIssues(result.error)}`);
    }
    await this.request('POST', '/api/alarm', result.data, signal, { retry: false });
  }

  // -----------------------------------------------------------------------------------
  // GET dedup + per-endpoint serialisation + JSON parsing
  // -----------------------------------------------------------------------------------

  private async getJson<T>(pathname: string, schema: ReadSchema<T>, signal?: AbortSignal): Promise<T> {
    const key = `GET ${pathname}`;
    let shared = this.inFlightGets.get(key) as Promise<T> | undefined;
    if (!shared) {
      // The physical request runs under its own internal signal — never a specific caller's
      // — so it is never coupled to any one awaiter. Each caller races its *own* signal
      // against this shared promise below instead (S1 in the pod-client code review): caller
      // A aborting must reject only caller A, never a caller B deduped onto the same
      // in-flight GET.
      shared = this.request('GET', pathname, undefined, undefined).then((text) =>
        this.parseJson(text, schema, pathname),
      );
      this.inFlightGets.set(key, shared);
      shared
        .finally(() => {
          if (this.inFlightGets.get(key) === shared) {
            this.inFlightGets.delete(key);
          }
        })
        .catch(() => {
          // Already surfaced to every awaiter of `shared` itself (via raceAgainstAbort below);
          // this branch exists only so the cleanup chain above doesn't produce an unhandled
          // rejection.
        });
    }
    const value = await this.raceAgainstAbort(shared, signal, `GET ${pathname}`);
    // Never hand out the same object to two callers — one caller's mutation must not be
    // observable by another (design.md, "Dedupe").
    return structuredClone(value);
  }

  /**
   * Races a shared (possibly deduped) promise against one caller's own `AbortSignal`. That
   * caller's abort — including one that has already fired before this call is even made —
   * rejects only its own await with `PodAbortError`, leaving the shared promise, and every
   * other awaiter of it, untouched (S1 in the pod-client code review).
   */
  private raceAgainstAbort<T>(shared: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
    if (!signal) return shared;
    if (signal.aborted) {
      return Promise.reject(new PodAbortError(`${label} aborted by caller`));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new PodAbortError(`${label} aborted by caller`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private parseJson<T>(text: string, schema: ReadSchema<T>, pathname: string): T {
    let data: unknown;
    try {
      data = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new PodResponseError(`response body for ${pathname} was not valid JSON`, pathname);
    }
    try {
      return schema.parse(data);
    } catch (error) {
      if (error instanceof ZodError) {
        const firstIssue = error.issues[0];
        const path = firstIssue ? firstIssue.path.map(String).join('.') : pathname;
        throw new PodResponseError(
          `response for ${pathname} did not match the expected shape (${path}): ${formatZodIssues(error)}`,
          path,
        );
      }
      throw error;
    }
  }

  // -----------------------------------------------------------------------------------
  // Transport: endpoint serialisation, timeout, retry, status interpretation
  // -----------------------------------------------------------------------------------

  /** At most one in-flight physical request per `${method} ${path-without-query}` (design.md). */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.chains.get(key) ?? Promise.resolve();
    const run = previousTail.then(fn, fn);
    this.chains.set(key, run);
    return run;
  }

  private async request(
    method: string,
    pathname: string,
    body: unknown,
    signal?: AbortSignal,
    options?: { retry?: boolean },
  ): Promise<string> {
    // Query-stripped: `chains` exists to serialise requests per endpoint, not per distinct
    // query — using the full `pathname` (query included) here made every unique query string
    // (e.g. `getVitals`'s ever-advancing `startTime`/`endTime` window) mint its own `chains`
    // entry that nothing ever deleted (B1 in the occupancy code review). `inFlightGets` in
    // `getJson` above is the one map that correctly keeps the query, since deduping genuinely
    // different requests together would be wrong.
    const key = `${method} ${pathname.split('?', 1)[0]}`;
    const retry = options?.retry ?? true;
    const { status, text } = await this.enqueue(key, () =>
      retry
        ? this.requestWithRetry(method, pathname, body, signal)
        : this.singleAttempt(method, pathname, body, signal),
    );

    if (status === 400) {
      const parsed = safeJsonParse(text);
      const details = isRecord(parsed) && 'details' in parsed ? parsed.details : parsed;
      throw new PodBadRequestError(`Pod rejected ${method} ${pathname} with 400`, status, details);
    }
    if (status < 200 || status >= 300) {
      throw new PodHttpError(`Pod responded ${status} to ${method} ${pathname}`, status, text);
    }
    return text;
  }

  /**
   * At most one retry, after ~500ms plus jitter, only for a network-level error or a 5xx
   * (design.md, "Retry"). A 4xx — 400 in particular — and a caller abort are never retried.
   */
  private async requestWithRetry(
    method: string,
    pathname: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Attempt> {
    const attempt = (): Promise<Attempt> => this.singleAttempt(method, pathname, body, signal);

    let first: Attempt;
    try {
      first = await attempt();
    } catch (error) {
      if (error instanceof PodAbortError) {
        throw error;
      }
      if (error instanceof PodNetworkError || error instanceof PodTimeoutError) {
        await this.backoff(signal);
        return attempt();
      }
      throw error;
    }

    if (first.status >= 500) {
      await this.backoff(signal);
      return attempt();
    }

    return first;
  }

  private async singleAttempt(
    method: string,
    pathname: string,
    body: unknown,
    callerSignal?: AbortSignal,
  ): Promise<Attempt> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    const init: RequestInit = { method, signal };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    // Both the header round-trip AND the body read must be inside this try/catch. A per-
    // attempt `AbortSignal.timeout` can fire after `fetch()` already resolved a `Response` —
    // headers arrived, but the body is still streaming — and `response.text()` rejects with
    // the same kind of abort error a failed `fetch()` does. Reading the body outside this
    // block (B2 in the pod-client code review) let that reject with a raw DOMException
    // instead of `PodTimeoutError`, and skipped the retry a timeout is supposed to get.
    let status: number;
    let text: string;
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, init);
      text = await response.text();
      status = response.status;
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new PodAbortError(`${method} ${pathname} aborted by caller`);
      }
      if (timeoutSignal.aborted) {
        throw new PodTimeoutError(`${method} ${pathname} timed out after ~${this.timeoutMs}ms`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new PodNetworkError(`${method} ${pathname}: ${message}`, { cause: error });
    }

    return { status, text };
  }

  /** Abort-aware: a caller abort during the backoff wait rejects immediately with
   * `PodAbortError` instead of sleeping out the full delay before the retry even starts. */
  private backoff(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new PodAbortError('aborted during retry backoff'));
    }
    const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, RETRY_BASE_DELAY_MS + jitter);
      if (!signal) return;
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new PodAbortError('aborted during retry backoff'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
