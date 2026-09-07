/**
 * Shared `ConfiguredName` seeding mechanism (design.md, Decision 1 and 2) and the unified
 * label convention (design.md, Decision 3 — OVERRIDDEN by the tech-lead resolution in
 * `openspec/changes/release-polish/design.md`: short labels everywhere, no accessory-name
 * prefix. Apple's service-naming guidance and the Home app's own per-accessory scoping make a
 * prefixed label like "Casey Away Mode" redundant and Siri-hostile — uniqueness matters within
 * an accessory, not globally, so every label below is the short, standalone form the tech lead
 * specified).
 *
 * `seedConfiguredName` is called once, immediately after `addService`/`getServiceById`, from
 * every service's own constructor (design.md, Decision 2 — the call site stays per-service,
 * matching how `setProps` is already handled; only the *mechanism* is centralized here). It is
 * idempotent and never overwrites an existing value — including a controller (Home app) rename
 * or a prior run's seed — because the guard is `service.testCharacteristic`, which reflects
 * both cases identically (design.md, Decision 1).
 */

import type { HAP, Service } from 'homebridge';

import type { Side } from '../pod/types.ts';

/** Short, standalone `ConfiguredName` labels — distinct within each accessory they're used on,
 * never prefixed with the accessory's own display name (tech-lead resolution, design.md). */
export const CONFIGURED_NAME = {
  thermostat: 'Thermostat',
  alarm: 'Alarm',
  dismissAlarm: 'Dismiss Alarm',
  occupancy: 'Occupancy',
  awayMode: 'Away Mode',
  skipNextAlarm: 'Skip Next Alarm',
  podConnection: 'Pod Connection',
  led: 'LED',
  prime: 'Prime',
  waterLevel: 'Water Level',
  serverFault: 'Server Fault',
} as const;

/** The hub carries one `TestAlarmService` per side, both on the same accessory — the only pair
 * of services in the plugin where the tech lead's short "Test Alarm" example would collide with
 * itself, so each side's label keeps the `Left`/`Right` suffix the pre-existing `Name`
 * convention already uses (`TEST_ALARM_NAMES` in `./testAlarm.ts`, itself now defined in terms of
 * this constant rather than duplicating the literals — see that module's own doc) purely for that
 * reason. Defined here, not there: `./testAlarm.ts` already imports from this module for
 * `seedConfiguredName`, so this stays the one direction of dependency between the two files. */
export const TEST_ALARM_CONFIGURED_NAME: Readonly<Record<Side, string>> = {
  left: 'Test Alarm Left',
  right: 'Test Alarm Right',
};

/**
 * Adds `ConfiguredName` to `service` (via HAP's optional-characteristic mechanism — required,
 * since none of the service types this plugin uses declare it) and seeds it to `label`, but
 * only the first time this is ever called for a given service instance's underlying HAP state.
 *
 * `service.testCharacteristic(ConfiguredName)` is `true` whenever the characteristic is already
 * present — whether from an earlier call to this same function (a prior seed, still at its
 * default) or from a controller's own rename surviving a restart via HAP-NodeJS's ordinary
 * `Service.serialize`/`deserialize` round trip through Homebridge's `cachedAccessories` file
 * (design.md, Decision 1) — so in that case this function does nothing at all. This is what
 * makes seeding safe to call unconditionally on every construction, across every restart,
 * without ever clobbering a rename.
 */
export function seedConfiguredName(service: Service, hap: HAP, label: string): void {
  if (service.testCharacteristic(hap.Characteristic.ConfiguredName)) return;
  service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
  service.setCharacteristic(hap.Characteristic.ConfiguredName, label);
}
