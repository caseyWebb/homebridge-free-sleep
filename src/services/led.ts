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
 * S4 (hub-accessory PR #44 review): this service itself only ever names the one field it is
 * actually changing (`ledBrightness`) — `WriteQueue.dispatch()`'s `device`-lane branch now does
 * the "read the other three, merge, post whole" part, backfilling from a `deviceStatus` read
 * refreshed immediately before dispatch, rather than this service reading (and thus pinning) the
 * cached `v`/`gainLeft`/`gainRight` back at submission time. This closes the bulk of what was a
 * `pollIntervalMs`-wide (default ~30s) staleness window in which an externally-changed gain
 * (e.g. edited directly in free-sleep's own web UI) could be clobbered back to its stale cached
 * value by an unrelated brightness write from this plugin. A small residual race remains — see
 * design.md's Decision 5 and README's `ledLightbulb` row — bounded by the pre-dispatch refresh's
 * own round trip rather than a full poll interval.
 *
 * No optimistic overlay (design.md's Decision 2, a deliberate, accepted trade-off): a write's own
 * tile settles once the device lane's confirming fast-poll lands, up to roughly
 * `fastPollIntervalMs` after dispatch.
 */

import type { Characteristic, HAP, Service } from 'homebridge';

import { CONFIGURED_NAME, seedConfiguredName } from './serviceName.ts';
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
    seedConfiguredName(this.service, hap, CONFIGURED_NAME.led);

    this.wireReadsAndWrites();

    // B1 pattern (every other service in this plugin): publish whatever the bootstrap already
    // observed before this service is registered. S2 fix (hub-accessory PR #44 review):
    // `ledBrightness` is now a watched `DeviceChangeField` (`src/pod/snapshot.ts`) and the
    // platform retains this instance and routes a `ledBrightness` change to `refresh()` — this
    // call is only the *first* push, not the only one, unlike before the fix.
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
   * Submits only the field this write actually changes — `WriteQueue.dispatch()`'s `device`-lane
   * branch performs the "clone current, merge, post whole" read-modify-write itself (S4 fix,
   * this module's doc), against a `deviceStatus` freshly re-read immediately before dispatch
   * rather than whatever this service last saw at submission time. Still refuses synchronously
   * with `SERVICE_COMMUNICATION_FAILURE` — before any submission at all — when no `deviceStatus`
   * has ever been observed yet (a brand-new launch racing the bootstrap poll): sending
   * `{ledBrightness}` alone in that state would have nothing to backfill the other three fields
   * from either, corrupting them exactly as design.md's Decision 5 warns against.
   */
  private async submitBrightness(target: number, hap: HAP): Promise<void> {
    if (!this.currentSettings()) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (target > 0) {
      contextOf(this.ctx).lastNonZeroBrightness = target;
    } else {
      // N3 fix (hub-accessory PR #44 review): before zeroing, seed `lastNonZeroBrightness` from
      // the currently-*observed* brightness (still the pre-write cached value at this point) —
      // the Pod's actual prior level — rather than leaving whatever this plugin itself last
      // happened to write (or never wrote at all). An off-write following an externally-changed
      // brightness (e.g. free-sleep's own web UI set it to 30) must restore that 30 on the next
      // on-write, not fall back to the plugin's own stale/absent `lastNonZeroBrightness`.
      const observed = this.currentBrightness();
      if (observed !== undefined && observed > 0) {
        contextOf(this.ctx).lastNonZeroBrightness = observed;
      }
    }
    try {
      await this.ctx.writeQueue.submitDeviceSettings({ ledBrightness: target });
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
