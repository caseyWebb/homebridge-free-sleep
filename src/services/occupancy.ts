/**
 * The per-side `OccupancySensor` (occupancy change, #19; specs/occupancy-sensor/spec.md).
 *
 * `occupancySource: 'presence' | 'vitals'` selects which pair of `SnapshotStore` fields this
 * service reads — `(presencePresent, presenceActive)` or `(vitalsOccupied, vitalsActive)`
 * (design.md, "`SnapshotStore` stores both sources' derived booleans unconditionally; the
 * service picks one"). `occupancySource: 'none'` never constructs this service at all
 * (`src/platform.ts`'s `enabledServiceKeysFor`/`constructServicesFor`), so no branch for it
 * exists here.
 *
 * `StatusActive` is the load-bearing characteristic: it distinguishes "this source has proven
 * it can tell the truth" from "this source has merely answered, which might be a stale
 * default" — the mechanism that keeps this sensor from being confidently, permanently wrong
 * (proposal.md's "Why"; docs/HOMEKIT.md's "Occupancy"). `OccupancyDetected` always reflects the
 * raw current value regardless of `StatusActive`, mirroring `ConnectionService`'s
 * `contactState()` reading `connection.online` unconditionally.
 *
 * Deliberately never escalates to a throwing `onGet`, exactly like `ConnectionService` and
 * unlike `ThermostatService`: per docs/HOMEKIT.md, `OccupancySensor` legally declares
 * `StatusActive`, which is this service's own "don't trust this" outlet — degrading it is the
 * complete, correct response to an unobserved source, an unproven source, or an unreachable
 * Pod (design.md, "`OccupancySensorService` never escalates to a throwing `onGet`"). No
 * `StatusFault` — issue #19 asks only for `StatusActive`, and docs/HOMEKIT.md's "Occupancy"
 * section never mentions a fault characteristic for this sensor.
 */

import type { Characteristic, Service, WithUUID } from 'homebridge';

import type { Change, EffectiveSideStatus } from '../pod/snapshot.ts';
import type { Side } from '../pod/types.ts';
import type { ServiceContext } from './types.ts';

export const OCCUPANCY_SUBTYPE = 'occupancy';

/** The four watched fields that, together, feed this service's `refresh()` (design.md's
 * routing table: any of them changing for a side routes to that side's occupancy sensor). */
const OCCUPANCY_WATCHED_FIELDS: ReadonlySet<string> = new Set([
  'presencePresent',
  'presenceActive',
  'vitalsOccupied',
  'vitalsActive',
]);

/** Adds `ctor` to `service` only if it is not already present — mirrors `ConnectionService`'s
 * own `ensureCharacteristic`, unchanged: `Service.addCharacteristic` throws on a UUID that
 * already exists, which a restored service would otherwise hit. */
function ensureCharacteristic(service: Service, ctor: WithUUID<typeof Characteristic>): void {
  if (!service.testCharacteristic(ctor)) {
    service.addCharacteristic(ctor);
  }
}

export class OccupancySensorService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly service: Service;

  constructor(ctx: ServiceContext, side: Side) {
    this.ctx = ctx;
    this.side = side;

    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE);
    this.service =
      existing ?? accessory.addService(new hap.Service.OccupancySensor(accessory.displayName, OCCUPANCY_SUBTYPE));

    ensureCharacteristic(this.service, hap.Characteristic.StatusActive);

    this.wireReads();

    // B1: publish whatever the bootstrap already observed before this service is registered —
    // without this, every characteristic keeps HAP's own default (OccupancyDetected NOT_
    // DETECTED, StatusActive false) until the next change event, which may never come this
    // launch (design.md's "quiet household" risk). `refresh()` is idempotent and reads only
    // `ctx.snapshot.get()`, so calling it here is safe regardless of what the bootstrap reached.
    this.refresh();
  }

  private currentSide(): EffectiveSideStatus {
    return this.ctx.snapshot.get()[this.side];
  }

  /** The configured source's `(occupied, active)` pair — `'none'` never constructs this
   * service, so only the two live sources are branched on here (design.md). */
  private sourceValues(side: EffectiveSideStatus): { occupied: boolean | undefined; active: boolean | undefined } {
    if (this.ctx.config.occupancySource === 'vitals') {
      return { occupied: side.vitalsOccupied, active: side.vitalsActive };
    }
    return { occupied: side.presencePresent, active: side.presenceActive };
  }

  private wireReads(): void {
    const hap = this.ctx.api.hap;
    const occupancyChar = this.service.getCharacteristic(hap.Characteristic.OccupancyDetected);
    const activeChar = this.service.getCharacteristic(hap.Characteristic.StatusActive);

    occupancyChar.onGet(() => this.occupancyValue());
    activeChar.onGet(() => this.activeValue());
  }

  private occupancyValue(): number {
    const hap = this.ctx.api.hap;
    const { occupied } = this.sourceValues(this.currentSide());
    if (occupied === undefined) {
      return this.service.getCharacteristic(hap.Characteristic.OccupancyDetected).value as number;
    }
    return occupied
      ? hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private activeValue(): boolean {
    return this.sourceValues(this.currentSide()).active === true;
  }

  /** Called by the platform whenever a watched occupancy field changes for this side
   * (design.md's routing table; `isOccupancyChange` below). Pushes only on an actual change —
   * the same `pushIfChanged` pattern `ConnectionService` uses. */
  refresh(): void {
    const hap = this.ctx.api.hap;
    this.pushIfChanged(this.service.getCharacteristic(hap.Characteristic.OccupancyDetected), this.occupancyValue());
    this.pushIfChanged(this.service.getCharacteristic(hap.Characteristic.StatusActive), this.activeValue());
  }

  private pushIfChanged(characteristic: Characteristic, next: number | boolean): void {
    if (characteristic.value !== next) characteristic.updateValue(next);
  }
}

/** Whether a snapshot `Change` is one of the four fields that should trigger the affected
 * side's `OccupancySensorService.refresh()` (design.md's routing table). Mirrors
 * `isThermostatChange`'s shape exactly. */
export function isOccupancyChange(change: Change): change is Change & { scope: 'side'; side: Side } {
  return change.scope === 'side' && OCCUPANCY_WATCHED_FIELDS.has(change.field);
}
