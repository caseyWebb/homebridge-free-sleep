/**
 * `WakeAlarmService` — the per-side momentary "Wake Alarm" `Switch` (`wake-alarm-controls`
 * change; `specs/wake-alarm-controls/spec.md`). Lives on the side accessory, next to that
 * side's Thermostat, alarm event and "Dismiss Alarm" switch, so a Home/Shortcuts automation
 * ("When my wake-up alarm goes off") can start the bed's own vibration alarm for one sleeper
 * with a single accessory action — no HTTP call to the Pod from the phone.
 *
 * Writing `On` calls `PodClient.postAlarm` for this side with the configured
 * `config.wakeAlarm` parameters and `force: true` (required — `executeAlarm` silently no-ops an
 * off or away side without it, `server/src/jobs/alarmScheduler.ts`). Unlike the hub's "Test
 * Alarm" switch, whose parameters are fixed and whose failure is swallowed, this switch's
 * parameters come from config (it is a real alarm, not a probe) and a rejected `postAlarm`
 * surfaces to HomeKit as `SERVICE_COMMUNICATION_FAILURE` so an automation built on it can
 * tell that the alarm never reached the Pod.
 *
 * The tile is momentary: its own `On` is pushed back to `false` after ~1s regardless of the
 * request's outcome (the same self-reset the "Test Alarm" switch uses), because the vibration
 * itself is tracked separately — by the side's "Dismiss Alarm" switch, which turns on once the
 * poller observes `isAlarmVibrating`. `PodClient.postAlarm` never retries (a second attempt
 * landing while the first is in progress would re-fire the alarm), and neither does this
 * service.
 */

import type { Service } from 'homebridge';

import type { TimerHandle } from '../pod/snapshot.ts';
import type { Side } from '../pod/types.ts';
import { CONFIGURED_NAME, seedConfiguredName } from './serviceName.ts';
import type { ServiceContext } from './types.ts';

export const WAKE_ALARM_SUBTYPE = 'wakeAlarm';

const WAKE_ALARM_NAMES: Readonly<Record<Side, string>> = {
  left: 'Wake Alarm Left',
  right: 'Wake Alarm Right',
};

/** Same self-reset timeline as the hub's "Test Alarm" switch. */
const RESET_DELAY_MS = 1000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WakeAlarmService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly service: Service;
  private resetTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext, side: Side) {
    this.ctx = ctx;
    this.side = side;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.Switch, WAKE_ALARM_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Switch(WAKE_ALARM_NAMES[side], WAKE_ALARM_SUBTYPE));
    seedConfiguredName(this.service, hap, CONFIGURED_NAME.wakeAlarm);

    this.wireWrites();
  }

  private wireWrites(): void {
    const hap = this.ctx.api.hap;
    const onChar = this.service.getCharacteristic(hap.Characteristic.On);

    onChar.onSet(async (value) => {
      if (!value) return; // momentary — an explicit off write needs no action of its own
      this.scheduleReset();
      await this.trigger();
    });
  }

  private async trigger(): Promise<void> {
    const hap = this.ctx.api.hap;
    const { duration, vibrationIntensity, vibrationPattern } = this.ctx.config.wakeAlarm;
    try {
      await this.ctx.podClient.postAlarm({
        side: this.side,
        duration,
        vibrationIntensity,
        vibrationPattern,
        force: true,
      });
    } catch (error) {
      this.ctx.log.warn(`FreeSleep: ${this.side} wake-alarm trigger failed: ${describeError(error)}`);
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
