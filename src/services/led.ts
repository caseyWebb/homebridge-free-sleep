/**
 * The hub's "Pod LED" `Lightbulb` (specs/hub-accessory/spec.md's LED requirements;
 * `hub-accessory`'s design.md Decision 5). Config-gated (`ctx.config.ledLightbulb`, default
 * `false`).
 *
 * Every write read-modify-writes the full four-key `settings` object (`v`, `gainLeft`,
 * `gainRight`, `ledBrightness`) — `updateSettings` CBOR-encodes exactly the keys it's given, so a
 * bare `{ledBrightness}` would silently drop the other three, corrupting biometrics gain settings
 * (design.md's Context and Decision 5). `On` and `Brightness` are treated as independently
 * arriving `onSet` calls (design.md's Open Question 1) — the device lane's own debounce/merge
 * (with its own, stricter `deviceWriteDebounceMs`) coalesces a same-window pair into one dispatch
 * regardless of which characteristic HAP calls first.
 *
 * No optimistic overlay (design.md's Decision 2, a deliberate, accepted trade-off): a write's own
 * tile settles once the device lane's confirming fast-poll lands, up to roughly
 * `fastPollIntervalMs` after dispatch.
 */

import type { Characteristic, HAP, Service } from 'homebridge';

import type { ServiceContext } from './types.ts';

export const LED_SUBTYPE = 'led';
export const POD_LED_NAME = 'Pod LED';

/** `accessory.context.lastNonZeroBrightness` — restored when `On` is written `true` with no
 * accompanying `Brightness` in the same write (design.md's Decision 5). */
interface LedContext {
  lastNonZeroBrightness?: number;
}

function contextOf(ctx: ServiceContext): LedContext {
  return ctx.accessory.context as LedContext;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LedService {
  private readonly ctx: ServiceContext;
  private readonly service: Service;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.Lightbulb, LED_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Lightbulb(POD_LED_NAME, LED_SUBTYPE));

    this.wireReadsAndWrites();

    // B1 pattern (every other service in this plugin): publish whatever the bootstrap already
    // observed before this service is registered. Not wired to a further snapshot change event —
    // `ledBrightness` is not among `pod-snapshot`'s watched fields (design.md's Decision 2) — so
    // this only ever runs the once, here.
    this.refresh();
  }

  private currentSettings() {
    return this.ctx.snapshot.get().documents.deviceStatus?.settings;
  }

  private currentBrightness(): number | undefined {
    return this.currentSettings()?.ledBrightness;
  }

  private wireReadsAndWrites(): void {
    const hap = this.ctx.api.hap;
    const onChar = this.service.getCharacteristic(hap.Characteristic.On);
    const brightnessChar = this.service.getCharacteristic(hap.Characteristic.Brightness);

    onChar.onGet(() => {
      const brightness = this.currentBrightness();
      if (brightness === undefined) return onChar.value as boolean;
      return brightness > 0;
    });

    brightnessChar.onGet(() => {
      const brightness = this.currentBrightness();
      if (brightness === undefined) return brightnessChar.value as number;
      return brightness;
    });

    onChar.onSet(async (value) => {
      const target = value ? contextOf(this.ctx).lastNonZeroBrightness ?? 100 : 0;
      await this.submitBrightness(target, hap);
    });

    brightnessChar.onSet(async (value) => {
      await this.submitBrightness(value as number, hap);
    });
  }

  /**
   * Reads the full, currently-cached `settings` object and submits a new one with only
   * `ledBrightness` replaced — design.md's Decision 5's "clone current, merge, post whole" shape.
   * Refuses with `SERVICE_COMMUNICATION_FAILURE` rather than guessing the other three fields when
   * no `deviceStatus` has ever been observed yet (a brand-new launch racing the bootstrap poll).
   */
  private async submitBrightness(target: number, hap: HAP): Promise<void> {
    const settings = this.currentSettings();
    if (!settings) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (target > 0) {
      contextOf(this.ctx).lastNonZeroBrightness = target;
    }
    try {
      await this.ctx.writeQueue.submitDeviceSettings({
        v: settings.v,
        gainLeft: settings.gainLeft,
        gainRight: settings.gainRight,
        ledBrightness: target,
      });
    } catch (error) {
      this.ctx.log.debug(`FreeSleep: LED write failed: ${describeError(error)}`);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Pushes whatever the bootstrap already observed. */
  refresh(): void {
    const brightness = this.currentBrightness();
    if (brightness === undefined) return;
    const hap = this.ctx.api.hap;
    const onChar: Characteristic = this.service.getCharacteristic(hap.Characteristic.On);
    const brightnessChar: Characteristic = this.service.getCharacteristic(hap.Characteristic.Brightness);
    const onValue = brightness > 0;
    if (onChar.value !== onValue) onChar.updateValue(onValue);
    if (brightnessChar.value !== brightness) brightnessChar.updateValue(brightness);
  }
}
