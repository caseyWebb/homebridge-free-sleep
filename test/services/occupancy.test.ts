import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SchedulesSchema, ServicesSchema, SettingsSchema } from '../../src/pod/types.js';
import { WriteQueue, type FastPollLane } from '../../src/pod/writeQueue.js';
import { isOccupancyChange, OCCUPANCY_SUBTYPE, OccupancySensorService } from '../../src/services/occupancy.js';
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
  const accessory = new api.platformAccessory('Pod Left', api.hap.uuid.generate('left'), api.hap.Categories.THERMOSTAT);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
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
  const awayModeGuard = new AwayModeGuard({ snapshot: setupResult.snapshot, policy: 'mirror' });
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot: setupResult.snapshot,
    requestFastPoll: (lane, untilMs) => fastPollRequests.push({ lane, untilMs }),
    awayModeGuard,
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
    awayModeGuard,
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
  occupancyDetected: Characteristic.OccupancyDetected.UUID,
  statusActive: Characteristic.StatusActive.UUID,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 7.1 Construction
// ---------------------------------------------------------------------------------------

describe('construction (7.1)', () => {
  it('adds exactly one OccupancySensor with subtype occupancy, carrying OccupancyDetected and StatusActive', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    new OccupancySensorService(ctx, 'left');

    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.OccupancySensor.UUID);
    expect(sensors).toHaveLength(1);
    const service = sensors[0]!;
    expect(service.subtype).toBe(OCCUPANCY_SUBTYPE);

    const uuids = service.characteristics.map((c) => c.UUID);
    expect(uuids).toEqual(expect.arrayContaining([UUID.occupancyDetected, UUID.statusActive]));
  });

  it('N4: names the service distinctly from the accessory-wide displayName, avoiding a name collision with the thermostat tile', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    new OccupancySensorService(ctx, 'left');

    const service = s.accessory.getServiceById(s.api.hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)!;
    // `ThermostatService` names its own service `accessory.displayName` verbatim
    // (`../../src/services/thermostat.ts`) — this must not be the same string.
    expect(service.displayName).not.toBe(s.accessory.displayName);
    expect(service.displayName).toBe(`${s.accessory.displayName} Occupancy`);
  });

  it('restores by getServiceById rather than adding a second OccupancySensor', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    new OccupancySensorService(ctx, 'left');
    new OccupancySensorService(ctx, 'left');

    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.OccupancySensor.UUID);
    expect(sensors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// 7.2 Source switch and never-throwing reads
// ---------------------------------------------------------------------------------------

describe('source switch and read semantics (7.2)', () => {
  it('never-observed source serves characteristic.value without throwing', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    const handlers = buildGetHandlers(() => new OccupancySensorService(ctx, 'left'));

    expect(() => handlers.get(UUID.occupancyDetected)!({} as never, undefined)).not.toThrow();
    expect(() => handlers.get(UUID.statusActive)!({} as never, undefined)).not.toThrow();
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(false);
  });

  it("presence source: observed-not-proven reports the raw occupied value with StatusActive false", () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    const hap = s.api.hap;
    const handlers = buildGetHandlers(() => new OccupancySensorService(ctx, 'left'));

    ctx.snapshot.observePresence({ left: { present: true, lastUpdatedAt: 't0' } });
    expect(handlers.get(UUID.occupancyDetected)!({} as never, undefined)).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(false);
  });

  it('presence source: a real transition proves the source live', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    const handlers = buildGetHandlers(() => new OccupancySensorService(ctx, 'left'));

    ctx.snapshot.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    ctx.snapshot.observePresence({ left: { present: true, lastUpdatedAt: 't1' } });
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);
  });

  it('vitals source: reads vitalsOccupied/vitalsActive, not presence fields', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'vitals' });
    const hap = s.api.hap;
    const handlers = buildGetHandlers(() => new OccupancySensorService(ctx, 'left'));

    // A presence observation must have no bearing on the vitals-sourced sensor.
    ctx.snapshot.observePresence({ left: { present: true, lastUpdatedAt: 't0' } });
    expect(handlers.get(UUID.occupancyDetected)!({} as never, undefined)).toBe(
      hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(false);

    ctx.snapshot.observeVitals([{ id: 1, side: 'left', timestamp: 't0', heart_rate: 60, hrv: null, breathing_rate: null }]);
    expect(handlers.get(UUID.occupancyDetected)!({} as never, undefined)).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    // Proven on the very first row — no "wait for a change" requirement (design.md's asymmetry).
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);
  });

  it('vitals source: StatusActive stays true after a later empty poll; only occupancy changes', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'vitals' });
    const hap = s.api.hap;
    const handlers = buildGetHandlers(() => new OccupancySensorService(ctx, 'left'));

    ctx.snapshot.observeVitals([{ id: 1, side: 'left', timestamp: 't0', heart_rate: 60, hrv: null, breathing_rate: null }]);
    ctx.snapshot.observeVitals([]);
    expect(handlers.get(UUID.occupancyDetected)!({} as never, undefined)).toBe(
      hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);
  });

  it('an unreachable Pod never fails a read: last-known values keep serving, StatusActive simply stops advancing', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    const hap = s.api.hap;
    const handlers = buildGetHandlers(() => new OccupancySensorService(ctx, 'left'));

    ctx.snapshot.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    ctx.snapshot.observePresence({ left: { present: true, lastUpdatedAt: 't1' } }); // proven
    ctx.snapshot.recordDeviceStatusFailure('network'); // an outage on a wholly unrelated poll

    expect(() => handlers.get(UUID.occupancyDetected)!({} as never, undefined)).not.toThrow();
    expect(handlers.get(UUID.occupancyDetected)!({} as never, undefined)).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// 7.3 refresh() / push-on-change
// ---------------------------------------------------------------------------------------

describe('refresh() pushes only on an actual change (7.3)', () => {
  it('no push when neither value changed', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    ctx.snapshot.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    const service = new OccupancySensorService(ctx, 'left');
    const hapService = s.accessory.getServiceById(s.api.hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)!;
    const spy = vi.spyOn(hapService.getCharacteristic(s.api.hap.Characteristic.OccupancyDetected), 'updateValue');

    service.refresh(); // already settled by the constructor's own B1 refresh() call
    expect(spy).not.toHaveBeenCalled();
  });

  it('a getting-into-bed transition pushes OccupancyDetected', () => {
    const s = setup();
    const ctx = contextFor(s, { occupancySource: 'presence' });
    ctx.snapshot.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    const service = new OccupancySensorService(ctx, 'left');
    const hapService = s.accessory.getServiceById(s.api.hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)!;
    const spy = vi.spyOn(hapService.getCharacteristic(s.api.hap.Characteristic.OccupancyDetected), 'updateValue');

    ctx.snapshot.observePresence({ left: { present: true, lastUpdatedAt: 't1' } });
    service.refresh();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------
// isOccupancyChange routing predicate
// ---------------------------------------------------------------------------------------

describe('isOccupancyChange', () => {
  it('matches all four occupancy fields, on the side scope only', () => {
    for (const field of ['presencePresent', 'presenceActive', 'vitalsOccupied', 'vitalsActive'] as const) {
      expect(isOccupancyChange({ scope: 'side', field, side: 'left', previous: false, current: true })).toBe(true);
    }
  });

  it('does not match an unrelated field, or a device-scope change', () => {
    expect(
      isOccupancyChange({ scope: 'side', field: 'targetTemperatureF', side: 'left', previous: 60, current: 65 }),
    ).toBe(false);
    expect(isOccupancyChange({ scope: 'device', field: 'connectionOnline', previous: false, current: true })).toBe(false);
  });
});
