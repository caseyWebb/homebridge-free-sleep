import { describe, expect, it } from 'vitest';

import {
  DeviceStatusPatchSchema,
  DeviceStatusSchema,
  SchedulesSchema,
  SettingsPatchSchema,
  SettingsSchema,
  interpretWaterLevel,
} from '../src/pod/types.js';
import { loadFixture } from './loadFixture.js';

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

/**
 * B1 in the pod-client code review: read leniency was only implemented for device status.
 * Settings and schedules read schemas still enforced upstream's *request*-side value
 * constraints (the tap discriminated union, `.min`/`.max` amounts, the `temperatureFormat`
 * enum, `TimeSchema`'s regex) on responses, even though the Pod never validates its own
 * responses. These mirror the device-status leniency tests above, with the reviewer's exact
 * reproduction cases.
 */
describe('settings read schema is lenient (B1)', () => {
  it("parses a tap config with a type this client has never heard of ('brightness')", () => {
    const settings = loadFixture('settings.json') as {
      left: { taps: { doubleTap: unknown } };
      [key: string]: unknown;
    };
    settings.left.taps.doubleTap = { type: 'brightness', level: 5 };
    const result = SettingsSchema.parse(settings);
    expect(result.left.taps.doubleTap).toEqual({ type: 'brightness' });
  });

  it('parses a doubleTap.amount of 42 — outside the request-side 0-10 bound', () => {
    const settings = loadFixture('settings.json') as {
      left: { taps: { doubleTap: { amount: number } } };
    };
    settings.left.taps.doubleTap.amount = 42;
    const result = SettingsSchema.parse(settings);
    expect(result.left.taps.doubleTap).toMatchObject({ type: 'temperature', amount: 42 });
  });

  it("parses a temperatureFormat of 'kelvin' — not in the request-side enum", () => {
    const settings = loadFixture('settings.json') as { temperatureFormat: string };
    settings.temperatureFormat = 'kelvin';
    const result = SettingsSchema.parse(settings);
    expect(result.temperatureFormat).toBe('kelvin');
  });
});

describe('schedules read schema is lenient (B1)', () => {
  it("parses power.on: '7:00' — malformed against TimeSchema's HH:mm regex", () => {
    const schedules = loadFixture('schedules.json') as {
      left: { sunday: { power: { on: string } } };
    };
    schedules.left.sunday.power.on = '7:00';
    const result = SchedulesSchema.parse(schedules);
    expect(result.left.sunday.power.on).toBe('7:00');
  });

  it('parses an equally malformed alarm.time', () => {
    const schedules = loadFixture('schedules.json') as {
      left: { sunday: { alarm: { time: string } } };
    };
    schedules.left.sunday.alarm.time = 'not-a-time';
    const result = SchedulesSchema.parse(schedules);
    expect(result.left.sunday.alarm.time).toBe('not-a-time');
  });
});

describe('settings request schema is strict (B1)', () => {
  it("rejects a tap type this client has never heard of ('brightness')", () => {
    const result = SettingsPatchSchema.safeParse({
      left: { taps: { doubleTap: { type: 'brightness' } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a doubleTap.amount of 42 (outside 0-10)', () => {
    const result = SettingsPatchSchema.safeParse({
      left: { taps: { doubleTap: { type: 'temperature', change: 'increment', amount: 42 } } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a temperatureFormat of 'kelvin'", () => {
    const result = SettingsPatchSchema.safeParse({ temperatureFormat: 'kelvin' });
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
