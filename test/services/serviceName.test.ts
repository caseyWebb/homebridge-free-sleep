/**
 * `src/services/serviceName.ts` — the shared `ConfiguredName` seeding mechanism and the unified
 * short-label convention (release-polish tasks.md 1.1; design.md Decisions 1–3, as overridden by
 * the tech-lead resolution: short labels, no accessory-name prefix).
 */
import { Accessory, Characteristic } from '@homebridge/hap-nodejs';
import { describe, expect, it } from 'vitest';

import { CONFIGURED_NAME, seedConfiguredName, TEST_ALARM_CONFIGURED_NAME } from '../../src/services/serviceName.js';
import { FakeHomebridgeApi } from '../fakeHomebridgeApi.js';

function realHap() {
  return new FakeHomebridgeApi().hap;
}

describe('CONFIGURED_NAME label convention (1.1)', () => {
  it('every label is short, standalone, and carries no accessory-name prefix', () => {
    for (const label of Object.values(CONFIGURED_NAME)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(64); // HAP's own ConfiguredName maxLength
      expect(label.startsWith('Pod Left')).toBe(false);
      expect(label.startsWith('Pod Right')).toBe(false);
    }
  });

  it('every label is unique across the shared table (distinct within any accessory that uses more than one)', () => {
    const labels = Object.values(CONFIGURED_NAME);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('TEST_ALARM_CONFIGURED_NAME gives left and right distinct labels (the one pair that shares an accessory)', () => {
    expect(TEST_ALARM_CONFIGURED_NAME.left).toBe('Test Alarm Left');
    expect(TEST_ALARM_CONFIGURED_NAME.right).toBe('Test Alarm Right');
    expect(TEST_ALARM_CONFIGURED_NAME.left).not.toBe(TEST_ALARM_CONFIGURED_NAME.right);
  });

  it('a display name containing special characters does not leak into any seed label (labels are fixed strings, not templated)', () => {
    // Unlike the pre-#49 `Name` convention some services used (`${accessory.displayName} X`),
    // ConfiguredName seeds are fixed, accessory-independent strings (tech-lead resolution) — so
    // an accessory renamed to something containing special characters cannot affect the seeded
    // label. Actually constructs an accessory under each representative weird display name and
    // seeds a service on it, rather than merely asserting the unrelated fact that `CONFIGURED_NAME`
    // itself contains no template syntax.
    const hap = realHap();
    const weirdNames = ['Caséy’s "Side" 🌙', "O'Brien / Left"];
    for (const name of weirdNames) {
      const accessory = new Accessory(name, hap.uuid.generate(name));
      const service = accessory.addService(new hap.Service.Switch('Away Mode Left', 'awayMode'));
      seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);
      expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Away Mode');
    }
  });
});

describe('seedConfiguredName (1.1, design.md Decision 1)', () => {
  it('adds and seeds ConfiguredName when the service has never carried it', () => {
    const hap = realHap();
    const accessory = new Accessory('Pod Left', hap.uuid.generate('left'));
    const service = accessory.addService(new hap.Service.Switch('Away Mode Left', 'awayMode'));

    expect(service.testCharacteristic(Characteristic.ConfiguredName)).toBe(false);
    seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);

    expect(service.testCharacteristic(Characteristic.ConfiguredName)).toBe(true);
    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Away Mode');
  });

  it('does not touch an already-present ConfiguredName — a prior seed survives a repeat call', () => {
    const hap = realHap();
    const accessory = new Accessory('Pod Left', hap.uuid.generate('left'));
    const service = accessory.addService(new hap.Service.Switch('Away Mode Left', 'awayMode'));

    seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);
    seedConfiguredName(service, hap, 'Some Other Label'); // simulates a second construction

    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Away Mode');
  });

  it('does not touch an already-present ConfiguredName that a controller renamed — the explicit restore-with-renamed-value case', () => {
    const hap = realHap();
    const accessory = new Accessory('Pod Left', hap.uuid.generate('left'));
    const service = accessory.addService(new hap.Service.Switch('Away Mode Left', 'awayMode'));

    seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);
    // Simulates a controller (Home app) rename — a direct characteristic write, exactly what
    // survives via HAP-NodeJS's Service.serialize/deserialize round trip through Homebridge's
    // cachedAccessories file (design.md, Decision 1), not something seedConfiguredName itself does.
    service.getCharacteristic(Characteristic.ConfiguredName).updateValue('Bedroom Away Mode');

    // A later "restart" re-runs the exact same seed call against the same (now-renamed) service.
    seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);

    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Bedroom Away Mode');
  });

  it('emits no characteristic-warning event on either the first or a repeat call', () => {
    const hap = realHap();
    const accessory = new Accessory('Pod Left', hap.uuid.generate('left'));
    const service = accessory.addService(new hap.Service.Switch('Away Mode Left', 'awayMode'));
    const warnings: unknown[] = [];
    accessory.on('characteristic-warning', (w: unknown) => warnings.push(w));

    seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);
    seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);

    expect(warnings).toHaveLength(0);
  });

  it('uses HAP\'s optional-characteristic mechanism, not a bare getCharacteristic fallback (would itself warn)', () => {
    const hap = realHap();
    const accessory = new Accessory('Pod Left', hap.uuid.generate('left'));
    const service = accessory.addService(new hap.Service.Switch('Away Mode Left', 'awayMode'));

    seedConfiguredName(service, hap, CONFIGURED_NAME.awayMode);

    expect(service.optionalCharacteristics.some((c) => c instanceof Characteristic.ConfiguredName)).toBe(true);
  });
});
