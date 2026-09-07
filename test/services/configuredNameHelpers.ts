/**
 * Shared test helper for the `ConfiguredName` seeding assertions repeated across every
 * `test/services/*.test.ts` file (release-polish tasks.md, Section 2's "Verify each with a unit
 * test" block) — capturing whether a real `Accessory`'s `characteristic-warning` event fires
 * during a service's construction, the one thing every one of those per-service tests checks
 * identically. `@homebridge/hap-nodejs`'s `Service` forwards its own `characteristic-warning`
 * event up to the owning `Accessory` (`Accessory.js`'s `addService`), so listening on the
 * accessory catches a warning from any service on it.
 */

import { Characteristic } from '@homebridge/hap-nodejs';

import type { FakePlatformAccessory } from '../fakeHomebridgeApi.ts';

interface CharacteristicWarningEvent {
  characteristic: { UUID: string };
  type: string;
  message: string;
}

/** Attaches a listener before a service is constructed and returns the array it appends every
 * `ConfiguredName` `'characteristic-warning'` event to — call this *before* `new XService(ctx,
 * ...)` so a warning fired during construction (e.g. `getCharacteristic` falling back to
 * add-with-a-warning instead of the guarded `addOptionalCharacteristic` path this change relies
 * on) is actually observed.
 *
 * Filtered to `ConfiguredName` specifically, not every warning the accessory ever emits — some
 * services (e.g. `ThermostatService`, against the shared `deviceStatus` fixture) can emit an
 * unrelated, pre-existing `Characteristic was supplied illegal value` warning for a wholly
 * different characteristic during their normal B1 initial-publish `refresh()` call, which has
 * nothing to do with this change and would otherwise make every one of these tests flaky by
 * accident. */
export function captureCharacteristicWarnings(accessory: FakePlatformAccessory): CharacteristicWarningEvent[] {
  const warnings: CharacteristicWarningEvent[] = [];
  accessory._associatedHAPAccessory.on('characteristic-warning', (warning: CharacteristicWarningEvent) => {
    if (warning.characteristic?.UUID === Characteristic.ConfiguredName.UUID) {
      warnings.push(warning);
    }
  });
  return warnings;
}
