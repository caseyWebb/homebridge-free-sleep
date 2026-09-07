/**
 * The hub's "Pod Test Alarm" momentary `Switch` (specs/hub-accessory/spec.md's test-alarm
 * requirements; `hub-accessory`'s design.md Decision 6). Config-gated
 * (`ctx.config.testAlarmSwitch`, default `false`).
 *
 * Writing `On` calls `PodClient.postAlarm` — with `force: true` (required: `executeAlarm`
 * silently no-ops an off/away side without it, design.md's Context) and a fixed, short
 * `vibrationIntensity`/`vibrationPattern`/`duration` this service itself chooses, never exposed
 * as characteristics (design.md: "'Test Alarm' is a single momentary trigger, not a configurable
 * one"). Deliberately targets **both** sides: the switch lives on the hub, not tied to either
 * side, and the point of a manual test trigger is confirming the physical alarm actually fires —
 * which either side alone would not fully prove. A failure triggering one side never blocks the
 * other, and neither outcome changes the tile's own reset timing.
 *
 * Regardless of the write's outcome (success, failure, or still outstanding), the switch's own
 * `On` characteristic is pushed back to `false` after ~1s (issue #20's own "self-reset after
 * ~1s", design.md's Decision 6) — deliberately decoupled from whether the alarm actually fired,
 * since upstream's own vibration genuinely outlasts this by an order of magnitude and there is no
 * reliable synchronous signal to wait for instead.
 *
 * `PodClient.postAlarm` itself never retries a failed attempt (design.md's Decision 6) — a
 * second attempt landing while the first's effect is still in progress risks a double-fire; this
 * service does not paper over that with a retry of its own.
 */

import type { Service } from 'homebridge';

import type { TimerHandle } from '../pod/snapshot.ts';
import type { AlarmRequest, Side } from '../pod/types.ts';
import type { ServiceContext } from './types.ts';

export const TEST_ALARM_SUBTYPE = 'testAlarm';
export const POD_TEST_ALARM_NAME = 'Pod Test Alarm';

/** Issue #20's own "self-reset after ~1s" (design.md's Decision 6). */
const RESET_DELAY_MS = 1000;

/**
 * Fixed trigger parameters — never exposed as characteristics (design.md's Decision 6). A
 * short, non-zero duration (upstream clamps the actual vibration to at least 10 real seconds
 * regardless — `Math.max(10, duration) * 1000`ms, design.md's Context) and a mid-range intensity:
 * loud enough to be an unambiguous manual test without being upstream's maximum.
 */
const TRIGGER_PARAMS: Omit<AlarmRequest, 'side'> = {
  vibrationIntensity: 60,
  vibrationPattern: 'double',
  duration: 10,
  force: true,
};

const SIDES: readonly Side[] = ['left', 'right'];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TestAlarmService {
  private readonly ctx: ServiceContext;
  private readonly service: Service;
  /** The pending self-reset timer, if any — retained so `stop()` can clear it on shutdown. */
  private resetTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.Switch, TEST_ALARM_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Switch(POD_TEST_ALARM_NAME, TEST_ALARM_SUBTYPE));

    this.wireWrites();
  }

  private wireWrites(): void {
    const hap = this.ctx.api.hap;
    const onChar = this.service.getCharacteristic(hap.Characteristic.On);

    onChar.onSet((value) => {
      if (!value) return; // momentary — an explicit off write needs no action of its own
      this.trigger();
    });
  }

  private trigger(): void {
    for (const side of SIDES) {
      this.ctx.podClient.postAlarm({ side, ...TRIGGER_PARAMS }).catch((error: unknown) => {
        this.ctx.log.debug(`FreeSleep: test-alarm trigger for ${side} failed: ${describeError(error)}`);
      });
    }
    this.scheduleReset();
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
