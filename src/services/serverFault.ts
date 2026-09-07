/**
 * The hub's "Pod Server Fault" `ContactSensor` (specs/hub-accessory/spec.md's server-fault
 * requirements; `hub-accessory`'s design.md Decision 7). Config-gated
 * (`ctx.config.serverFaultSensor`, default `false`).
 *
 * Follows `connection.ts`'s own two-axis precedent, applied to a different endpoint class:
 * `ContactSensorState` is the **payload** signal (`snapshot.get().serverFault` — "any subsystem
 * in the last successfully observed `serverStatus` reports `'failed'`"), `StatusFault` is the
 * **reachability** signal for the `serverStatus` poll specifically
 * (`snapshot.get().serverStatusConnection`, tracked independently of `connection`), and
 * `StatusActive` mirrors `connection.ts`'s own "false until first success, sticky true after".
 * These two axes are independent: a failing `serverStatus` poll leaves `ContactSensorState` at
 * its last known value while `StatusFault` signals that value may be stale.
 */

import type { Characteristic, Service, WithUUID } from 'homebridge';

import { CONFIGURED_NAME, seedConfiguredName } from './serviceName.ts';
import type { ServiceContext } from './types.ts';

export const SERVER_FAULT_SUBTYPE = 'serverFault';
export const POD_SERVER_FAULT_NAME = 'Pod Server Fault';

/** Adds `ctor` to `service` only if it is not already present — mirrors `connection.ts`'s own
 * helper. */
function ensureCharacteristic(service: Service, ctor: WithUUID<typeof Characteristic>): void {
  if (!service.testCharacteristic(ctor)) {
    service.addCharacteristic(ctor);
  }
}

export class ServerFaultService {
  private readonly ctx: ServiceContext;
  private readonly service: Service;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.ContactSensor, SERVER_FAULT_SUBTYPE);
    this.service =
      existing ?? accessory.addService(new hap.Service.ContactSensor(POD_SERVER_FAULT_NAME, SERVER_FAULT_SUBTYPE));
    seedConfiguredName(this.service, hap, CONFIGURED_NAME.serverFault);

    ensureCharacteristic(this.service, hap.Characteristic.StatusFault);
    ensureCharacteristic(this.service, hap.Characteristic.StatusActive);

    this.wireReads();

    // B1 pattern (every other service in this plugin): publish whatever the bootstrap already
    // observed before this service is registered.
    this.refresh();
  }

  private wireReads(): void {
    const hap = this.ctx.api.hap;
    this.service.getCharacteristic(hap.Characteristic.ContactSensorState).onGet(() => this.contactState());
    this.service.getCharacteristic(hap.Characteristic.StatusFault).onGet(() => this.faultState());
    this.service.getCharacteristic(hap.Characteristic.StatusActive).onGet(() => this.activeState());
  }

  /** `CONTACT_DETECTED` ("closed") is the good state — no subsystem currently reports failed —
   * matching `connection.ts`'s own polarity convention. */
  private contactState(): number {
    const hap = this.ctx.api.hap;
    return this.ctx.snapshot.get().serverFault
      ? hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  private faultState(): number {
    const hap = this.ctx.api.hap;
    return this.ctx.snapshot.get().serverStatusConnection.online
      ? hap.Characteristic.StatusFault.NO_FAULT
      : hap.Characteristic.StatusFault.GENERAL_FAULT;
  }

  private activeState(): boolean {
    return this.ctx.snapshot.get().serverStatusConnection.lastSuccessAt !== null;
  }

  /** Called by the platform whenever a `serverFault` change event fires. */
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
