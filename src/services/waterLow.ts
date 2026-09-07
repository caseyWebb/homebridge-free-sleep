/**
 * The hub's "Pod Water Low" water-level sensor (specs/hub-accessory/spec.md's water-low
 * requirements; `hub-accessory`'s design.md Decision 1).
 *
 * Published unconditionally, whenever the hub exists — mirroring `connection.ts`'s own always-on
 * precedent — as either a `ContactSensor` (default) or a `LeakSensor`, chosen by
 * `ctx.config.waterLowSensorType`. Both service types share one derivation:
 * `interpretWaterLevel`'s `'ok'`/`'low'` maps directly to each service's own "good"/"bad"
 * polarity (contact detected / leak not detected = good, matching `connection.ts`'s "the good
 * state" convention); `'unknown'` holds whichever of the two the sensor last reported and raises
 * `StatusFault` instead of assuming `'low'` — the read schema's own leniency rationale
 * (`src/pod/types.ts`) applied to what this service does with an unrecognized reading.
 */

import type { Characteristic, Service, WithUUID } from 'homebridge';

import { CONFIGURED_NAME, seedConfiguredName } from './serviceName.ts';
import type { ServiceContext } from './types.ts';

export const WATER_LOW_SUBTYPE = 'waterLow';
export const POD_WATER_LOW_NAME = 'Pod Water Low';

/** Adds `ctor` to `service` only if it is not already present — mirrors `connection.ts`'s own
 * helper (`Service.addCharacteristic` throws on a UUID that already exists). */
function ensureCharacteristic(service: Service, ctor: WithUUID<typeof Characteristic>): void {
  if (!service.testCharacteristic(ctor)) {
    service.addCharacteristic(ctor);
  }
}

export class WaterLowService {
  private readonly ctx: ServiceContext;
  private readonly service: Service;
  private readonly sensorType: 'contact' | 'leak';
  /**
   * Held across an `'unknown'` observation (spec's "continue reporting whichever of those two it
   * last reported") and updated on every `'ok'`/`'low'` one. Defaults to `'ok'` so a launch that
   * observes `'unknown'` before ever observing a real reading does not report a low-water alarm
   * with no evidence for one.
   */
  private lastKnown: 'ok' | 'low' = 'ok';

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;
    this.sensorType = ctx.config.waterLowSensorType;

    const ServiceCtor = this.sensorType === 'leak' ? hap.Service.LeakSensor : hap.Service.ContactSensor;
    const existing = accessory.getServiceById(ServiceCtor, WATER_LOW_SUBTYPE);
    this.service = existing ?? accessory.addService(new ServiceCtor(POD_WATER_LOW_NAME, WATER_LOW_SUBTYPE));
    seedConfiguredName(this.service, hap, CONFIGURED_NAME.waterLevel);

    ensureCharacteristic(this.service, hap.Characteristic.StatusFault);

    this.wireReads();

    // B1 pattern (every other service in this plugin): publish whatever the bootstrap already
    // observed before this service is registered.
    this.refresh();
  }

  private wireReads(): void {
    const hap = this.ctx.api.hap;
    this.stateCharacteristic().onGet(() => this.stateValue());
    this.service.getCharacteristic(hap.Characteristic.StatusFault).onGet(() => this.faultState());
  }

  private stateCharacteristic(): Characteristic {
    const hap = this.ctx.api.hap;
    return this.sensorType === 'leak'
      ? this.service.getCharacteristic(hap.Characteristic.LeakDetected)
      : this.service.getCharacteristic(hap.Characteristic.ContactSensorState);
  }

  /**
   * Reads the current effective water level, updating `lastKnown` on every `'ok'`/`'low'`
   * observation and holding it across an `'unknown'` one (or one that has never happened yet —
   * `waterLevelState` is `undefined` before the first `deviceStatus` observation, treated
   * identically to `'unknown'` since there is no data either way).
   */
  private currentLevel(): 'ok' | 'low' {
    const level = this.ctx.snapshot.get().waterLevelState;
    if (level === 'ok' || level === 'low') {
      this.lastKnown = level;
    }
    return this.lastKnown;
  }

  private isUnknown(): boolean {
    return this.ctx.snapshot.get().waterLevelState === 'unknown';
  }

  private stateValue(): number {
    const hap = this.ctx.api.hap;
    const adequate = this.currentLevel() === 'ok';
    if (this.sensorType === 'leak') {
      return adequate
        ? hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED
        : hap.Characteristic.LeakDetected.LEAK_DETECTED;
    }
    return adequate
      ? hap.Characteristic.ContactSensorState.CONTACT_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  private faultState(): number {
    const hap = this.ctx.api.hap;
    return this.isUnknown() ? hap.Characteristic.StatusFault.GENERAL_FAULT : hap.Characteristic.StatusFault.NO_FAULT;
  }

  /** Called by the platform whenever a `waterLevelState` change event fires. */
  refresh(): void {
    const hap = this.ctx.api.hap;
    this.pushIfChanged(this.stateCharacteristic(), this.stateValue());
    this.pushIfChanged(this.service.getCharacteristic(hap.Characteristic.StatusFault), this.faultState());
  }

  private pushIfChanged(characteristic: Characteristic, next: number): void {
    if (characteristic.value !== next) characteristic.updateValue(next);
  }
}
