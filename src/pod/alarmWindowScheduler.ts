/**
 * `AlarmWindowScheduler` — requests a bounded `deviceStatus` fast-poll window around every
 * upcoming alarm instant, so a 10-180s alarm event is never missed by the platform's ordinary,
 * much slower polling cadence (`pod-alarm-scheduler` spec; issue #16).
 *
 * Structurally a peer of `PodPoller`/`WriteQueue`/`KeepAlive` (design.md, "A new peer module,
 * `AlarmWindowScheduler`, not a `PodPoller` endpoint class or `WriteQueue` logic"): a small,
 * self-rescheduling, timer-owning module that imports `snapshot.ts` for reads, `poller.ts` for
 * its one write-shaped call (`requestMode`), and `alarmSchedule.ts` for the pure derivation —
 * **never `writeQueue.ts`**, since this module issues no write at all. `poller.ts` itself needs
 * zero changes: `requestMode`'s stacking mode API was designed in `poller-and-write-queue`'s
 * design.md specifically so this arrives as a caller of an existing method.
 *
 * `schedules`/`settings` are not watched/diffed fields (`snapshot.ts`'s module doc) — no
 * notification ever fires when either updates. This module therefore polls its own cached-
 * document read on its own timer (design.md, "Recomputation"), never reacting to a `Change`
 * event.
 */

import { alarmScheduleKey, deriveUpcomingAlarms, type UpcomingAlarm } from './alarmSchedule.ts';
import type { PodPoller } from './poller.ts';
import { defaultLogger, defaultTimerApi, type Logger, type SnapshotStore, type TimerApi, type TimerHandle } from './snapshot.ts';

/** Issue #16's own "±3 minutes". */
const DEFAULT_WINDOW_MARGIN_MS = 3 * 60 * 1000;
/** Never re-tick faster than this even when a window is imminent. */
const MIN_TICK_MS = 1000;
/**
 * Never re-tick slower than this even when nothing is upcoming soon — a module constant, not
 * derived from `slowPollIntervalMs` (design.md's "Cadence arithmetic, in one place" argument
 * against hidden coupling to an unrelated module's default). Every window is 6 minutes wide, so a
 * 5-minute ceiling can never let an entire window pass unnoticed between two ticks.
 */
const RECOMPUTE_CEILING_MS = 300_000;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

interface ActiveWindow {
  release: () => void;
  untilMs: number;
}

export interface AlarmWindowSchedulerOptions {
  snapshot: SnapshotStore;
  poller: PodPoller;
  timers?: TimerApi;
  logger?: Logger;
  /** Interval used while a window is active — threaded from `config.pollIntervals.
   * alarmPollIntervalMs` (default 3000, `src/config.ts`). */
  alarmPollIntervalMs: number;
  /** Symmetric margin around each predicted instant. Default 3 minutes (issue #16). */
  windowMarginMs?: number;
}

export class AlarmWindowScheduler {
  private readonly snapshot: SnapshotStore;
  private readonly poller: PodPoller;
  private readonly timers: TimerApi;
  private readonly logger: Logger;
  private readonly alarmPollIntervalMs: number;
  private readonly windowMarginMs: number;

  /** Keyed by `${side}:${instantMs}:${source}` — the design.md "stable occurrence key". */
  private readonly active = new Map<string, ActiveWindow>();
  private timerHandle: TimerHandle | null = null;
  private stopped = false;

  constructor(options: AlarmWindowSchedulerOptions) {
    this.snapshot = options.snapshot;
    this.poller = options.poller;
    this.timers = options.timers ?? defaultTimerApi;
    this.logger = options.logger ?? defaultLogger;
    this.alarmPollIntervalMs = options.alarmPollIntervalMs;
    this.windowMarginMs = options.windowMarginMs ?? DEFAULT_WINDOW_MARGIN_MS;

    // "On construction and after every tick" (design.md, "Recomputation") — a platform restart
    // mid-window must re-arm immediately, not wait for the first recompute cycle to elapse.
    // Constructed before the platform's own bootstrap has populated any `schedules`/`settings`
    // observation (`platform.ts` constructs this alongside `poller`/`writeQueue`/`keepAlive`,
    // all before `PodPoller.bootstrap()` ever runs), so this first tick necessarily sees an
    // empty snapshot and schedules nothing yet — `recomputeNow()` below is what `platform.ts`
    // calls once the bootstrap actually settles, so real data is not left waiting for this
    // constructor's own timer (up to `RECOMPUTE_CEILING_MS`) to notice it exists.
    this.tick();
  }

  /**
   * An explicit, one-off recompute — called by `platform.ts` once `PodPoller.bootstrap()`
   * settles (design.md, "Platform wiring": services are constructed only after the bootstrap
   * settles; this scheduler's own first *meaningful* look at real data follows the same rule,
   * even though the scheduler object itself is constructed earlier). Reuses the same tick logic
   * a self-rescheduled timer uses — idempotent and safe to call whether or not anything has
   * changed since construction.
   */
  recomputeNow(): void {
    this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    const now = this.timers.now();
    const documents = this.snapshot.get().documents;
    const upcoming = deriveUpcomingAlarms(documents.schedules, documents.settings, now);
    this.reconcile(upcoming, now);
    this.scheduleNext(upcoming, now);
  }

  private reconcile(upcoming: readonly UpcomingAlarm[], now: number): void {
    // Tidy any local record whose window has already elapsed — the poller's own `requestMode`
    // expiry timer already dropped the mode server-side; this only cleans our own bookkeeping so
    // the loops below only ever see genuinely still-active windows.
    for (const [key, entry] of this.active) {
      if (entry.untilMs <= now) this.active.delete(key);
    }

    const freshKeys = new Set(upcoming.map(alarmScheduleKey));

    // A previously-active window whose instant is no longer among the fresh derivation (the
    // schedule changed out from under it) is withdrawn immediately, rather than left to run to
    // its original expiry for an alarm that no longer exists (design.md's step 3; pod-alarm-
    // scheduler spec's "A stale window is withdrawn when the schedule changes").
    for (const [key, entry] of this.active) {
      if (!freshKeys.has(key)) {
        entry.release();
        this.active.delete(key);
      }
    }

    for (const occurrence of upcoming) {
      const key = alarmScheduleKey(occurrence);
      if (this.active.has(key)) continue;
      const windowStart = occurrence.instantMs - this.windowMarginMs;
      const windowEnd = occurrence.instantMs + this.windowMarginMs;
      if (now < windowStart || now > windowEnd) continue; // not (or no longer) inside the window
      const release = this.poller.requestMode('deviceStatus', {
        intervalMs: this.alarmPollIntervalMs,
        untilMs: windowEnd,
        reason: 'alarm',
      });
      this.active.set(key, { release, untilMs: windowEnd });
      this.logger.debug(
        `alarmWindowScheduler: armed a fast-poll window for ${occurrence.side} (${occurrence.source}), ` +
          `until ${new globalThis.Date(windowEnd).toISOString()}`,
      );
    }
  }

  private scheduleNext(upcoming: readonly UpcomingAlarm[], now: number): void {
    if (this.stopped) return;
    // `tick()` can now be re-entered externally via `recomputeNow()` while a previous tick's own
    // timer is still pending (e.g. the platform's post-bootstrap kick, landing before the
    // construction-time tick's own timer would otherwise fire) — clear it first so this never
    // leaves two timers scheduled at once.
    if (this.timerHandle !== null) {
      this.timers.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    let soonestUnarmedStartMs = Infinity;
    for (const occurrence of upcoming) {
      const key = alarmScheduleKey(occurrence);
      if (this.active.has(key)) continue;
      const windowStart = occurrence.instantMs - this.windowMarginMs;
      if (windowStart > now && windowStart < soonestUnarmedStartMs) soonestUnarmedStartMs = windowStart;
    }
    const delay = clamp(
      Number.isFinite(soonestUnarmedStartMs) ? soonestUnarmedStartMs - now : RECOMPUTE_CEILING_MS,
      MIN_TICK_MS,
      RECOMPUTE_CEILING_MS,
    );
    this.timerHandle = this.timers.setTimeout(() => {
      this.timerHandle = null;
      this.tick();
    }, delay);
  }

  /** Idempotent — safe whether or not the timer was ever pending (mirrors `PodPoller.stop()`/
   * `WriteQueue.stop()`/`KeepAlive.stop()`'s shutdown convention). Cancels the scheduled
   * recompute and withdraws every currently active window request. */
  stop(): void {
    this.stopped = true;
    if (this.timerHandle !== null) {
      this.timers.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    for (const entry of this.active.values()) {
      entry.release();
    }
    this.active.clear();
  }
}
