/**
 * The hub's "Pod Connection" `ContactSensor` (specs/connection-status/spec.md, design.md's
 * "Connection sensor polarity: online is 'contact detected'").
 *
 * `ContactSensorState.CONTACT_DETECTED` while reachable, `CONTACT_NOT_DETECTED` while not — the
 * Home app renders these as "Closed"/"Open", so an outage reads as "Pod Connection — Open" and
 * the natural automation trigger ("when Pod Connection opens") fires on going offline
 * (design.md, tech-lead resolution 2, locked).
 *
 * `StatusFault`/`StatusActive` are added explicitly — `ContactSensor`'s required characteristic
 * is only `ContactSensorState`; both status characteristics are declared *optional* by HAP and
 * are never auto-added (specs/connection-status/spec.md, "Status characteristics are carried
 * only by services that declare them"). `StatusActive` stays `true` once observed, even during
 * a later outage — `StatusFault` carries the outage signal (design.md, tech-lead resolution 3).
 *
 * Deliberately never escalates to a throwing `onGet`: unlike the thermostat, this service *is*
 * the outage's data channel (design.md, "The outage is data"), so degrading its own
 * characteristics is the whole point — there is no better fallback to escalate to.
 */

import type { Characteristic, Service, WithUUID } from 'homebridge';

import type { ServiceContext } from './types.ts';

export const CONNECTION_SUBTYPE = 'connection';
export const POD_CONNECTION_NAME = 'Pod Connection';

/** Adds `ctor` to `service` only if it is not already present — `Service.addCharacteristic`
 * throws on a UUID that already exists, which a restored service (or a repeat call across a
 * warm restart in tests) would otherwise hit. */
function ensureCharacteristic(service: Service, ctor: WithUUID<typeof Characteristic>): void {
  if (!service.testCharacteristic(ctor)) {
    service.addCharacteristic(ctor);
  }
}

export class ConnectionService {
  private readonly ctx: ServiceContext;
  private readonly service: Service;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.ContactSensor, CONNECTION_SUBTYPE);
    this.service =
      existing ?? accessory.addService(new hap.Service.ContactSensor(POD_CONNECTION_NAME, CONNECTION_SUBTYPE));

    ensureCharacteristic(this.service, hap.Characteristic.StatusFault);
    ensureCharacteristic(this.service, hap.Characteristic.StatusActive);

    this.wireReads();

    // B1: publish whatever the bootstrap already observed before this service is registered —
    // without this, every characteristic keeps HAP's own default (StatusActive false,
    // ContactSensorState CONTACT_NOT_DETECTED) until the next change event, and Homebridge can
    // persist that default forever if it never fires (e.g. a Pod that stays reachable all
    // launch). `refresh()` is idempotent and reads only `ctx.snapshot.get()`, so calling it here
    // is safe regardless of whether the bootstrap actually reached the Pod.
    this.refresh();
  }

  private wireReads(): void {
    const hap = this.ctx.api.hap;
    this.service.getCharacteristic(hap.Characteristic.ContactSensorState).onGet(() => this.contactState());
    this.service.getCharacteristic(hap.Characteristic.StatusFault).onGet(() => this.faultState());
    this.service.getCharacteristic(hap.Characteristic.StatusActive).onGet(() => this.activeState());
  }

  private contactState(): number {
    const hap = this.ctx.api.hap;
    return this.ctx.snapshot.get().connection.online
      ? hap.Characteristic.ContactSensorState.CONTACT_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  private faultState(): number {
    const hap = this.ctx.api.hap;
    return this.ctx.snapshot.get().connection.online
      ? hap.Characteristic.StatusFault.NO_FAULT
      : hap.Characteristic.StatusFault.GENERAL_FAULT;
  }

  private activeState(): boolean {
    return this.ctx.snapshot.get().connection.lastSuccessAt !== null;
  }

  /** Called by the platform whenever a `connectionOnline` change event fires — the only field
   * this service watches (design.md's routing table). `lastSuccessAt` flips from `null` to
   * non-`null` at exactly the same moment `online` first turns `true`, so one event routing
   * catches `StatusActive`'s one-time transition too. */
  refresh(): void {
    const hap = this.ctx.api.hap;
    this.pushIfChanged(this.service.getCharacteristic(hap.Characteristic.ContactSensorState), this.contactState());
    this.pushIfChanged(this.service.getCharacteristic(hap.Characteristic.StatusFault), this.faultState());
    this.pushIfChanged(this.service.getCharacteristic(hap.Characteristic.StatusActive), this.activeState());
  }

  private pushIfChanged(characteristic: Characteristic, next: number | boolean): void {
    if (characteristic.value !== next) characteristic.updateValue(next);
  }
}
