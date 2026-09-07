/**
 * `KeepAlive` — keeps a side HomeKit believes is on from silently expiring (`pod-keep-alive`
 * spec, issue #12).
 *
 * `isOn: true` is implemented server-side as a 12-hour duration
 * (`server/src/routes/deviceStatus/updateDeviceStatus.ts`, `'43200'`), derived back to `isOn` on
 * read as `secondsRemaining > 0` (`server/src/8sleep/loadDeviceStatus.ts`). This module owns a
 * single self-rescheduling timer, structurally a peer of `PodPoller` and `WriteQueue` (design.md,
 * "A new, small, timer-owning module"): on every tick it reads `snapshot.get()` fresh for each
 * side and, only while that side is currently observed on and its remaining time has dropped
 * below `keepAliveThresholdMs`, re-posts `keepAliveMs` as its `secondsRemaining` through
 * `writeQueue.submitSide(side, patch, 'keepAlive')` — the same entry point every HomeKit-
 * triggered write already uses, so it inherits debouncing, the mutex, the away-mode guard, and
 * the power/duration reduction for free.
 *
 * Imports `snapshot.ts` and `writeQueue.ts` only — it both reads the snapshot and writes through
 * the queue, which is exactly why this is its own module rather than a `PodPoller` endpoint class
 * (poller.ts is contractually forbidden from importing `writeQueue.ts` at all) or logic folded
 * into `WriteQueue` itself (`pod-write-queue`'s own spec: "the queue holds no policy about...
 * keep-alive").
 *
 * Reads live snapshot state every tick — nothing about a side's on/off history is cached across
 * ticks except the per-side `nextDueAtMs` re-arm cooldown below. This is what makes both required
 * safety properties fall out with no special-casing: after the Pod's daily reboot every side's
 * `secondsRemaining` resets to `0`, so the next poll observes `isOn: false` and the next tick does
 * nothing; and a user turning a side off through any path installs a synchronous `isOn: false`
 * overlay this tick's fresh read already sees (design.md, "The check reads live snapshot state
 * every tick").
 *
 * **Observation-freshness guard (PR #40 review, F1):** a tick never acts on a cache it cannot
 * currently trust. `checkSide` additionally requires `snapshot.get().connection.online` to be
 * `true` and the most recent successful `deviceStatus` observation (`connection.lastSuccessAt`)
 * to be no older than `checkIntervalMs` before it will even look at a side's `isOn`/
 * `secondsRemaining`. Without this, a side a user just turned off — whose synchronous `isOn:
 * false` overlay (see "no locally-remembered 'is on' flag" below) expires after `writeSettleMs`
 * with no confirming poll in between (a reboot, or a stretch of failed reads) — falls back to
 * `raw.deviceStatus`, which still holds the pre-off `isOn: true`/low-`secondsRemaining` values
 * from before the write: exactly what a tick is supposed to re-arm. `checkIntervalMs` (rather
 * than, say, `pollIntervalMs`) is the bound because it is the only poll-cadence-shaped number
 * this module has any business knowing about on its own — `pollIntervalMs` defaults to 30s and
 * is always meant to be smaller (`checkIntervalMs`'s own 60s floor), so under a healthy
 * connection at least one successful observation lands inside every `checkIntervalMs` window; a
 * window with none is a signal the cache is not to be trusted, connection-state flag or not.
 *
 * **In-flight re-arm tracking (PR #40 review, N4/N5):** a side with a re-arm write still
 * outstanding (submitted, not yet resolved or rejected) is skipped by every subsequent tick,
 * the same way a side already inside its post-success cooldown is — otherwise a dispatch stuck
 * behind a slow mutex or a stalled request would see the same stale-but-still-qualifying
 * snapshot on every tick in between and queue one redundant `submitSide` call per tick, each of
 * which eventually dispatches its own POST once the queue frees up. A rejected re-arm (a
 * blocked away-mode write, most commonly) also now starts the same cooldown a successful one
 * would — the write reaches no Pod traffic either way, but without this a persistently blocked
 * side would retry, and debug-log, every single `checkIntervalMs` for as long as the block
 * condition holds.
 *
 * **Away-mode caveat (recorded per issue #12's PR #39 review comment, design.md's "Away mode: no
 * special-casing" decision):** under the `'mirror'` away-mode policy, a keep-alive re-arm's
 * `secondsRemaining`-only patch is never mirrored to the other side — `WriteQueue.
 * mirrorToOtherSide` only ever mirrors the overlayable fields (`targetTemperatureF`, `isOn`,
 * `isAlarmVibrating`), and `secondsRemaining` is neither one of those nor itself overlayable
 * (`snapshot.ts`'s `OverlayableField`) — while free-sleep's own `updateSide` applies the posted
 * duration to *both* sides server-side whenever either side is away (`controlBothSides`,
 * `docs/POD-API.md`). So an away-mode keep-alive re-arm silently drives both sides' remaining
 * time with nothing telling HomeKit until the next `deviceStatus` poll observes it. This is
 * accepted, not fixed here: the cached view is only ever briefly stale, self-corrects on the next
 * poll (every `pollIntervalMs`, 30s by default), and `secondsRemaining` was already never
 * reflected optimistically for any caller, keep-alive included.
 */

import { defaultLogger, defaultTimerApi, type Logger, type TimerApi, type TimerHandle, type SnapshotStore } from './snapshot.ts';
import type { Side } from './types.ts';
import type { WriteQueue } from './writeQueue.ts';

const SIDES: readonly Side[] = ['left', 'right'];

/** At most 15 minutes (issue #12's own number, now a derived ceiling), at least 1 minute so a
 * very small configured threshold cannot spin the timer (design.md, "Check cadence and re-arm
 * cooldown are both derived from the threshold"). */
const CHECK_INTERVAL_FLOOR_MS = 60_000;
const CHECK_INTERVAL_CEILING_MS = 900_000;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface KeepAliveOptions {
  snapshot: SnapshotStore;
  writeQueue: WriteQueue;
  timers?: TimerApi;
  logger?: Logger;
  /** The duration (ms) re-posted as a side's `secondsRemaining` when it is re-armed. */
  keepAliveMs: number;
  /** A side is re-armed once its observed remaining time drops below this. */
  keepAliveThresholdMs: number;
  /** `false` disables the component entirely — no timer is ever scheduled, no write is ever
   * submitted (design.md's Goals: "no HomeKit-visible surface" / config-gated). */
  enabled: boolean;
}

export class KeepAlive {
  private readonly snapshot: SnapshotStore;
  private readonly writeQueue: WriteQueue;
  private readonly timers: TimerApi;
  private readonly logger: Logger;

  private readonly keepAliveMs: number;
  private readonly keepAliveThresholdMs: number;
  private readonly enabled: boolean;

  /** `clamp(keepAliveThresholdMs / 2, 60_000, 900_000)` (design.md) — checking at half the
   * threshold guarantees a side crossing it is caught before its remaining time can reach zero. */
  readonly checkIntervalMs: number;

  /** Per-side re-arm cooldown: the earliest wall-clock time a just-issued re-arm's own duration
   * would itself next approach the threshold (design.md, "Redundant re-arms are suppressed").
   * `0` (never due yet elapsed) for a side that has never been re-armed this launch. Also set
   * (N5) after a rejected re-arm, so a persistently blocked side doesn't retry — and debug-log —
   * every single tick. */
  private readonly nextDueAtMs: Record<Side, number> = { left: 0, right: 0 };

  /** `true` while a side's `submitSide` re-arm call is outstanding — submitted but not yet
   * resolved or rejected (N4). Prevents a dispatch stuck behind a slow mutex or a stalled
   * request from accumulating one redundant `submitSide` call per tick in between. */
  private readonly armingInFlight: Record<Side, boolean> = { left: false, right: false };

  private timerHandle: TimerHandle | null = null;
  private stopped = false;

  constructor(options: KeepAliveOptions) {
    this.snapshot = options.snapshot;
    this.writeQueue = options.writeQueue;
    this.timers = options.timers ?? defaultTimerApi;
    this.logger = options.logger ?? defaultLogger;
    this.keepAliveMs = options.keepAliveMs;
    this.keepAliveThresholdMs = options.keepAliveThresholdMs;
    this.enabled = options.enabled;
    this.checkIntervalMs = clamp(Math.floor(this.keepAliveThresholdMs / 2), CHECK_INTERVAL_FLOOR_MS, CHECK_INTERVAL_CEILING_MS);

    if (this.enabled) {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.stopped || !this.enabled) return;
    this.timerHandle = this.timers.setTimeout(() => {
      this.timerHandle = null;
      this.tick();
    }, this.checkIntervalMs);
  }

  private tick(): void {
    if (this.stopped) return;
    for (const side of SIDES) {
      this.checkSide(side);
    }
    this.scheduleNext();
  }

  /**
   * F1: whether the cache is currently trustworthy enough to act on. `false` whenever the last
   * `deviceStatus` poll failed (`connection.online === false`) or there has never been a
   * successful one (`lastSuccessAt === null`) — both already sufficient on their own — and also
   * whenever the most recent success is older than `checkIntervalMs`, a backstop for the case
   * where `connection.online` is (incorrectly, or simply not-yet-updated) still `true` but no
   * confirming poll has actually landed in a long time. See the module doc's "Observation-
   * freshness guard" section for why `checkIntervalMs` is the bound.
   */
  private isObservationFresh(now: number): boolean {
    const { online, lastSuccessAt } = this.snapshot.get().connection;
    if (!online) return false;
    if (lastSuccessAt === null) return false;
    return now - lastSuccessAt <= this.checkIntervalMs;
  }

  private checkSide(side: Side): void {
    const now = this.timers.now();
    if (now < this.nextDueAtMs[side]) return; // still cooling down from a recent re-arm
    if (this.armingInFlight[side]) return; // N4: a still-settling re-arm must not accumulate duplicates
    if (!this.isObservationFresh(now)) return; // F1: never act on a stale/unconfirmed cache

    const status = this.snapshot.get()[side];
    if (status.isOn !== true) return; // never re-ignites a side that's off (a reboot included)
    if (status.secondsRemaining === undefined) return;
    if (status.secondsRemaining * 1000 >= this.keepAliveThresholdMs) return; // comfortably above

    this.armingInFlight[side] = true;
    this.writeQueue
      .submitSide(side, { secondsRemaining: Math.round(this.keepAliveMs / 1000) }, 'keepAlive')
      .then(() => {
        this.armingInFlight[side] = false;
        // Cooldown measured from the moment the re-arm actually took effect, not from when it
        // was submitted — the earliest time this *newly re-armed* duration would itself next
        // approach the threshold (design.md).
        this.nextDueAtMs[side] = this.timers.now() + (this.keepAliveMs - this.keepAliveThresholdMs);
      })
      .catch((error: unknown) => {
        this.armingInFlight[side] = false;
        // N5: the same cooldown a success would get, so a persistently blocked side (most
        // commonly the away-mode 'block' policy) doesn't retry, and debug-log, every tick.
        this.nextDueAtMs[side] = this.timers.now() + (this.keepAliveMs - this.keepAliveThresholdMs);
        this.logger.debug(`keepAlive: re-arm write for ${side} failed, will retry after cooldown: ${describeError(error)}`);
      });
  }

  /** Idempotent — safe to call whether or not the timer was ever started (mirrors
   * `PodPoller.stop()`/`WriteQueue.stop()`'s shutdown convention). Cancels the scheduled timer
   * and submits no further writes, including one that was about to become due. */
  stop(): void {
    this.stopped = true;
    if (this.timerHandle !== null) {
      this.timers.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
