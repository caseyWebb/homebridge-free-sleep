import { describe, expect, it } from 'vitest';

import {
  DeviceStatusPatchSchema,
  DeviceStatusSchema,
  interpretWaterLevel,
} from '../src/pod/types.js';

const validSide = {
  currentTemperatureLevel: 0,
  currentTemperatureF: 82,
  targetTemperatureF: 75,
  secondsRemaining: 0,
  isOn: false,
  isAlarmVibrating: false,
};

const validDeviceStatus = {
  left: validSide,
  right: validSide,
  waterLevel: 'true',
  isPriming: false,
  settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 0 },
  coverVersion: 'Pod 5',
  hubVersion: 'Pod 5',
  freeSleep: { version: '2.1.5', branch: 'main' },
  wifiStrength: 82,
};

describe('read schemas are lenient', () => {
  it('parses a response carrying an unknown property, retaining known fields', () => {
    const result = DeviceStatusSchema.parse({
      ...validDeviceStatus,
      aFieldWeDidNotVendor: 'surprise',
    });
    expect(result.coverVersion).toBe('Pod 5');
    expect(result.left.isOn).toBe(false);
  });

  it('parses an unknown property nested under a side', () => {
    const result = DeviceStatusSchema.parse({
      ...validDeviceStatus,
      left: { ...validSide, futureField: 42 },
    });
    expect(result.left.currentTemperatureF).toBe(82);
  });

  it('parses a targetTemperatureF outside 55-110 without failing', () => {
    const result = DeviceStatusSchema.parse({
      ...validDeviceStatus,
      left: { ...validSide, targetTemperatureF: 200 },
    });
    expect(result.left.targetTemperatureF).toBe(200);
  });

  it('fails on a structurally wrong response (missing field)', () => {
    const sideMissingIsOn: Partial<typeof validSide> = { ...validSide };
    delete sideMissingIsOn.isOn;
    expect(() =>
      DeviceStatusSchema.parse({ ...validDeviceStatus, left: sideMissingIsOn }),
    ).toThrow();
  });
});

describe('request schemas are strict', () => {
  it('rejects an unknown key', () => {
    const result = DeviceStatusPatchSchema.safeParse({ left: { bogus: true } });
    expect(result.success).toBe(false);
  });

  it.each([54, 111])('rejects an out-of-range targetTemperatureF (%d)', (value) => {
    const result = DeviceStatusPatchSchema.safeParse({ left: { targetTemperatureF: value } });
    expect(result.success).toBe(false);
  });

  it.each([55, 110])('accepts a boundary targetTemperatureF (%d)', (value) => {
    const result = DeviceStatusPatchSchema.safeParse({ left: { targetTemperatureF: value } });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer targetTemperatureF', () => {
    const result = DeviceStatusPatchSchema.safeParse({ left: { targetTemperatureF: 75.5 } });
    expect(result.success).toBe(false);
  });
});

describe('interpretWaterLevel', () => {
  it('maps "true" to ok', () => {
    expect(interpretWaterLevel('true')).toBe('ok');
  });

  it('maps "false" to low', () => {
    expect(interpretWaterLevel('false')).toBe('low');
  });

  it.each(['', 'unknown', 'TRUE', '1'])(
    'maps unexpected value %j to unknown, never low',
    (raw) => {
      const result = interpretWaterLevel(raw);
      expect(result).toBe('unknown');
      expect(result).not.toBe('low');
    },
  );
});
