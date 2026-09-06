import { describe, expect, it } from 'vitest';

import { loadFixture } from './loadFixture.js';
import {
  DeviceStatusSchema,
  SchedulesSchema,
  ServicesSchema,
  SettingsSchema,
} from '../src/pod/types.js';

// Table-driven so adding a fixture file without adding a row here is itself caught: the
// no-taps and structural-failure tests below only exercise what's listed, and a reviewer
// diffing `ls test/fixtures/*.json` against this table will notice a missing row.
const fixtures = [
  { name: 'deviceStatus.json', schema: DeviceStatusSchema },
  { name: 'deviceStatus.bothOff.json', schema: DeviceStatusSchema },
  { name: 'deviceStatus.waterLow.json', schema: DeviceStatusSchema },
  { name: 'deviceStatus.waterUnknown.json', schema: DeviceStatusSchema },
  { name: 'settings.json', schema: SettingsSchema },
  { name: 'schedules.json', schema: SchedulesSchema },
  { name: 'services.json', schema: ServicesSchema },
];

describe('every fixture parses through its read schema', () => {
  it.each(fixtures)('$name parses', ({ name, schema }) => {
    const data = loadFixture(name);
    expect(() => schema.parse(data)).not.toThrow();
  });

  it('a fixture missing a required field fails, naming the property', () => {
    const deviceStatus = loadFixture('deviceStatus.json') as {
      left: Record<string, unknown>;
      [key: string]: unknown;
    };
    const leftWithoutIsOn = { ...deviceStatus.left };
    delete leftWithoutIsOn.isOn;
    const broken = { ...deviceStatus, left: leftWithoutIsOn };

    let message = '';
    try {
      DeviceStatusSchema.parse(broken);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/isOn/);
  });
});

describe('the device-status fixture asserts the absence of gesture tap counters', () => {
  it('deviceStatus.json has no taps object on either side', () => {
    const deviceStatus = loadFixture('deviceStatus.json') as {
      left: Record<string, unknown>;
      right: Record<string, unknown>;
    };
    const hasTaps = (side: Record<string, unknown>): boolean => 'taps' in side;

    if (hasTaps(deviceStatus.left) || hasTaps(deviceStatus.right)) {
      throw new Error(
        'deviceStatus.json now contains `taps` — the assumption behind #21 ' +
          '(gesture tap counters are never present in the HTTP device-status response) ' +
          "has been invalidated. Re-read docs/POD-API.md and free-sleep's " +
          'server/src/8sleep/frankenServer.ts before proceeding with #21.',
      );
    }
    expect(hasTaps(deviceStatus.left)).toBe(false);
    expect(hasTaps(deviceStatus.right)).toBe(false);
  });
});
