/**
 * `SkipAlarmService` — the per-side "Skip Next Alarm" `Switch` (issue #17; `specs/
 * skip-alarm-switch/spec.md`), driving free-sleep's own `scheduleOverrides.alarm.expiresAt`
 * skip mechanism (`alarmScheduler.ts`'s recurring job checks only `expiresAt` against `now`,
 * never `disabled` — `docs/POD-API.md`).
 *
 * `ON` computes the next alarm occurrence via `nextAlarmSkipInstant` (`../pod/alarmSchedule.ts`
 * — `alarm-events` owns that module; this service consumes it, per that change's tech-lead
 * resolution) and posts `{disabled: true, timeOverride: '', expiresAt: <computed>}`; `OFF` posts
 * `{disabled: false, timeOverride: '', expiresAt: ''}`. Both are `POST /api/settings` — the
 * expensive write class — debounced locally (>= 2s, via the shared `ctx.timers`) above
 * `WriteQueue`'s own much shorter per-lane debounce, mirroring `AwayModeService`'s own two-layer
 * debounce discipline — including that service's 10s-per-side rate limit (S4, settings-switches
 * PR #46 review). Issue #17's own text does ask for this: "debounce >= 2s, rate-limit, and
 * re-read settings ~250ms after" — a previous version of this doc comment misread that sentence
 * as *not* asking for one; `RATE_LIMIT_MS` below closes that gap using the same 10s window
 * `AwayModeService` already uses, for the same "at most one job-rebuilding write per window per
 * side" reason.
 *
 * **No-op suppression (S3, settings-switches PR #46 review):** `flush()` skips the write (and
 * resolves the waiters immediately) whenever the coalesced `pending.on` already equals the
 * currently-observed on/off state — a double-tap within the debounce window that nets out to no
 * change produces zero `POST /api/settings` requests, not a redundant one.
 *
 * **The post-alarm-to-noon dead window (S5, settings-switches PR #46 review):** turning the
 * switch on when `nextAlarmSkipInstant` computes an instant that is already at or before "now"
 * — the window between an alarm firing and the following noon, when the noon rule still targets
 * *today's* (already-elapsed) alarm time — refuses the write outright rather than making an
 * expensive settings write that would skip nothing. See `flush()`'s own comment for the exact
 * guard.
 *
 * **Local optimistic shadow, not a new overlayable field (design.md, "The Skip Next Alarm switch
 * keeps a local optimistic shadow instead of extending `SnapshotStore`"):**
 * `scheduleOverrides.alarm.expiresAt` is not in `snapshot.ts`'s `OverlayableField` union, and the
 * derived on/off boolean this switch actually shows doesn't fit that overlay model cleanly (a
 * continuously-recomputed derived value, not a raw Pod-reported one with a settle window).
 * Instead this service tracks two independent, short-lived pieces of local state, both consulted
 * by `onGet` in priority order:
 *
 *   1. `pending` — a toggle requested but not yet submitted (still inside the local debounce
 *      window) — `onGet` returns this immediately, since the raw snapshot cannot possibly reflect
 *      it yet.
 *   2. `shadow` — installed optimistically the moment a debounced toggle is actually submitted
 *      (mirrors `WriteQueue`'s own "install at submission, not dispatch" overlay convention),
 *      live for `ctx.config.writeSettleMs` (the same window `WriteQueue`'s own overlays use, so
 *      this switch's own optimism window matches every other write in the plugin) — `onGet`
 *      prefers this while live, then falls back to computing fresh from the cached snapshot's raw
 *      `scheduleOverrides.alarm.expiresAt` once it expires. This is what makes the "self-clears
 *      once the override lapses, with no write" requirement (spec) fall out for free: once both
 *      `pending` and a live `shadow` are absent, `onGet` is a pure function of "is `expiresAt`
 *      still in the future," recomputed on every read.
 *
 * **Error mapping:** `writeQueue.submitSettings` is never gated by `AwayModeGuard` (that guard
 * gates `submitSide` only) — every failure here maps uniformly to `SERVICE_COMMUNICATION_FAILURE`,
 * with no `NOT_ALLOWED_IN_CURRENT_STATE` special case (unlike `AwayModeService`, this switch has
 * no `submitSide` pre-step that could ever be guarded).
 *
 * **Snapshot-change routing (S6, settings-switches PR #46 review — supersedes task 5.5's earlier
 * honest scope note):** `scheduleOverrides.alarm.expiresAt` is now a watched `Change` field
 * (`snapshot.ts`'s `alarmSkipExpiresAt`, diffed as the raw string) — added specifically so this
 * service learns of an out-of-band change (e.g. free-sleep's own web UI, or another client
 * entirely) without waiting for its own local shadow to lapse. The platform routes it to
 * `refresh()` (`isSkipAlarmChange`, mirroring `awayMode.ts`'s own `isAwayModeChange`), same as
 * every other settings-driven push. `refresh()` also (re-)arms a one-shot timer at the raw
 * `expiresAt` instant on every call, so the tile drops back to off at the exact moment an
 * override lapses with no read/push involved at all — see `armExpiryTimer`'s own doc. The
 * self-clearing-on-read requirement (spec) is still independently satisfied by `onGet`'s own
 * live computation regardless of whether either push path above ever fires.
 */

import type { Service } from 'homebridge';

import type { Change, TimerHandle } from '../pod/snapshot.ts';
import type { Side } from '../pod/types.ts';
import { nextAlarmSkipInstant } from '../pod/alarmSchedule.ts';
import type { ServiceContext } from './types.ts';

export const SKIP_ALARM_SUBTYPE = 'skipAlarm';

const SKIP_ALARM_NAMES: Readonly<Record<Side, string>> = {
  left: 'Skip Next Alarm Left',
  right: 'Skip Next Alarm Right',
};

/** Issue #17's own ">= 2s" service-level debounce floor (design.md). */
const DEBOUNCE_MS = 2000;
/** S4 (settings-switches PR #46 review): issue #17's own "rate-limit" text, given the same 10s
 * window `AwayModeService.RATE_LIMIT_MS` uses — see module doc's own note on this. */
const RATE_LIMIT_MS = 10_000;
/** Mirrors `ThermostatService`'s revert delay — how long after a rejected write to correct the
 * characteristic value HAP applied optimistically ahead of the throw. */
const REVERT_DELAY_MS = 500;

/** Whether a snapshot `Change` is the `alarmSkipExpiresAt` field this service watches (S6,
 * settings-switches PR #46 review) — mirrors `awayMode.ts`'s own `isAwayModeChange`. */
export function isSkipAlarmChange(change: Change): change is Change & { scope: 'side'; field: 'alarmSkipExpiresAt'; side: Side } {
  return change.scope === 'side' && change.field === 'alarmSkipExpiresAt';
}

/**
 * The Skip-Next-Alarm on/off boolean derived from `scheduleOverrides.alarm.expiresAt` and a
 * supplied "now" (tasks.md 1.2): non-empty and strictly after `nowMs` = on; empty, unparseable,
 * or at/before `nowMs` = off. Pure — no ambient clock read, matching `alarmSchedule.ts`'s own
 * discipline (though this helper lives here, not there, since it is used by no other caller).
 */
export function isSkipAlarmOn(expiresAt: string | undefined, nowMs: number): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return false;
  return ms > nowMs;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingToggle {
  on: boolean;
  waiters: Waiter[];
}

interface Shadow {
  on: boolean;
  /** The moment this shadow stops being authoritative — `onGet` falls back to a fresh
   * raw-snapshot computation once `ctx.timers.now()` reaches this. */
  deadlineMs: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SkipAlarmService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly platformStartedAt: number;
  private readonly service: Service;

  private pending: PendingToggle | undefined;
  private debounceTimer: TimerHandle | null = null;
  private shadow: Shadow | undefined;
  /** S4 (settings-switches PR #46 review): when the last write for this side was actually
   * *submitted* (not settled) — mirrors `AwayModeService.lastSubmittedAtMs`. `undefined` until
   * this side's first submission this launch. Never advanced by an S3 no-op suppression, since
   * nothing was actually submitted then. */
  private lastSubmittedAtMs: number | undefined;

  /** Mirrors `ThermostatService`'s shadow pattern for pushes — the last value this service
   * pushed via `updateValue`, so a revert only pushes on an actual change. */
  private publishedOn: boolean | undefined;
  private revertTimer: TimerHandle | null = null;
  /** S6 (settings-switches PR #46 review): fires exactly at the raw, Pod-confirmed `expiresAt`
   * instant so the tile drops back to off without waiting for a poll — see `armExpiryTimer`. */
  private expiryTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext, side: Side, platformStartedAt: number) {
    this.ctx = ctx;
    this.side = side;
    this.platformStartedAt = platformStartedAt;

    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.Switch, SKIP_ALARM_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Switch(SKIP_ALARM_NAMES[side], SKIP_ALARM_SUBTYPE));

    this.wireReadsAndWrites();

    // B1-equivalent: publish whatever the bootstrap already observed, mirroring
    // `ThermostatService`'s own initial-publish call.
    this.refresh();
  }

  private rawExpiresAt(): string | undefined {
    return this.ctx.snapshot.get().documents.settings?.[this.side]?.scheduleOverrides.alarm.expiresAt;
  }

  private computedValue(): boolean {
    if (this.pending) return this.pending.on;
    if (this.shadow && this.shadow.deadlineMs > this.ctx.timers.now()) return this.shadow.on;
    return isSkipAlarmOn(this.rawExpiresAt(), this.ctx.timers.now());
  }

  // ---------------------------------------------------------------------------------------
  // No-Response escalation (mirrors ThermostatService.assertNotEscalated)
  // ---------------------------------------------------------------------------------------

  private assertNotEscalated(): void {
    const hap = this.ctx.api.hap;
    const { connection } = this.ctx.snapshot.get();
    const noResponseAfterMs = this.ctx.config.noResponseAfterMs;
    const since = connection.lastSuccessAt ?? this.platformStartedAt;
    const escalated = noResponseAfterMs > 0 && !connection.online && this.ctx.timers.now() - since > noResponseAfterMs;
    if (escalated) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Reads and writes
  // ---------------------------------------------------------------------------------------

  private wireReadsAndWrites(): void {
    const onChar = this.service.getCharacteristic(this.ctx.api.hap.Characteristic.On);

    onChar.onGet(() => {
      this.assertNotEscalated();
      return this.computedValue();
    });

    onChar.onSet(async (rawValue) => {
      const desired = Boolean(rawValue);
      this.publishedOn = desired; // claim into the shadow used for push comparisons, no push
      return new Promise<void>((resolve, reject) => {
        if (this.pending) {
          this.pending.on = desired;
          this.pending.waiters.push({ resolve, reject });
        } else {
          this.pending = { on: desired, waiters: [{ resolve, reject }] };
        }
        this.scheduleFlush();
      });
    });
  }

  /**
   * (Re)computes the next flush time as the *later* of the debounce floor and the S4 rate-limit
   * floor — the identical `Math.max` computation `AwayModeService.scheduleFlush` uses, for the
   * same reason (one timer, no mode flag).
   */
  private scheduleFlush(): void {
    if (this.debounceTimer !== null) this.ctx.timers.clearTimeout(this.debounceTimer);
    const now = this.ctx.timers.now();
    const earliestByDebounce = now + DEBOUNCE_MS;
    const earliestByRateLimit = this.lastSubmittedAtMs === undefined ? 0 : this.lastSubmittedAtMs + RATE_LIMIT_MS;
    const at = Math.max(earliestByDebounce, earliestByRateLimit);
    this.debounceTimer = this.ctx.timers.setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, at - now);
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;

    // S3 (settings-switches PR #46 review): a double-tap within the debounce window that
    // coalesces back to the value already observed on the cached snapshot produces no write at
    // all — nothing would actually change on the Pod. Resolved immediately, without touching
    // `lastSubmittedAtMs` (no submission happened, so the rate-limit floor must not advance).
    if (pending.on === isSkipAlarmOn(this.rawExpiresAt(), this.ctx.timers.now())) {
      pending.waiters.forEach((w) => w.resolve());
      return;
    }

    this.lastSubmittedAtMs = this.ctx.timers.now();

    const hap = this.ctx.api.hap;
    try {
      let expiresAt = '';
      if (pending.on) {
        const schedules = this.ctx.snapshot.get().documents.schedules;
        const timeZone = this.ctx.snapshot.get().documents.settings?.timeZone;
        if (!schedules || !timeZone) {
          // No cached schedules/settings yet to compute a target from (e.g. very early in the
          // platform's life, before the first successful poll) — fail loudly rather than guess.
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        const nowMs = this.ctx.timers.now();
        const instantMs = nextAlarmSkipInstant(timeZone, schedules[this.side], nowMs);
        // N4 (settings-switches PR #46 review): `nextAlarmSkipInstant` is hardened like
        // `deriveUpcomingAlarms`' own B1 guards to return a non-finite result (never throw) for a
        // malformed `alarm.time`, an unrecognized `timeZone`, or a missing weekday entry — mapped
        // here to the same communication-failure error every other write failure in this method
        // uses, per spec, rather than letting a raw, unmapped error reach the HAP layer.
        if (!Number.isFinite(instantMs)) {
          this.ctx.log.debug(
            `FreeSleep: ${this.side} skip-alarm next-instant computation failed (malformed schedule/time zone data)`,
          );
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        // S5 (settings-switches PR #46 review): the post-alarm-to-noon dead window. The noon rule
        // (`nextAlarmSkipInstant`'s own doc) targets *today's* alarm time whenever "now" is before
        // noon — but if today's alarm has already rung (now is between that alarm and noon), the
        // computed instant is already in the past. Writing it anyway would be a real, expensive
        // settings write (full node-schedule rebuild on the Pod) that skips nothing at all — the
        // override it produces is already-expired the instant it lands. Refused outright instead,
        // with the established revert pattern (this toggle never got as far as installing a
        // shadow, so `scheduleRevert` below just re-publishes the still-accurate raw/pending-free
        // state).
        if (instantMs <= nowMs) {
          this.ctx.log.info(
            `FreeSleep: ${this.side} skip-alarm toggle refused — the computed skip instant ` +
              `(${new Date(instantMs).toISOString()}) is already in the past (the dead window between ` +
              `today's alarm ringing and noon); the next skippable occurrence is tomorrow's alarm, ` +
              'available again once "now" is past noon in this side\'s configured time zone.',
          );
          throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        // `Date.prototype.toISOString()` always includes an explicit UTC designator ("Z") — a
        // complete, unambiguous ISO-8601 instant (spec: "not a bare local time"), the same
        // unambiguity `moment.tz(...).format()`'s own `+HH:MM` offset achieves upstream.
        expiresAt = new Date(instantMs).toISOString();
      }

      // Installed optimistically at submission time, before the request settles — mirrors
      // `WriteQueue`'s own "overlay installed at submission, not dispatch" convention (module
      // doc's "Local optimistic shadow").
      this.shadow = { on: pending.on, deadlineMs: this.ctx.timers.now() + this.ctx.config.writeSettleMs };

      try {
        await this.ctx.writeQueue.submitSettings({
          [this.side]: { scheduleOverrides: { alarm: { disabled: pending.on, timeOverride: '', expiresAt } } },
        });
      } catch (error) {
        this.ctx.log.debug(`FreeSleep: ${this.side} skip-alarm write failed: ${describeError(error)}`);
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }

      // S6: arm against the just-written value immediately — the tile then drops back to off at
      // exactly the right instant even before any confirming settings re-read lands.
      this.armExpiryTimer(expiresAt);
      pending.waiters.forEach((w) => w.resolve());
    } catch (hapError) {
      this.shadow = undefined;
      this.scheduleRevert();
      pending.waiters.forEach((w) => w.reject(hapError));
    }
  }

  private scheduleRevert(): void {
    if (this.revertTimer !== null) {
      this.ctx.timers.clearTimeout(this.revertTimer);
    }
    this.revertTimer = this.ctx.timers.setTimeout(() => {
      this.revertTimer = null;
      this.refresh();
    }, REVERT_DELAY_MS);
  }

  // ---------------------------------------------------------------------------------------
  // Push
  // ---------------------------------------------------------------------------------------

  /**
   * S6 (settings-switches PR #46 review): (re-)arms a one-shot timer at `expiresAt` so the tile
   * drops back to off at the exact moment an override lapses, rather than only on the next
   * regular settings poll or the next `onGet` read. Always clears any existing timer first — a
   * `null`/empty/unparseable/already-past `expiresAt` then arms nothing, leaving the timer
   * cleared. Called from `refresh()` (every call site: construction, an external
   * `isSkipAlarmChange` push, and the post-revert refresh) with the raw, Pod-confirmed value, and
   * directly from `flush()` with a just-written value so this service's own toggles get the
   * timer armed immediately rather than waiting for the confirming re-read.
   */
  private armExpiryTimer(expiresAt: string | undefined): void {
    if (this.expiryTimer !== null) {
      this.ctx.timers.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (!expiresAt) return;
    const ms = Date.parse(expiresAt);
    if (Number.isNaN(ms)) return;
    const delay = ms - this.ctx.timers.now();
    if (delay <= 0) return;
    this.expiryTimer = this.ctx.timers.setTimeout(() => {
      this.expiryTimer = null;
      this.refresh();
    }, delay);
  }

  /** Idempotent push — pushes only when `computedValue()` actually differs from what was last
   * published — and unconditionally (re-)arms the S6 expiry timer against the raw snapshot value
   * on every call, whether or not the push itself fired (an external change that extends an
   * already-on override, e.g., must still re-arm to the new, later instant even though the
   * published boolean does not change). Called at construction (B1-equivalent seed), after a
   * `scheduleRevert` delay, and from the platform's `isSkipAlarmChange` routing (module doc's
   * "Snapshot-change routing"). */
  refresh(): void {
    const value = this.computedValue();
    if (this.publishedOn !== value) {
      this.publishedOn = value;
      this.service.getCharacteristic(this.ctx.api.hap.Characteristic.On).updateValue(value);
    }
    this.armExpiryTimer(this.rawExpiresAt());
  }

  /** Clears any pending debounce/revert/expiry timer and rejects any write still waiting on the
   * (now-cancelled) debounce — mirrors `AwayModeService.stop()`'s own shutdown discipline. */
  stop(): void {
    if (this.debounceTimer !== null) {
      this.ctx.timers.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.revertTimer !== null) {
      this.ctx.timers.clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    if (this.expiryTimer !== null) {
      this.ctx.timers.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      const hap = this.ctx.api.hap;
      pending.waiters.forEach((w) => w.reject(new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
    }
  }
}
