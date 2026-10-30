/**
 * `SnoozeService` — the per-side momentary "Snooze" `Switch` (`wake-alarm-controls` change;
 * `specs/wake-alarm-controls/spec.md`). One press does what a snoozing sleeper wants from the
 * bed: stop the vibration and make the bed warmer (or cooler) so the next alarm lands in a
 * less comfortable bed. HomeKit scenes and Shortcuts "Control Home" actions can only set an
 * *absolute* thermostat target, so the relative bump has to live here, next to the data.
 *
 * Writing `On` submits ONE side patch through `writeQueue.submitSide`:
 *
 *   `{ isAlarmVibrating: false, isOn: true, targetTemperatureF: clamp(current + delta) }`
 *
 * - `isAlarmVibrating: false` is the same dismiss write the "Dismiss Alarm" switch makes
 *   (`server/src/routes/deviceStatus/updateDeviceStatus.ts`; on a Pod 3 it only stops the
 *   running vibration on free-sleep builds carrying the fix for upstream issue #54 — see
 *   `docs/POD-API.md`).
 * - `current` is the side's *effective* cached target (`snapshot.get()[side]
 *   .targetTemperatureF`, overlays included), so two quick presses stack: +10 then +10 again,
 *   never +10 twice from the same stale base. `delta` is `config.snoozeTemperatureDeltaF`.
 *   The result is clamped to the Pod's own 55-110°F (`clampTargetF`, `src/pod/temperature.ts`).
 * - `isOn: true` keeps the bump from being a silent no-op when the side has already timed out
 *   (upstream applies `TEMP_LEVEL_*` regardless of power state, but an off side does not heat);
 *   on an already-on side it merely re-arms upstream's 12-hour duration.
 *
 * One submission, but two requests on the wire: `WriteQueue.dispatch` peels `isAlarmVibrating`
 * out of any mixed side patch into its own guard-exempt write *before* `AwayModeGuard` is
 * consulted for the remainder (`writeQueue.ts`, the N8 peel from the `alarm-events` review). So
 * the dismiss always lands, and only the `{isOn, targetTemperatureF}` remainder is subject to
 * `awayModeWritePolicy`: under `'block'` with the partner side away the alarm still stops, the
 * temperature bump is refused, and the press surfaces as `NOT_ALLOWED_IN_CURRENT_STATE`.
 * Submitting two separate patches would behave identically — same-lane submissions inside one
 * debounce window coalesce into a single patch that the same peel then splits.
 *
 * If the snapshot has no target for this side yet (nothing observed since launch), the press
 * degrades to a plain dismiss and says so at `warn` rather than guessing a base temperature.
 *
 * The tile is momentary — pushed back to `false` after ~1s regardless of outcome, like the
 * "Wake Alarm" and "Test Alarm" switches. A failed write additionally surfaces to HomeKit:
 * `AwayModeBlockedError` → `NOT_ALLOWED_IN_CURRENT_STATE`, anything else →
 * `SERVICE_COMMUNICATION_FAILURE` (the same mapping `AlarmService`'s dismiss uses).
 */

import type { Service } from 'homebridge';

import { AwayModeBlockedError } from '../pod/awayModeGuard.ts';
import type { TimerHandle } from '../pod/snapshot.ts';
import { clampTargetF } from '../pod/temperature.ts';
import type { Side } from '../pod/types.ts';
import type { SidePatch } from '../pod/writeQueue.ts';
import { CONFIGURED_NAME, seedConfiguredName } from './serviceName.ts';
import type { ServiceContext } from './types.ts';

export const SNOOZE_SUBTYPE = 'snooze';

const SNOOZE_NAMES: Readonly<Record<Side, string>> = {
  left: 'Snooze Left',
  right: 'Snooze Right',
};

/** Same self-reset timeline as the "Wake Alarm" and "Test Alarm" switches. */
const RESET_DELAY_MS = 1000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The patch one Snooze press submits, given the side's current effective target (or
 * `undefined` when nothing has been observed yet) and the configured delta. Pure, so the
 * stacking and clamping behaviour is unit-testable without a service.
 */
export function snoozePatch(currentTargetF: number | undefined, deltaF: number): SidePatch {
  if (currentTargetF === undefined) return { isAlarmVibrating: false };
  return {
    isAlarmVibrating: false,
    isOn: true,
    targetTemperatureF: clampTargetF(Math.round(currentTargetF + deltaF)),
  };
}

export class SnoozeService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly service: Service;
  private resetTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext, side: Side) {
    this.ctx = ctx;
    this.side = side;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.Switch, SNOOZE_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Switch(SNOOZE_NAMES[side], SNOOZE_SUBTYPE));
    seedConfiguredName(this.service, hap, CONFIGURED_NAME.snooze);

    this.wireWrites();
  }

  private wireWrites(): void {
    const hap = this.ctx.api.hap;
    const onChar = this.service.getCharacteristic(hap.Characteristic.On);

    onChar.onSet(async (value) => {
      if (!value) return; // momentary — an explicit off write needs no action of its own
      this.scheduleReset();
      await this.snooze();
    });
  }

  private async snooze(): Promise<void> {
    const hap = this.ctx.api.hap;
    const current = this.ctx.snapshot.get()[this.side].targetTemperatureF;
    const patch = snoozePatch(current, this.ctx.config.snoozeTemperatureDeltaF);
    if (patch.targetTemperatureF === undefined) {
      this.ctx.log.warn(
        `FreeSleep: ${this.side} snooze has no cached target temperature to adjust from; dismissing the alarm only.`,
      );
    }
    try {
      await this.ctx.writeQueue.submitSide(this.side, patch);
    } catch (error) {
      if (error instanceof AwayModeBlockedError) {
        this.ctx.log.debug(`FreeSleep: ${this.side} snooze refused by the away-mode guard: ${describeError(error)}`);
        throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      }
      this.ctx.log.warn(`FreeSleep: ${this.side} snooze write failed: ${describeError(error)}`);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private scheduleReset(): void {
    if (this.resetTimer !== null) {
      this.ctx.timers.clearTimeout(this.resetTimer);
    }
    this.resetTimer = this.ctx.timers.setTimeout(() => {
      this.resetTimer = null;
      const hap = this.ctx.api.hap;
      this.service.getCharacteristic(hap.Characteristic.On).updateValue(false);
    }, RESET_DELAY_MS);
  }

  /** Clears any pending self-reset timer — wired into the platform's `shutdown` teardown. */
  stop(): void {
    if (this.resetTimer !== null) {
      this.ctx.timers.clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}
