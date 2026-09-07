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
 * debounce discipline (minus that service's additional 10s rate limit, which issue #17 does not
 * ask for).
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
 * **Snapshot-change routing (task 5.5's own honest scope note):** `scheduleOverrides.alarm.
 * expiresAt` has no watched `Change` field in `snapshot.ts` (only `awayMode`, `isOn`,
 * `targetTemperatureF`, `isAlarmVibrating` are watched per side) — adding one is out of this
 * change's scope (proposal.md's Impact: "Not modified: `src/pod/snapshot.ts`"). This service is
 * therefore never routed a proactive snapshot-change push; its only push trigger is its own
 * accept-then-revert timer after a failed write, mirroring `ThermostatService`'s established
 * pattern. The self-clearing-on-read requirement is satisfied by `onGet`'s own live computation,
 * not by a push — see point 2 above.
 */

import type { Service } from 'homebridge';

import type { TimerHandle } from '../pod/snapshot.ts';
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
/** Mirrors `ThermostatService`'s revert delay — how long after a rejected write to correct the
 * characteristic value HAP applied optimistically ahead of the throw. */
const REVERT_DELAY_MS = 500;

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

  /** Mirrors `ThermostatService`'s shadow pattern for pushes — the last value this service
   * pushed via `updateValue`, so a revert only pushes on an actual change. */
  private publishedOn: boolean | undefined;
  private revertTimer: TimerHandle | null = null;

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

  private scheduleFlush(): void {
    if (this.debounceTimer !== null) this.ctx.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.ctx.timers.setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;

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
        const instantMs = nextAlarmSkipInstant(timeZone, schedules[this.side], this.ctx.timers.now());
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

  /** Idempotent — pushes only when `computedValue()` actually differs from what was last
   * published. Called at construction (B1-equivalent seed) and after a `scheduleRevert` delay;
   * see module doc's "Snapshot-change routing" for why nothing else calls this. */
  refresh(): void {
    const value = this.computedValue();
    if (this.publishedOn === value) return;
    this.publishedOn = value;
    this.service.getCharacteristic(this.ctx.api.hap.Characteristic.On).updateValue(value);
  }

  /** Clears any pending debounce/revert timer and rejects any write still waiting on the
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
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      const hap = this.ctx.api.hap;
      pending.waiters.forEach((w) => w.reject(new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
    }
  }
}
