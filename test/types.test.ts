import { describe, expect, it } from 'vitest';

import {
  AlarmRequestSchema,
  DeviceStatusPatchSchema,
  DeviceStatusSchema,
  PresenceSchema,
  SchedulesSchema,
  ServerStatusSchema,
  SettingsPatchSchema,
  SettingsSchema,
  VitalsResponseSchema,
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

// ---------------------------------------------------------------------------------------
// hub-accessory: ServerStatusSchema (tasks.md 1.1)
// ---------------------------------------------------------------------------------------

describe('ServerStatusSchema', () => {
  it('parses the serverStatus fixture successfully', () => {
    const result = ServerStatusSchema.safeParse(loadFixture('serverStatus.json'));
    expect(result.success).toBe(true);
  });

  it('rejects a document with a wrong-typed status value', () => {
    const serverStatus = loadFixture('serverStatus.json') as { database: { status: unknown } };
    const broken = { ...serverStatus, database: { ...serverStatus.database, status: 42 } };
    const result = ServerStatusSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it('parses fine when every biometrics-gated key is absent', () => {
    const result = ServerStatusSchema.safeParse(loadFixture('serverStatus.json'));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.analyzeSleepLeft).toBeUndefined();
    }
  });

  // N2 (hub-accessory PR #44 review): `biometricsInstallation` is NOT gated by
  // `biometrics.enabled` upstream (`server/src/serverStatus.ts`'s `updateServices()` sets it
  // unconditionally, before the `if (servicesDB.data.biometrics.enabled)` guard that gates its
  // five siblings) — so the fixture carries it present even while the other five stay absent,
  // and that combination must parse.
  it('biometricsInstallation is present even while every other biometrics-gated key is absent', () => {
    const result = ServerStatusSchema.safeParse(loadFixture('serverStatus.json'));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.biometricsInstallation?.status).toBe('healthy');
      expect(result.data.analyzeSleepLeft).toBeUndefined();
      expect(result.data.analyzeSleepRight).toBeUndefined();
      expect(result.data.biometricsStream).toBeUndefined();
      expect(result.data.biometricsCalibrationLeft).toBeUndefined();
      expect(result.data.biometricsCalibrationRight).toBeUndefined();
    }
  });

  it('still parses when a biometrics-gated key is present', () => {
    const serverStatus = loadFixture('serverStatus.json') as Record<string, unknown>;
    const withBiometrics = {
      ...serverStatus,
      analyzeSleepLeft: { name: 'analyzeSleepLeft', status: 'healthy', description: 'x', message: 'OK' },
    };
    const result = ServerStatusSchema.safeParse(withBiometrics);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.analyzeSleepLeft?.status).toBe('healthy');
    }
  });

  it('rejects a document missing a required always-present subsystem', () => {
    const serverStatus = { ...(loadFixture('serverStatus.json') as Record<string, unknown>) };
    delete serverStatus.database;
    const result = ServerStatusSchema.safeParse(serverStatus);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: AlarmRequestSchema (tasks.md 1.2)
// ---------------------------------------------------------------------------------------

describe('AlarmRequestSchema', () => {
  const validRequest = {
    side: 'left',
    vibrationIntensity: 60,
    vibrationPattern: 'double',
    duration: 10,
    force: true,
  };

  it('accepts a valid request', () => {
    const result = AlarmRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it.each([0, 101])('rejects an out-of-bounds vibrationIntensity (%d)', (vibrationIntensity) => {
    const result = AlarmRequestSchema.safeParse({ ...validRequest, vibrationIntensity });
    expect(result.success).toBe(false);
  });

  it.each([1, 100])('accepts a boundary vibrationIntensity (%d)', (vibrationIntensity) => {
    const result = AlarmRequestSchema.safeParse({ ...validRequest, vibrationIntensity });
    expect(result.success).toBe(true);
  });

  it("rejects a vibrationPattern this client doesn't recognize", () => {
    const result = AlarmRequestSchema.safeParse({ ...validRequest, vibrationPattern: 'pulse' });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-bounds duration', () => {
    const result = AlarmRequestSchema.safeParse({ ...validRequest, duration: 181 });
    expect(result.success).toBe(false);
  });

  // N1 (hub-accessory PR #44 review): matches upstream's own
  // `server/src/db/schedulesSchema.ts`'s `AlarmSchema.duration` —
  // `z.number().int().positive().min(0).max(180)` — whose binding lower bound is `.positive()`,
  // not the redundant `.min(0)`, so `0` itself is rejected and `1` is the smallest valid value.
  it('rejects a duration of 0', () => {
    const result = AlarmRequestSchema.safeParse({ ...validRequest, duration: 0 });
    expect(result.success).toBe(false);
  });

  it.each([1, 180])('accepts a boundary duration (%d)', (duration) => {
    const result = AlarmRequestSchema.safeParse({ ...validRequest, duration });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown key', () => {
    const result = AlarmRequestSchema.safeParse({ ...validRequest, extra: true });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: DeviceStatusPatchSchema's isPriming field, standalone (tasks.md 1.3)
// ---------------------------------------------------------------------------------------

describe("DeviceStatusPatchSchema's isPriming field, standalone (hub-accessory, tasks.md 1.3)", () => {
  it('parses a patch carrying only isPriming', () => {
    const result = DeviceStatusPatchSchema.safeParse({ isPriming: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ isPriming: true });
    }
  });
});

// ---------------------------------------------------------------------------------------
// occupancy: PresenceSchema / VitalsResponseSchema fixtures
// ---------------------------------------------------------------------------------------

/**
 * Occupancy change (#19), task 2.3: both new fixtures parse through their vendored read
 * schemas with no error, and a fixture edited to violate the schema fails naming the offending
 * property (pod-test-double spec, "Every fixture parses through the vendored wire types").
 */
describe('presence and vitals fixtures parse through their vendored read schemas', () => {
  it('metricsPresence.json parses through PresenceSchema', () => {
    const result = PresenceSchema.parse(loadFixture('metricsPresence.json'));
    expect(result.left?.present).toBe(false);
    expect(result.right?.present).toBe(false);
  });

  it('metricsVitals.json parses through VitalsResponseSchema, preserving snake_case fields and row order', () => {
    const result = VitalsResponseSchema.parse(loadFixture('metricsVitals.json'));
    expect(result).toHaveLength(2);
    // Not sorted with left first — the real capture's own order (design.md's Context).
    expect(result[0]!.side).toBe('right');
    expect(result[1]!.side).toBe('left');
    expect(result[0]!.hrv).toBe(0);
    expect(result[0]!.breathing_rate).toBe(0);
  });

  it('rejects a presence fixture with a non-boolean present, naming the offending property', () => {
    const broken = loadFixture('metricsPresence.json') as { left: { present: unknown } };
    broken.left.present = 'yes';
    let caught: unknown;
    try {
      PresenceSchema.parse(broken);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).toContain('present');
  });

  it('a null heart_rate/hrv/breathing_rate parses cleanly, not coerced or rejected', () => {
    const rows = loadFixture('metricsVitals.json') as Array<{
      heart_rate: number | null;
      hrv: number | null;
      breathing_rate: number | null;
    }>;
    rows[0]!.heart_rate = null;
    rows[0]!.hrv = null;
    rows[0]!.breathing_rate = null;
    const result = VitalsResponseSchema.parse(rows);
    expect(result[0]!.heart_rate).toBeNull();
    expect(result[0]!.hrv).toBeNull();
    expect(result[0]!.breathing_rate).toBeNull();
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
