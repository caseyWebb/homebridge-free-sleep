/**
 * `AlarmService` — the per-side alarm-press `StatelessProgrammableSwitch` and "Dismiss Alarm"
 * `Switch` (`alarm-events` spec; `docs/HOMEKIT.md`'s "Alarm ringing" section; issue #16).
 *
 * Owns both services because they share the same one watched field (`isAlarmVibrating`) and the
 * same "what do we do when it changes" logic (design.md, "The two HAP services") — one class
 * avoids splitting that logic across two files that would need to agree on the same rising-edge
 * definition.
 *
 * Follows `ThermostatService`'s established shape: per-service `setProps` at construction, a B1
 * initial-publish call from the constructor, an accept-then-revert timer for the dismiss switch's
 * on-write (reusing `ThermostatService`'s named delay/pattern), and a `platformStartedAt`-based
 * No-Response escalation predicate on the dismiss switch's `onGet`.
 */

import type { Service } from 'homebridge';

import { AwayModeBlockedError } from '../pod/awayModeGuard.ts';
import type { Change, TimerHandle } from '../pod/snapshot.ts';
import type { Side } from '../pod/types.ts';
import type { ServiceContext } from './types.ts';

export const ALARM_PRESS_SUBTYPE = 'alarm-press';
export const ALARM_DISMISS_SUBTYPE = 'alarm-dismiss';

/** Mirrors `ThermostatService`'s `AWAY_MODE_BLOCKED_REVERT_DELAY_MS` — issue #16's own "~500 ms"
 * accept-then-revert for the dismiss switch's on-write, and the same delay a `block`-refused
 * write reverts after. */
const DISMISS_REVERT_DELAY_MS = 500;

/** The single `Change` variant this service watches — `SideChange<'isAlarmVibrating', boolean>`
 * (`src/pod/snapshot.ts`). */
type AlarmVibratingChange = Extract<Change, { field: 'isAlarmVibrating' }>;

/** Whether a snapshot `Change` is the one field `AlarmService.handleChange` watches (design.md's
 * routing table; mirrors `thermostat.ts`'s `isThermostatChange`/`occupancy.ts`'s
 * `isOccupancyChange`). */
export function isAlarmChange(change: Change): change is AlarmVibratingChange {
  return change.scope === 'side' && change.field === 'isAlarmVibrating';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AlarmService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly platformStartedAt: number;
  private readonly pressService: Service;
  private readonly dismissService: Service;

  /** The dismiss switch's own last-pushed `On` value — mirrors `ThermostatService`'s shadow
   * pattern so `refresh`/`handleChange` only ever pushes on an actual change. */
  private publishedOn: boolean | undefined;
  /** The pending accept-then-revert timer, if any — retained (mirrors `ThermostatService`'s F2
   * fix) so `stop()` can clear it on platform shutdown. */
  private revertTimer: TimerHandle | null = null;
  /**
   * B2 (alarm-events PR #45 review): `true` for as long as *this service's own* off-write to
   * `isAlarmVibrating` might still be the reason `change.previous === false` in `handleChange`,
   * rather than a genuine prior "not vibrating" observation — see `handleChange`'s doc for why
   * that distinction matters. Set the moment a dismiss write is submitted; cleared the moment
   * the overlay it installed is known to be gone (a failed POST clears it synchronously before
   * `submitSide` rejects) or, on success, after `writeSettleMs` — the overlay's own maximum
   * remaining lifetime once `submitSide` resolves (`writeQueue.ts`'s `settleWrite`/
   * `rebaseOwnership`: a successful dispatch re-arms the overlay for a fresh `writeSettleMs`
   * window measured from settle time, which is this exact moment).
   */
  private dismissOverlayGuardActive = false;
  /** The pending guard-clear timer for the success path above, if any — retained so `stop()` can
   * clear it, mirroring `revertTimer`. */
  private dismissOverlayGuardTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext, side: Side, platformStartedAt: number) {
    this.ctx = ctx;
    this.side = side;
    this.platformStartedAt = platformStartedAt;

    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existingPress = accessory.getServiceById(hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE);
    this.pressService =
      existingPress ??
      accessory.addService(new hap.Service.StatelessProgrammableSwitch(`${accessory.displayName} Alarm`, ALARM_PRESS_SUBTYPE));
    // Every setProps call happens before any value is set and before the accessory is
    // registered (mirrors ThermostatService's own construction-ordering discipline). HAP
    // explicitly exempts ProgrammableSwitchEvent from the setProps revalidation path (docs/
    // HOMEKIT.md), so this is safe the same way it is for every other button-shaped accessory.
    this.pressService.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent).setProps({
      validValues: [hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS],
    });
    // No onGet at all — this characteristic has no meaningful "current value" to serve; every
    // existing StatelessProgrammableSwitch implementation is push-only via updateValue.

    const existingDismiss = accessory.getServiceById(hap.Service.Switch, ALARM_DISMISS_SUBTYPE);
    this.dismissService =
      existingDismiss ?? accessory.addService(new hap.Service.Switch('Dismiss Alarm', ALARM_DISMISS_SUBTYPE));

    this.wireDismiss();

    // B1: seed the dismiss switch's initial state from whatever the bootstrap already observed,
    // without ever firing a press for it — a first observation of "already vibrating" means
    // "just started" is not knowable (alarm-events spec's "A pre-existing vibration observed at
    // startup fires no press"), so this calls the seed path directly rather than routing through
    // handleChange with a synthetic Change.
    this.publishDismissState(this.observedVibrating());
  }

  private observedVibrating(): boolean {
    return this.ctx.snapshot.get()[this.side].isAlarmVibrating ?? false;
  }

  // ---------------------------------------------------------------------------------------
  // No-Response escalation (mirrors ThermostatService.assertNotEscalated) — this service has no
  // fault/status channel of its own, so it follows the general policy.
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
  // Dismiss switch: reads and writes
  // ---------------------------------------------------------------------------------------

  private wireDismiss(): void {
    const hap = this.ctx.api.hap;
    const onChar = this.dismissService.getCharacteristic(hap.Characteristic.On);

    onChar.onGet(() => {
      this.assertNotEscalated();
      return this.observedVibrating();
    });

    onChar.onSet(async (rawValue) => {
      const value = Boolean(rawValue);
      // Claim the write into the shadow immediately — mirrors `ThermostatService.wireWrites`'s
      // "claim into the shadow before submitting" pattern. HAP's own `handleSetRequest` already
      // applies the incoming value to the characteristic optimistically before this handler
      // runs; without claiming it here too, `publishDismissState`'s "push only if it differs
      // from the last-published value" comparison would see no difference on the later revert
      // (the shadow would still say the pre-write value) and silently suppress the very
      // correction the revert exists to make.
      this.publishedOn = value;

      if (value) {
        // isAlarmVibrating: true is unsupported server-side (docs/POD-API.md: "`true` is
        // unsupported and logged as such") — never sent to the Pod. Accepted, then quietly
        // reverted to the actually-observed value (alarm-events spec's "Turning the dismiss
        // switch on is accepted and reverted, never sent to the Pod").
        this.scheduleRevert();
        return;
      }
      // B2: armed *before* `submitSide` is even called — `WriteQueue.submitSide` installs its
      // optimistic overlay synchronously, inside this very call, before it returns a pending
      // Promise (`writeQueue.ts`'s `submit()`: the overlay-sync call happens inside the
      // executor, which runs synchronously as part of constructing the `Promise` `submitSide`
      // returns) — so the guard must already be active for the falling-edge `handleChange` call
      // that install triggers, and for any rising edge that follows it before this `await`
      // settles.
      this.armDismissOverlayGuard();
      try {
        await this.ctx.writeQueue.submitSide(this.side, { isAlarmVibrating: false });
        // Success: the overlay was just rebased with a fresh `writeSettleMs` window (see the
        // guard field's own doc) — keep guarding until that window has had its full chance to
        // either retire by agreement (silently, no `handleChange` call at all — the common case)
        // or expire with `raw` still disagreeing (the B2 bug this guard exists for).
        if (this.dismissOverlayGuardTimer !== null) this.ctx.timers.clearTimeout(this.dismissOverlayGuardTimer);
        this.dismissOverlayGuardTimer = this.ctx.timers.setTimeout(() => {
          this.dismissOverlayGuardTimer = null;
          this.dismissOverlayGuardActive = false;
        }, this.ctx.config.writeSettleMs);
      } catch (error) {
        // Failure: `WriteQueue` already cleared the overlay synchronously before this rejection
        // (`writeQueue.ts`'s `settleWrite`, `onFailure: 'clear'`) — `raw` is already fully
        // revealed, so there is nothing further left to guard against.
        this.clearDismissOverlayGuard();
        if (error instanceof AwayModeBlockedError) {
          this.ctx.log.debug(
            `FreeSleep: ${this.side} dismiss-alarm write refused by the away-mode guard: ${describeError(error)}`,
          );
          this.scheduleRevert();
          throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        this.ctx.log.debug(`FreeSleep: ${this.side} dismiss-alarm write failed: ${describeError(error)}`);
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
  }

  private armDismissOverlayGuard(): void {
    if (this.dismissOverlayGuardTimer !== null) {
      this.ctx.timers.clearTimeout(this.dismissOverlayGuardTimer);
      this.dismissOverlayGuardTimer = null;
    }
    this.dismissOverlayGuardActive = true;
  }

  private clearDismissOverlayGuard(): void {
    if (this.dismissOverlayGuardTimer !== null) {
      this.ctx.timers.clearTimeout(this.dismissOverlayGuardTimer);
      this.dismissOverlayGuardTimer = null;
    }
    this.dismissOverlayGuardActive = false;
  }

  private scheduleRevert(): void {
    if (this.revertTimer !== null) {
      this.ctx.timers.clearTimeout(this.revertTimer);
    }
    this.revertTimer = this.ctx.timers.setTimeout(() => {
      this.revertTimer = null;
      this.publishDismissState(this.observedVibrating());
    }, DISMISS_REVERT_DELAY_MS);
  }

  private publishDismissState(value: boolean): void {
    if (this.publishedOn === value) return;
    this.publishedOn = value;
    const hap = this.ctx.api.hap;
    this.dismissService.getCharacteristic(hap.Characteristic.On).updateValue(value);
  }

  // ---------------------------------------------------------------------------------------
  // Push (platform routes snapshot change events here — design.md's routing table)
  // ---------------------------------------------------------------------------------------

  /**
   * (a) pushes the dismiss switch's `On` characteristic to `change.current` whenever it differs
   * from the currently-published value, and (b) additionally fires `SINGLE_PRESS` on the press
   * service iff `change.previous === false && change.current === true` — a rising edge, UNLESS
   * `dismissOverlayGuardActive` (B2 fix, below). Evaluated from the `Change` object the
   * platform's routing table hands this service directly, not re-derived from `snapshot.get()`,
   * which only has "now," not "a moment ago."
   *
   * **B2 (alarm-events PR #45 review):** `change.previous`/`.current` are diffed off the
   * *effective* (overlay-applied) snapshot (`snapshot.ts`'s `diffWatched`), not off raw
   * observations — so this service's own dismiss write can manufacture a `false` it never
   * actually observed from the Pod: submitting `{isAlarmVibrating: false}` installs an overlay
   * that forces `effective` to `false` immediately, *before* the Pod has confirmed anything. If
   * that overlay later goes away while `raw` still disagrees (a failed POST, whose overlay is
   * cleared synchronously on rejection; or a successful POST whose `writeSettleMs` window
   * expires before any poll ever confirmed the dismissal), `effective` snaps back to `true` —
   * a `false -> true` transition this service did not cause and the Pod never actually reported,
   * which without this guard reads as a second, spurious alarm press.
   *
   * Two fixes were on the table (reviewer's review comment): gate on *raw* observation diffs
   * instead of effective ones, or suppress a rising edge whose `false` half was manufactured by
   * this service's own overlay. The first would need this service to track `documents.
   * deviceStatus[side].isAlarmVibrating` independently, and that tracking itself has a gap: `raw`
   * can silently catch up to the overlay (`retireAgreedOverlaysAgainstRaw`) without ever
   * producing a `Change` at all, since `effective` doesn't move when it does — so nothing would
   * ever tell this service the guard could safely disarm again, permanently suppressing every
   * later, genuine press. This fix takes the second option instead: the service itself always
   * knows exactly when it starts a dismiss write and (bounded by `writeSettleMs`) how long its
   * own overlay could still be masking `raw` afterward, which sidesteps that gap entirely.
   */
  handleChange(change: AlarmVibratingChange): void {
    this.publishDismissState(change.current);
    if (change.previous === false && change.current === true) {
      if (this.dismissOverlayGuardActive) return;
      const hap = this.ctx.api.hap;
      this.pressService
        .getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
        .updateValue(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }
  }

  /** Clears any pending accept-then-revert timer — wired into the platform's `shutdown` teardown
   * alongside `thermostat.stop()`. Also clears the B2 dismiss-overlay guard's own timer. */
  stop(): void {
    if (this.revertTimer !== null) {
      this.ctx.timers.clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    this.clearDismissOverlayGuard();
  }
}
