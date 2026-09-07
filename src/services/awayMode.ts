/**
 * `AwayModeService` — the per-side "Away Mode" `Switch` (issue #18; `specs/away-mode-switch/
 * spec.md`), bound to `settings.{side}.awayMode` — the field that makes free-sleep's own
 * `powerScheduler.ts`, `temperatureScheduler.ts`, and `alarmScheduler.ts` all skip a side
 * entirely (`docs/POD-API.md`; design.md's Context).
 *
 * `settings.{side}.awayMode` is written through `POST /api/settings` — the *expensive* write
 * class this project's constraints say must stay rare (`docs/POD-API.md`: any settings write
 * makes the Pod cancel and rebuild every scheduled job). Two layers keep it rare:
 *
 *   - **Service-level debounce (>= 2s):** every `onSet` call re-picks the eventual flush time as
 *     `now + DEBOUNCE_MS`, coalescing rapid repeat toggles into the single, latest-value write
 *     that eventually fires — a local timer via the shared `ctx.timers`, layered *above*
 *     `WriteQueue`'s own much shorter (~400ms) per-lane debounce, not a replacement for it
 *     (design.md, "Debounce and rate-limiting live at the service level").
 *   - **Per-side rate limit (>= 10s between actual submissions):** `flush()` additionally floors
 *     the next submission at `lastSubmittedAtMs + RATE_LIMIT_MS`, so a burst of toggles spread
 *     out over more than 2s (but less than 10s) still cannot produce a second settings write
 *     inside that 10s window — the same `Math.max(...)` computation handles both constraints at
 *     once (see `scheduleFlush`'s doc below).
 *
 * `onSet` always returns a promise that settles with the *coalesced* write's own outcome — every
 * caller whose toggle merged into the same pending write resolves or rejects together, mirroring
 * `WriteQueue`'s own per-lane waiter-list pattern (`src/pod/writeQueue.ts`).
 *
 * **Error mapping (design.md, "Error surfacing... the away-mode-guard's own error mapping does
 * not apply here"):** `AwayModeGuard`'s `AwayModeBlockedError` -> `NOT_ALLOWED_IN_CURRENT_STATE`
 * mapping gates `submitSide` (side-lane writes) only. This switch's own write —
 * `writeQueue.submitSettings` — is never gated by that guard, so a `submitSettings` failure of
 * any kind maps uniformly to `SERVICE_COMMUNICATION_FAILURE`. The one place `AwayModeBlockedError`
 * *can* legitimately surface here is the optional `awayModeTurnsSideOff` pre-step below, which
 * calls `submitSide` — a genuinely guarded side-lane write — so that specific failure *does* map
 * to `NOT_ALLOWED_IN_CURRENT_STATE`, same as `ThermostatService`'s own handling of a blocked
 * `submitSide` call.
 */

import type { Service } from 'homebridge';

import { AwayModeBlockedError } from '../pod/awayModeGuard.ts';
import type { Change, TimerHandle } from '../pod/snapshot.ts';
import type { Side } from '../pod/types.ts';
import type { ServiceContext } from './types.ts';

export const AWAY_MODE_SUBTYPE = 'awayMode';

const AWAY_MODE_NAMES: Readonly<Record<Side, string>> = {
  left: 'Away Mode Left',
  right: 'Away Mode Right',
};

/** Issues #17/#18's own ">= 2s" service-level debounce floor (design.md). */
const DEBOUNCE_MS = 2000;
/** Issue #18's own "one settings write per side per 10s window" rate limit (design.md). */
const RATE_LIMIT_MS = 10_000;
/** Mirrors `ThermostatService`'s `AWAY_MODE_BLOCKED_REVERT_DELAY_MS` — how long after a rejected
 * write to correct the characteristic value HAP applied optimistically ahead of the throw. */
const REVERT_DELAY_MS = 500;

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingWrite {
  value: boolean;
  waiters: Waiter[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a snapshot `Change` is the `awayMode` field this service watches (mirrors
 * `thermostat.ts`'s `isThermostatChange` / `alarm.ts`'s `isAlarmChange`). */
export function isAwayModeChange(change: Change): change is Change & { scope: 'side'; field: 'awayMode'; side: Side } {
  return change.scope === 'side' && change.field === 'awayMode';
}

export class AwayModeService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly platformStartedAt: number;
  private readonly service: Service;

  /** The debounced/rate-limited write not yet submitted, if any — `onGet` prefers this over the
   * (necessarily stale, until this actually submits) cached snapshot value. */
  private pending: PendingWrite | undefined;
  private debounceTimer: TimerHandle | null = null;
  /** When the last write for this side was actually *submitted* (not settled) — the rate
   * limit's own floor is measured from this, per `scheduleFlush`'s doc. `undefined` until this
   * side's first submission this launch. */
  private lastSubmittedAtMs: number | undefined;

  /** Mirrors `ThermostatService`'s shadow pattern — the last value this service pushed via
   * `updateValue`, so `refresh()` only pushes on an actual change. */
  private publishedOn: boolean | undefined;
  private revertTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext, side: Side, platformStartedAt: number) {
    this.ctx = ctx;
    this.side = side;
    this.platformStartedAt = platformStartedAt;

    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.Switch, AWAY_MODE_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Switch(AWAY_MODE_NAMES[side], AWAY_MODE_SUBTYPE));

    this.wireReadsAndWrites();

    // B1-equivalent: publish whatever the bootstrap already observed before this service is
    // registered — mirrors `ThermostatService`'s own initial-publish call. Without this, the
    // characteristic keeps HAP's own default (`false`) until the next `awayMode` change event,
    // which a Pod already observed away at launch may never send.
    this.refresh();
  }

  private observedValue(): boolean {
    return this.ctx.snapshot.get()[this.side].awayMode ?? false;
  }

  private currentEffectiveValue(): boolean {
    return this.pending ? this.pending.value : this.observedValue();
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
      return this.currentEffectiveValue();
    });

    onChar.onSet(async (rawValue) => {
      const value = Boolean(rawValue);
      // Claim into the shadow immediately (no push) — mirrors ThermostatService's "claim into
      // the shadow before submitting": HAP has already applied `value` to the characteristic
      // optimistically before this handler runs.
      this.publishedOn = value;
      return new Promise<void>((resolve, reject) => {
        if (this.pending) {
          this.pending.value = value;
          this.pending.waiters.push({ resolve, reject });
        } else {
          this.pending = { value, waiters: [{ resolve, reject }] };
        }
        this.scheduleFlush();
      });
    });
  }

  /**
   * (Re)computes the next flush time on every call as the *later* of the debounce floor
   * (`now + DEBOUNCE_MS`, re-armed by every `onSet` — coalescing rapid repeat toggles to the
   * latest value) and the rate-limit floor (`lastSubmittedAtMs + RATE_LIMIT_MS`, a hard minimum
   * spacing between actual submissions for this side, regardless of how long the debounce alone
   * would have waited). One `Math.max` handles both constraints without needing two separate
   * timers or a mode flag (design.md, "Debounce and rate-limiting live at the service level").
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
    this.lastSubmittedAtMs = this.ctx.timers.now();

    const hap = this.ctx.api.hap;
    try {
      // awayModeTurnsSideOff (issue #18's own spec): only sequenced when *enabling* Away Mode —
      // turning it off never touches power, regardless of the flag (away-mode-switch spec).
      if (pending.value && this.ctx.config.awayModeTurnsSideOff) {
        try {
          await this.ctx.writeQueue.submitSide(this.side, { isOn: false });
        } catch (error) {
          if (error instanceof AwayModeBlockedError) {
            this.ctx.log.debug(
              `FreeSleep: ${this.side} away-mode-turns-off power write refused by the away-mode guard: ${describeError(error)}`,
            );
            throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
          }
          this.ctx.log.debug(`FreeSleep: ${this.side} away-mode-turns-off power write failed: ${describeError(error)}`);
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      }

      try {
        await this.ctx.writeQueue.submitSettings({ [this.side]: { awayMode: pending.value } });
      } catch (error) {
        // Never gated by AwayModeGuard (module doc's "Error mapping") — always a communication
        // failure, never NOT_ALLOWED_IN_CURRENT_STATE.
        this.ctx.log.debug(`FreeSleep: ${this.side} away-mode write failed: ${describeError(error)}`);
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }

      pending.waiters.forEach((w) => w.resolve());
    } catch (hapError) {
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
  // Push (platform routes snapshot change events here — design.md's routing table)
  // ---------------------------------------------------------------------------------------

  /** Idempotent — pushes only when `currentEffectiveValue()` actually differs from what was last
   * published (mirrors `ThermostatService.pushMode`). Called on a snapshot `awayMode` change for
   * this side, and after a `scheduleRevert` delay. */
  refresh(): void {
    const value = this.currentEffectiveValue();
    if (this.publishedOn === value) return;
    this.publishedOn = value;
    this.service.getCharacteristic(this.ctx.api.hap.Characteristic.On).updateValue(value);
  }

  /** Clears any pending debounce/revert timer — wired into the platform's `shutdown` teardown —
   * and rejects any write still waiting on the (now-cancelled) debounce, so a caller `await`ing
   * `onSet`'s returned promise is never left hanging past shutdown (mirrors `WriteQueue.stop()`'s
   * own `WriteQueueStoppedError` rejection of anything still queued). This write was never
   * submitted to `writeQueue` at all — it was still accumulating locally — so there is nothing
   * for `WriteQueue.stop()` itself to reject on this service's behalf. */
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
