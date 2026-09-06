import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SchedulesSchema, ServicesSchema, SettingsSchema } from '../../src/pod/types.js';
import { WriteQueue, type FastPollLane } from '../../src/pod/writeQueue.js';
import { CONNECTION_SUBTYPE, ConnectionService } from '../../src/services/connection.js';
import type { ServiceContext } from '../../src/services/types.js';
import { ThermostatService } from '../../src/services/thermostat.js';
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

function setup(config: Record<string, unknown> = {}): Setup {
  const api = new FakeHomebridgeApi();
  const accessory = new api.platformAccessory('Pod', api.hap.uuid.generate('hub'), api.hap.Categories.OTHER);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  void config;
  return { api, accessory, snapshot, timers };
}

function contextFor(setupResult: Setup, config: Record<string, unknown> = {}): ServiceContext {
  const log = createFakeLogging();
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings: settingsFixture,
    schedules: schedulesFixture,
    services: servicesFixture,
  });
  const fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }> = [];
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot: setupResult.snapshot,
    requestFastPoll: (lane, untilMs) => fastPollRequests.push({ lane, untilMs }),
    timers: setupResult.timers,
  });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: setupResult.api.asApi() as any,
    log,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessory: setupResult.accessory as any,
    snapshot: setupResult.snapshot,
    writeQueue,
    timers: setupResult.timers,
    config: baseConfig(config),
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

const UUID = {
  contactState: Characteristic.ContactSensorState.UUID,
  statusFault: Characteristic.StatusFault.UUID,
  statusActive: Characteristic.StatusActive.UUID,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 6.1 Construction
// ---------------------------------------------------------------------------------------

describe('construction (6.1)', () => {
  it('adds exactly one ContactSensor named "Pod Connection" with subtype connection, carrying the three characteristics', () => {
    const s = setup();
    const ctx = contextFor(s);
    new ConnectionService(ctx);

    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.ContactSensor.UUID);
    expect(sensors).toHaveLength(1);
    const service = sensors[0]!;
    expect(service.subtype).toBe(CONNECTION_SUBTYPE);
    expect(service.displayName).toBe('Pod Connection');

    const uuids = service.characteristics.map((c) => c.UUID);
    expect(uuids).toEqual(expect.arrayContaining([UUID.contactState, UUID.statusFault, UUID.statusActive]));
  });

  it('neither side accessory carries a connection sensor, and no thermostat carries StatusFault/StatusActive', () => {
    const s = setup();
    const ctx = contextFor(s);
    new ConnectionService(ctx);

    const sideApi = new FakeHomebridgeApi();
    const sideAccessory = new sideApi.platformAccessory('Pod Left', sideApi.hap.uuid.generate('left'), sideApi.hap.Categories.THERMOSTAT);
    const sideSnapshot = new SnapshotStore({ timers: s.timers });
    const sideCtx = contextFor({ api: sideApi, accessory: sideAccessory, snapshot: sideSnapshot, timers: s.timers });
    new ThermostatService(sideCtx, 'left', 0);

    expect(sideAccessory.services.some((sv) => sv.UUID === sideApi.hap.Service.ContactSensor.UUID)).toBe(false);
    const thermostat = sideAccessory.services.find((sv) => sv.UUID === sideApi.hap.Service.Thermostat.UUID)!;
    const thermostatUuids = thermostat.characteristics.map((c) => c.UUID);
    expect(thermostatUuids).not.toContain(UUID.statusFault);
    expect(thermostatUuids).not.toContain(UUID.statusActive);
  });

  it('restores by getServiceById rather than adding a second ContactSensor', () => {
    const s = setup();
    const ctx = contextFor(s);
    new ConnectionService(ctx);
    new ConnectionService(ctx);

    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.ContactSensor.UUID);
    expect(sensors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// 6.2 Contact state mapping, pushed only on change
// ---------------------------------------------------------------------------------------

describe('reachability mapping and change-only pushes (6.2)', () => {
  it('online -> CONTACT_DETECTED / NO_FAULT; unreachable -> CONTACT_NOT_DETECTED / GENERAL_FAULT', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ConnectionService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    expect(handlers.get(UUID.contactState)!({} as never, undefined)).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
    expect(handlers.get(UUID.statusFault)!({} as never, undefined)).toBe(hap.Characteristic.StatusFault.NO_FAULT);

    ctx.snapshot.recordDeviceStatusFailure('network');
    ctx.snapshot.recordDeviceStatusFailure('network');
    expect(handlers.get(UUID.contactState)!({} as never, undefined)).toBe(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(handlers.get(UUID.statusFault)!({} as never, undefined)).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
  });

  it('success -> five consecutive failures -> success pushes ContactSensorState exactly twice', () => {
    const s = setup();
    const ctx = contextFor(s);
    const service = new ConnectionService(ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.ContactSensor, CONNECTION_SUBTYPE)!;
    const spy = vi.spyOn(hapService.getCharacteristic(s.api.hap.Characteristic.ContactSensorState), 'updateValue');

    ctx.snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    service.refresh(); // online already true at construction time isn't tracked; refresh reflects current state, no-op if unchanged

    for (let i = 0; i < 5; i++) {
      ctx.snapshot.recordDeviceStatusFailure('network');
      service.refresh();
    }
    ctx.snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    service.refresh();

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------------------
// 6.3 StatusActive
// ---------------------------------------------------------------------------------------

describe('StatusActive (6.3)', () => {
  it('stays false across a launch that never reaches the Pod', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ConnectionService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.recordDeviceStatusFailure('network');
    ctx.snapshot.recordDeviceStatusFailure('network');

    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(false);
    void hap;
  });

  it('goes true on first success and stays true through a later failure', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ConnectionService(ctx));

    ctx.snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);

    ctx.snapshot.recordDeviceStatusFailure('network');
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// 6.5 No timer for the connection sensor itself
// ---------------------------------------------------------------------------------------

describe('no timer owned by the connection sensor (6.5)', () => {
  it('constructing and refreshing the service schedules no timer of its own', () => {
    const s = setup();
    const ctx = contextFor(s);
    const before = s.timers.pendingCount();
    const service = new ConnectionService(ctx);
    ctx.snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    service.refresh();
    ctx.snapshot.recordDeviceStatusFailure('network');
    service.refresh();

    // The snapshot's own overlay timers are unrelated to this service; ConnectionService itself
    // never calls `timers.setTimeout`, so the pending count is unchanged by anything it did.
    expect(s.timers.pendingCount()).toBe(before);
  });
});
