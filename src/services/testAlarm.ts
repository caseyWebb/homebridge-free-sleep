/**
 * The hub's per-side "Test Alarm" momentary `Switch`es — "Test Alarm Left" and "Test Alarm
 * Right" (specs/hub-accessory/spec.md's test-alarm requirements; `hub-accessory`'s design.md
 * Decision 6, as narrowed by the PR #44 tech-lead ruling below). Config-gated
 * (`ctx.config.testAlarmSwitch`, default `false`) — one boolean still gates *both* switches;
 * only the trigger's own target side changed.
 *
 * **G0 (tech-lead ruling, PR #44 review):** the original design shipped a single hub-level
 * switch that triggered **both** sides at once. A hub accessory is not scoped to either sleeper,
 * so a single "test alarm" control risked vibrating a sleeping partner's side as a side effect of
 * testing the other — a real, physical harm a config toggle cannot mitigate. Split into two
 * independent, per-side switches, each carrying its own subtype and firing `postAlarm` for its
 * own side only; the momentary self-reset and no-retry mechanics below are unchanged, just
 * parameterized by `side`.
 *
 * Writing `On` calls `PodClient.postAlarm` — with `force: true` (required: `executeAlarm`
 * silently no-ops an off/away side without it, design.md's Context) and a fixed, short
 * `vibrationIntensity`/`vibrationPattern`/`duration` this service itself chooses, never exposed
 * as characteristics (design.md: "'Test Alarm' is a single momentary trigger, not a configurable
 * one"). A failure never changes the tile's own reset timing.
 *
 * Regardless of the write's outcome (success, failure, or still outstanding), the switch's own
 * `On` characteristic is pushed back to `false` after ~1s (issue #20's own "self-reset after
 * ~1s", design.md's Decision 6) — deliberately decoupled from whether the alarm actually fired,
 * since upstream's own vibration genuinely outlasts this by an order of magnitude and there is no
 * reliable synchronous signal to wait for instead.
 *
 * `PodClient.postAlarm` itself never retries a failed attempt (design.md's Decision 6) — a
 * second attempt landing while the first's effect is still in progress risks a double-fire; this
 * service does not paper over that with a retry of its own. (N4, PR #44 review: this also means a
 * rejected `postAlarm` call is swallowed — logged at `debug` and nothing else — so from HomeKit's
 * perspective the write always "succeeds"; see docs/HOMEKIT.md's alarm row.)
 */

import type { Service } from 'homebridge';

import type { TimerHandle } from '../pod/snapshot.ts';
import type { AlarmRequest, Side } from '../pod/types.ts';
import { seedConfiguredName, TEST_ALARM_CONFIGURED_NAME } from './serviceName.ts';
import type { ServiceContext } from './types.ts';

/** Per-side subtypes — distinct HAP services, each independently restorable/prunable. */
export const TEST_ALARM_LEFT_SUBTYPE = 'testAlarmLeft';
export const TEST_ALARM_RIGHT_SUBTYPE = 'testAlarmRight';

export const TEST_ALARM_SUBTYPES: Readonly<Record<Side, string>> = {
  left: TEST_ALARM_LEFT_SUBTYPE,
  right: TEST_ALARM_RIGHT_SUBTYPE,
};

/** The pre-existing `Name` convention for these two switches (design.md's own note: the
 * `ConfiguredName` default for this pair is "already fully-formed", i.e. identical to this).
 * Defined in terms of the already-imported `TEST_ALARM_CONFIGURED_NAME` rather than duplicating
 * its literal strings — this module already depends on `./serviceName.ts` for
 * `seedConfiguredName`, so aliasing here (rather than having `serviceName.ts` import back from
 * this module) keeps that a one-directional dependency instead of a module cycle. Exported for
 * any caller that wants the `Name`-convention value specifically. */
export const TEST_ALARM_NAMES: Readonly<Record<Side, string>> = TEST_ALARM_CONFIGURED_NAME;

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TestAlarmService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly service: Service;
  /** The pending self-reset timer, if any — retained so `stop()` can clear it on shutdown. */
  private resetTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext, side: Side) {
    this.ctx = ctx;
    this.side = side;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;
    const subtype = TEST_ALARM_SUBTYPES[side];

    const existing = accessory.getServiceById(hap.Service.Switch, subtype);
    this.service = existing ?? accessory.addService(new hap.Service.Switch(TEST_ALARM_NAMES[side], subtype));
    seedConfiguredName(this.service, hap, TEST_ALARM_CONFIGURED_NAME[side]);

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
    this.ctx.podClient.postAlarm({ side: this.side, ...TRIGGER_PARAMS }).catch((error: unknown) => {
      this.ctx.log.debug(`FreeSleep: test-alarm trigger for ${this.side} failed: ${describeError(error)}`);
    });
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
