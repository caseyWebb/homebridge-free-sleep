/**
 * `PodPoller` — decides when the plugin talks to the Pod at all (pod-poller spec).
 *
 * One self-rescheduling poll per endpoint class (`deviceStatus`, `settings`, `schedules`,
 * `services`, and — occupancy change, #19 — `presence`/`vitals`), never two in flight for a
 * class at once, ±10% jitter, exponential backoff to a
 * configurable cap with snap-back on the first success, a deadline-bounded bootstrap, and a
 * stacking poll-mode API (`requestMode`) that expresses fast-poll-after-write and
 * fast-poll-while-priming today with no new mechanism needed for the alarm window later
 * (design.md, "Poll modes are a stack…").
 *
 * Imports `client.ts`, `snapshot.ts`, `errors.ts` and `types.ts` only — never `writeQueue.ts`
 * (design.md, "Module dependency direction": that would-be cycle is why the write queue takes
 * a `requestFastPoll` callback instead of importing this module).
 */

import type { PodClient } from './client.ts';
import {
  PodAbortError,
  PodBadRequestError,
  PodHttpError,
  PodNetworkError,
  PodRequestError,
  PodResponseError,
  PodTimeoutError,
} from './errors.ts';
import {
  defaultLogger,
  defaultTimerApi,
  type EffectiveSnapshot,
  type ErrorKind,
  type Logger,
  type SnapshotStore,
  type TimerApi,
  type TimerHandle,
} from './snapshot.ts';
import type { DeviceStatus, PresenceData, Schedules, Services, Settings, VitalsResponse } from './types.ts';

export type EndpointClassId = 'deviceStatus' | 'settings' | 'schedules' | 'services' | 'presence' | 'vitals';

/**
 * The vitals class's query window (occupancy change, #19; design.md's "One combined vitals
 * query per poll, windowed to the 'recent' threshold itself") — issue #8's own "~3 min",
 * roughly 3x the 60s insertion cadence upstream writes at, tolerant of one or two missed
 * insertions. A fixed internal constant, not a config field (proposal.md's Non-Goals).
 */
const VITALS_OCCUPIED_WINDOW_MS = 180_000;

/** The alarm window (#16) needs 3s; config must never be able to request that as a *base*. */
const HARD_FLOOR_MS = 3000;

export interface PollerOptions {
  client: PodClient;
  snapshot: SnapshotStore;
  timers?: TimerApi;
  logger?: Logger;
  /** Base interval for the `deviceStatus` class. Default 30 000, enforced minimum 5 000. */
  pollIntervalMs?: number;
  /** Base interval for `settings`/`schedules`/`services`. Default 300 000, minimum 60 000. */
  slowPollIntervalMs?: number;
  /** Interval used by the priming mode (and, by convention, the write mode callers request). Default 5 000. */
  fastPollIntervalMs?: number;
  /** Backoff cap. Default 60 000. */
  maxBackoffMs?: number;
  /** Bootstrap deadline. Default 10 000. */
  bootstrapTimeoutMs?: number;
  /**
   * Which occupancy source, if any, is configured (occupancy change, #19). Default `'none'` —
   * a plain value, following the same "poller doesn't import config.ts" discipline every
   * existing option already follows (design.md).
   */
  occupancySource?: 'none' | 'presence' | 'vitals';
}

interface EndpointClassSpec<T> {
  id: EndpointClassId;
  baseIntervalMs: number;
  read: (client: PodClient, signal: AbortSignal) => Promise<T>;
  apply: (snapshot: SnapshotStore, value: T) => void;
  recordFailure?: (snapshot: SnapshotStore, kind: ErrorKind) => void;
  /**
   * Extension point named for #19 (design.md, "The poller is a registry of endpoint-class
   * descriptors"): evaluated against the current snapshot before each poll of this class. A
   * class with no `enabled` is always enabled. A disabled class skips the actual request but
   * keeps its schedule running — the next scheduled tick re-evaluates the predicate, so the
   * class polls again on its own as soon as it flips back to enabled, with no external kick
   * needed. The `presence`/`vitals` classes below are its first real consumers, each gated on
   * both the configured `occupancySource` and the last-observed `services.biometrics.enabled`.
   */
  enabled?: (snapshot: EffectiveSnapshot) => boolean;
}

interface ModeEntry {
  intervalMs: number;
  untilMs: number;
  reason: string;
  expiryHandle: TimerHandle | null;
}

interface ClassRuntime {
  spec: EndpointClassSpec<unknown>;
  baseIntervalMs: number;
  consecutiveFailures: number;
  lastPollAt: number;
  scheduledHandle: TimerHandle | null;
  inFlight: boolean;
  abortController: AbortController | null;
  stopped: boolean;
  modes: Map<symbol, ModeEntry>;
  refreshWaiters: Array<() => void>;
}

function classifyError(error: unknown): ErrorKind {
  if (error instanceof PodNetworkError) return 'network';
  if (error instanceof PodTimeoutError) return 'timeout';
  if (error instanceof PodAbortError) return 'abort';
  if (error instanceof PodResponseError) return 'response';
  if (error instanceof PodHttpError) return 'http';
  if (error instanceof PodBadRequestError) return 'badRequest';
  if (error instanceof PodRequestError) return 'request';
  return 'unknown';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

export class PodPoller {
  private readonly client: PodClient;
  private readonly snapshot: SnapshotStore;
  private readonly timers: TimerApi;
  private readonly logger: Logger;

  private readonly pollIntervalMs: number;
  private readonly slowPollIntervalMs: number;
  private readonly fastPollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly bootstrapTimeoutMs: number;
  private readonly occupancySource: 'none' | 'presence' | 'vitals';

  private readonly classes = new Map<EndpointClassId, ClassRuntime>();
  private primingRelease: (() => void) | null = null;
  private bootstrapDeadlineHandle: TimerHandle | null = null;
  private stopped = false;

  constructor(options: PollerOptions) {
    this.client = options.client;
    this.snapshot = options.snapshot;
    this.timers = options.timers ?? defaultTimerApi;
    this.logger = options.logger ?? defaultLogger;

    this.pollIntervalMs = this.clampBase('pollIntervalMs', options.pollIntervalMs ?? 30_000, 5000);
    this.slowPollIntervalMs = this.clampBase('slowPollIntervalMs', options.slowPollIntervalMs ?? 300_000, 60_000);
    this.fastPollIntervalMs = options.fastPollIntervalMs ?? 5000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 10_000;
    this.occupancySource = options.occupancySource ?? 'none';

    this.registerClass({
      id: 'deviceStatus',
      baseIntervalMs: this.pollIntervalMs,
      read: (client, signal) => client.getDeviceStatus(signal),
      apply: (snapshot, value) => snapshot.observeDeviceStatus(value as DeviceStatus),
      recordFailure: (snapshot, kind) => snapshot.recordDeviceStatusFailure(kind),
    });
    this.registerClass({
      id: 'settings',
      baseIntervalMs: this.slowPollIntervalMs,
      read: (client, signal) => client.getSettings(signal),
      apply: (snapshot, value) => snapshot.observeSettings(value as Settings),
    });
    this.registerClass({
      id: 'schedules',
      baseIntervalMs: this.slowPollIntervalMs,
      read: (client, signal) => client.getSchedules(signal),
      apply: (snapshot, value) => snapshot.observeSchedules(value as Schedules),
    });
    this.registerClass({
      id: 'services',
      baseIntervalMs: this.slowPollIntervalMs,
      read: (client, signal) => client.getServices(signal),
      apply: (snapshot, value) => snapshot.observeServices(value as Services),
    });

    // Occupancy change (#19): both registered unconditionally, mirroring the four classes
    // above — the `enabled` predicate decides whether either actually fires (design.md, "The
    // poller is a registry of endpoint-class descriptors"). Neither defines `recordFailure`:
    // matching `settings`/`schedules`/`services`, a failed poll simply leaves the last-known
    // observation in place (pod-snapshot's general "a failure does not erase known state" rule).
    this.registerClass({
      id: 'presence',
      baseIntervalMs: 30_000,
      read: (client, signal) => client.getPresence(signal),
      apply: (snapshot, value) => snapshot.observePresence(value as PresenceData),
      enabled: (snapshot) =>
        this.occupancySource === 'presence' && snapshot.documents.services?.biometrics.enabled === true,
    });
    this.registerClass({
      id: 'vitals',
      baseIntervalMs: 60_000,
      read: (client, signal) => {
        // `new globalThis.Date(...)` rather than the bare `Date` identifier this file's own
        // ESLint rule forbids (no-restricted-globals) — a property access on `globalThis` is
        // the accepted escape hatch (mirrors `defaultTimerApi`'s own `globalThis.Date.now()` in
        // `snapshot.ts`), used here only to format `this.timers.now()`'s already-injected
        // epoch-ms value as ISO 8601, not to read the clock itself.
        const now = this.timers.now();
        return client.getVitals(
          {
            startTime: new globalThis.Date(now - VITALS_OCCUPIED_WINDOW_MS).toISOString(),
            endTime: new globalThis.Date(now).toISOString(),
          },
          signal,
        );
      },
      apply: (snapshot, value) => snapshot.observeVitals(value as VitalsResponse),
      enabled: (snapshot) =>
        this.occupancySource === 'vitals' && snapshot.documents.services?.biometrics.enabled === true,
    });
  }

  private clampBase(name: string, configured: number, min: number): number {
    if (configured < min) {
      this.logger.warn(`${name} configured as ${configured}ms is below the ${min}ms minimum; using ${min}ms.`);
      return min;
    }
    return configured;
  }

  private registerClass<T>(spec: EndpointClassSpec<T>): void {
    this.classes.set(spec.id, {
      spec: spec as EndpointClassSpec<unknown>,
      baseIntervalMs: spec.baseIntervalMs,
      consecutiveFailures: 0,
      lastPollAt: this.timers.now(),
      scheduledHandle: null,
      inFlight: false,
      abortController: null,
      stopped: false,
      modes: new Map(),
      refreshWaiters: [],
    });
  }

  private runtime(classId: EndpointClassId): ClassRuntime {
    const rt = this.classes.get(classId);
    if (!rt) throw new Error(`poller: unknown endpoint class "${classId}"`);
    return rt;
  }

  // -----------------------------------------------------------------------------------
  // Cadence arithmetic (design.md, "Cadence arithmetic, in one place")
  // -----------------------------------------------------------------------------------

  private effectiveIntervalMs(rt: ClassRuntime): number {
    let interval = rt.baseIntervalMs;
    for (const mode of rt.modes.values()) {
      interval = Math.min(interval, mode.intervalMs);
    }
    return Math.max(HARD_FLOOR_MS, interval);
  }

  private delayMs(rt: ClassRuntime): number {
    const effective = this.effectiveIntervalMs(rt);
    const backedOff = clamp(
      effective * Math.pow(2, rt.consecutiveFailures),
      effective,
      Math.max(this.maxBackoffMs, effective),
    );
    const jitter = 1 + (this.timers.random() * 0.2 - 0.1);
    return backedOff * jitter;
  }

  // -----------------------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------------------

  private clearScheduled(rt: ClassRuntime): void {
    if (rt.scheduledHandle !== null) {
      this.timers.clearTimeout(rt.scheduledHandle);
      rt.scheduledHandle = null;
    }
  }

  /**
   * Always recomputed from `lastPollAt`, never from "now" blindly — so a shorter interval
   * becoming effective mid-delay pulls the next poll in rather than waiting the old delay out
   * (pod-poller spec, "A shorter interval applies without waiting out the current delay").
   */
  private scheduleNext(rt: ClassRuntime): void {
    if (rt.stopped || this.stopped) return;
    this.clearScheduled(rt);
    const delay = this.delayMs(rt);
    const elapsed = this.timers.now() - rt.lastPollAt;
    const remaining = Math.max(0, delay - elapsed);
    rt.scheduledHandle = this.timers.setTimeout(() => {
      rt.scheduledHandle = null;
      void this.fire(rt);
    }, remaining);
  }

  // -----------------------------------------------------------------------------------
  // Poll execution
  // -----------------------------------------------------------------------------------

  private fire(rt: ClassRuntime): Promise<void> {
    if (rt.inFlight) {
      return new Promise<void>((resolve) => rt.refreshWaiters.push(resolve));
    }
    return this.runPoll(rt);
  }

  private isEnabled(rt: ClassRuntime): boolean {
    return rt.spec.enabled ? rt.spec.enabled(this.snapshot.get()) : true;
  }

  private async runPoll(rt: ClassRuntime): Promise<void> {
    rt.inFlight = true;

    if (!this.isEnabled(rt)) {
      // Disabled right now: skip the request entirely, but still resolve anyone waiting on this
      // tick and keep the class's own schedule alive so it re-checks — and re-enables itself —
      // on the next tick, with no external kick required.
      const waiters = rt.refreshWaiters;
      rt.refreshWaiters = [];
      rt.inFlight = false;
      rt.lastPollAt = this.timers.now();
      waiters.forEach((resolve) => resolve());
      if (!rt.stopped && !this.stopped) this.scheduleNext(rt);
      return;
    }

    const controller = new AbortController();
    rt.abortController = controller;

    let outcome: { ok: true; value: unknown } | { ok: false; kind: ErrorKind; error: unknown };
    try {
      const value = await rt.spec.read(this.client, controller.signal);
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, kind: classifyError(error), error };
    }

    const waiters = rt.refreshWaiters;
    rt.refreshWaiters = [];
    rt.inFlight = false;
    rt.abortController = null;

    if (rt.stopped || this.stopped) {
      waiters.forEach((resolve) => resolve());
      return;
    }

    if (outcome.ok) {
      rt.spec.apply(this.snapshot, outcome.value);
      rt.consecutiveFailures = 0;
      if (rt.spec.id === 'deviceStatus') this.handlePriming();
    } else {
      rt.consecutiveFailures += 1;
      this.logger.warn(
        `poll of "${rt.spec.id}" failed (attempt ${rt.consecutiveFailures}, ${outcome.kind}): ${describeError(outcome.error)}`,
      );
      rt.spec.recordFailure?.(this.snapshot, outcome.kind);
    }
    rt.lastPollAt = this.timers.now();
    waiters.forEach((resolve) => resolve());
    this.scheduleNext(rt);
  }

  private handlePriming(): void {
    const isPriming = this.snapshot.get().isPriming === true;
    if (isPriming && !this.primingRelease) {
      this.primingRelease = this.requestMode('deviceStatus', {
        intervalMs: this.fastPollIntervalMs,
        untilMs: Infinity,
        reason: 'priming',
      });
    } else if (!isPriming && this.primingRelease) {
      this.primingRelease();
      this.primingRelease = null;
    }
  }

  // -----------------------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------------------

  async bootstrap(): Promise<void> {
    if (this.stopped) return; // never contact the Pod once stopped

    const allClasses = [...this.classes.values()];
    const enabledClasses = allClasses.filter((rt) => this.isEnabled(rt));
    // A class that is disabled right now still needs its recurring schedule kicked off — its
    // own `fire`/`runPoll` re-evaluates `enabled` on every future tick — it just does not get an
    // actual request (or a slot in the deadline race) at bootstrap time.
    for (const rt of allClasses) {
      if (!enabledClasses.includes(rt)) this.scheduleNext(rt);
    }
    const deadline = new Promise<void>((resolve) => {
      this.bootstrapDeadlineHandle = this.timers.setTimeout(resolve, this.bootstrapTimeoutMs);
    });
    const allSettled = Promise.all(enabledClasses.map((rt) => this.fire(rt)));
    await Promise.race([allSettled, deadline]);
    // Whichever side of the race won, the deadline timer itself must not linger — a bootstrap
    // that finished early via `allSettled` would otherwise leave it scheduled for no reason.
    if (this.bootstrapDeadlineHandle !== null) {
      this.timers.clearTimeout(this.bootstrapDeadlineHandle);
      this.bootstrapDeadlineHandle = null;
    }
  }

  requestMode(classId: EndpointClassId, options: { intervalMs: number; untilMs: number; reason: string }): () => void {
    const rt = this.runtime(classId);
    const key = Symbol(options.reason);
    let released = false;

    const release = (): void => {
      if (released) return;
      released = true;
      const entry = rt.modes.get(key);
      rt.modes.delete(key);
      if (entry?.expiryHandle !== null && entry?.expiryHandle !== undefined) {
        this.timers.clearTimeout(entry.expiryHandle);
      }
      this.scheduleNext(rt);
    };

    const expiryHandle =
      Number.isFinite(options.untilMs)
        ? this.timers.setTimeout(release, Math.max(0, options.untilMs - this.timers.now()))
        : null;

    rt.modes.set(key, { intervalMs: options.intervalMs, untilMs: options.untilMs, reason: options.reason, expiryHandle });
    this.scheduleNext(rt);
    return release;
  }

  async refresh(classId: EndpointClassId): Promise<void> {
    const rt = this.runtime(classId);
    if (this.stopped || rt.stopped) return; // never contact the Pod once stopped
    if (rt.inFlight) {
      await new Promise<void>((resolve) => rt.refreshWaiters.push(resolve));
      return;
    }
    this.clearScheduled(rt);
    await this.runPoll(rt);
  }

  stop(): void {
    this.stopped = true;
    if (this.bootstrapDeadlineHandle !== null) {
      this.timers.clearTimeout(this.bootstrapDeadlineHandle);
      this.bootstrapDeadlineHandle = null;
    }
    if (this.primingRelease) {
      this.primingRelease();
      this.primingRelease = null;
    }
    for (const rt of this.classes.values()) {
      rt.stopped = true;
      this.clearScheduled(rt);
      for (const mode of rt.modes.values()) {
        if (mode.expiryHandle !== null) this.timers.clearTimeout(mode.expiryHandle);
      }
      rt.modes.clear();
      rt.abortController?.abort();
    }
  }
}
