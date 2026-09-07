import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler } from '@homebridge/hap-nodejs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SchedulesSchema, ServicesSchema, SettingsSchema } from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { WATER_LOW_SUBTYPE, WaterLowService } from '../../src/services/waterLow.js';
import type { ServiceContext } from '../../src/services/types.js';
import { createFakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture = SchedulesSchema.parse(loadFixture('schedules.json'));
const servicesFixture = ServicesSchema.parse(loadFixture('services.json'));

function baseConfig(overrides: Record<string, unknown> = {}): FreeSleepConfig {
  return FreeSleepConfigSchema.parse({ host: 'pod.local', ...overrides });
}

interface Setup {
  api: FakeHomebridgeApi;
  accessory: FakePlatformAccessory;
  snapshot: SnapshotStore;
  timers: TimerHarness;
}

function setup(): Setup {
  const api = new FakeHomebridgeApi();
  const accessory = new api.platformAccessory('Pod', api.hap.uuid.generate('hub'), api.hap.Categories.OTHER);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  return { api, accessory, snapshot, timers };
}

function contextFor(s: Setup, configOverrides: Record<string, unknown> = {}): ServiceContext {
  const log = createFakeLogging();
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings: settingsFixture,
    schedules: schedulesFixture,
    services: servicesFixture,
  });
  const awayModeGuard = new AwayModeGuard({ snapshot: s.snapshot, policy: 'mirror' });
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot: s.snapshot,
    requestFastPoll: () => {},
    awayModeGuard,
    timers: s.timers,
  });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: s.api.asApi() as any,
    log,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessory: s.accessory as any,
    snapshot: s.snapshot,
    writeQueue,
    awayModeGuard,
    timers: s.timers,
    config: baseConfig(configOverrides),
    podClient: fake.client as unknown as MinimalPodClient,
  };
}

function buildGetHandlers(build: () => void): Map<string, CharacteristicGetHandler> {
  const handlers = new Map<string, CharacteristicGetHandler>();
  const spy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicGetHandler,
  ) {
    handlers.set(this.UUID, handler);
    return this;
  });
  build();
  spy.mockRestore();
  return handlers;
}

beforeEach(() => {
  vi.useFakeTimers();
});

// ---------------------------------------------------------------------------------------
// Existence and default service type
// ---------------------------------------------------------------------------------------

describe('the sensor exists unconditionally, defaulting to a contact sensor', () => {
  it('adds exactly one ContactSensor named "Pod Water Low" with subtype waterLow, when no config key is set', () => {
    const s = setup();
    const ctx = contextFor(s);
    new WaterLowService(ctx);

    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.ContactSensor.UUID);
    expect(sensors).toHaveLength(1);
    expect(sensors[0]?.subtype).toBe(WATER_LOW_SUBTYPE);
    expect(sensors[0]?.displayName).toBe('Pod Water Low');
  });

  it('restores by getServiceById rather than adding a second sensor', () => {
    const s = setup();
    const ctx = contextFor(s);
    new WaterLowService(ctx);
    new WaterLowService(ctx);

    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.ContactSensor.UUID);
    expect(sensors).toHaveLength(1);
  });
});

describe('configuring the leak sensor changes only the service type', () => {
  it('publishes a LeakSensor instead of a ContactSensor when waterLowSensorType is "leak"', () => {
    const s = setup();
    const ctx = contextFor(s, { waterLowSensorType: 'leak' });
    new WaterLowService(ctx);

    expect(s.accessory.services.some((sv) => sv.UUID === s.api.hap.Service.ContactSensor.UUID)).toBe(false);
    const leakSensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.LeakSensor.UUID);
    expect(leakSensors).toHaveLength(1);
    expect(leakSensors[0]?.subtype).toBe(WATER_LOW_SUBTYPE);
  });
});

// ---------------------------------------------------------------------------------------
// Derivation: ok/low/unknown, for both service types
// ---------------------------------------------------------------------------------------

describe.each(['contact', 'leak'] as const)('derivation for waterLowSensorType=%s', (sensorType) => {
  function stateHandlerUuid(hap: FakeHomebridgeApi['hap']): string {
    return sensorType === 'leak' ? hap.Characteristic.LeakDetected.UUID : hap.Characteristic.ContactSensorState.UUID;
  }

  function goodValue(hap: FakeHomebridgeApi['hap']): number {
    return sensorType === 'leak'
      ? hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  function badValue(hap: FakeHomebridgeApi['hap']): number {
    return sensorType === 'leak'
      ? hap.Characteristic.LeakDetected.LEAK_DETECTED
      : hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  it('adequate maps to the good state', () => {
    const s = setup();
    const ctx = contextFor(s, { waterLowSensorType: sensorType });
    const handlers = buildGetHandlers(() => new WaterLowService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.observeDeviceStatus({ ...deviceStatusFixture, waterLevel: 'true' });
    expect(handlers.get(stateHandlerUuid(hap))!({} as never, undefined)).toBe(goodValue(hap));
    expect(handlers.get(hap.Characteristic.StatusFault.UUID)!({} as never, undefined)).toBe(
      hap.Characteristic.StatusFault.NO_FAULT,
    );
  });

  it('low maps to the low/bad state', () => {
    const s = setup();
    const ctx = contextFor(s, { waterLowSensorType: sensorType });
    const handlers = buildGetHandlers(() => new WaterLowService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.observeDeviceStatus({ ...deviceStatusFixture, waterLevel: 'false' });
    expect(handlers.get(stateHandlerUuid(hap))!({} as never, undefined)).toBe(badValue(hap));
  });

  it('unknown holds the last-reported state and raises a fault, rather than switching to low', () => {
    const s = setup();
    const ctx = contextFor(s, { waterLowSensorType: sensorType });
    const handlers = buildGetHandlers(() => new WaterLowService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.observeDeviceStatus({ ...deviceStatusFixture, waterLevel: 'true' }); // adequate first
    expect(handlers.get(stateHandlerUuid(hap))!({} as never, undefined)).toBe(goodValue(hap));

    ctx.snapshot.observeDeviceStatus({ ...deviceStatusFixture, waterLevel: 'garbled' }); // unknown
    expect(handlers.get(stateHandlerUuid(hap))!({} as never, undefined)).toBe(goodValue(hap)); // held
    expect(handlers.get(hap.Characteristic.StatusFault.UUID)!({} as never, undefined)).toBe(
      hap.Characteristic.StatusFault.GENERAL_FAULT,
    );
  });

  it('unknown after a low observation holds low, not adequate', () => {
    const s = setup();
    const ctx = contextFor(s, { waterLowSensorType: sensorType });
    const handlers = buildGetHandlers(() => new WaterLowService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.observeDeviceStatus({ ...deviceStatusFixture, waterLevel: 'false' }); // low first
    // A read while still 'low' is what lets the service notice and remember it, exactly as a
    // real controller's periodic read (or the platform's own refresh() routing) would.
    expect(handlers.get(stateHandlerUuid(hap))!({} as never, undefined)).toBe(badValue(hap));

    ctx.snapshot.observeDeviceStatus({ ...deviceStatusFixture, waterLevel: 'garbled' }); // unknown
    expect(handlers.get(stateHandlerUuid(hap))!({} as never, undefined)).toBe(badValue(hap)); // held
  });
});

describe('B1: bootstrap-observed state is pushed at construction', () => {
  it('publishes the already-observed adequate state without waiting for a change event', () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({ ...deviceStatusFixture, waterLevel: 'true' });
    const ctx = contextFor(s);
    const service = new WaterLowService(ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.ContactSensor, WATER_LOW_SUBTYPE)!;
    expect(hapService.getCharacteristic(s.api.hap.Characteristic.ContactSensorState).value).toBe(
      s.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    void service;
  });
});
