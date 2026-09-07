import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler } from '@homebridge/hap-nodejs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import {
  DeviceStatusSchema,
  SchedulesSchema,
  ServerStatusSchema,
  ServicesSchema,
  SettingsSchema,
  type ServerStatus,
} from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { SERVER_FAULT_SUBTYPE, ServerFaultService } from '../../src/services/serverFault.js';
import type { ServiceContext } from '../../src/services/types.js';
import { createFakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture = SchedulesSchema.parse(loadFixture('schedules.json'));
const servicesFixture = ServicesSchema.parse(loadFixture('services.json'));
const serverStatusFixture: ServerStatus = ServerStatusSchema.parse(loadFixture('serverStatus.json'));

function baseConfig(overrides: Record<string, unknown> = {}): FreeSleepConfig {
  return FreeSleepConfigSchema.parse({ host: 'pod.local', serverFaultSensor: true, ...overrides });
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

function contextFor(s: Setup): ServiceContext {
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
    config: baseConfig(),
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

const UUID = {
  contactState: Characteristic.ContactSensorState.UUID,
  statusFault: Characteristic.StatusFault.UUID,
  statusActive: Characteristic.StatusActive.UUID,
};

beforeEach(() => {
  vi.useFakeTimers();
});

describe('construction (8.5)', () => {
  it('adds exactly one ContactSensor named "Pod Server Fault" with subtype serverFault, carrying the three characteristics', () => {
    const s = setup();
    const ctx = contextFor(s);
    new ServerFaultService(ctx);

    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.ContactSensor.UUID);
    expect(sensors).toHaveLength(1);
    expect(sensors[0]?.subtype).toBe(SERVER_FAULT_SUBTYPE);
    expect(sensors[0]?.displayName).toBe('Pod Server Fault');

    const uuids = sensors[0]!.characteristics.map((c) => c.UUID);
    expect(uuids).toEqual(expect.arrayContaining([UUID.contactState, UUID.statusFault, UUID.statusActive]));
  });

  it('restores by getServiceById rather than adding a second sensor', () => {
    const s = setup();
    const ctx = contextFor(s);
    new ServerFaultService(ctx);
    new ServerFaultService(ctx);
    const sensors = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.ContactSensor.UUID);
    expect(sensors).toHaveLength(1);
  });
});

describe('a failed subsystem is reported', () => {
  it('a subsystem with a failed status flips ContactSensorState to fault-detected (not-detected)', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ServerFaultService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.observeServerStatus(serverStatusFixture);
    expect(handlers.get(UUID.contactState)!({} as never, undefined)).toBe(
      hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    const failed: ServerStatus = { ...serverStatusFixture, database: { ...serverStatusFixture.database, status: 'failed' } };
    ctx.snapshot.observeServerStatus(failed);
    expect(handlers.get(UUID.contactState)!({} as never, undefined)).toBe(
      hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
  });

  it('a healthy report clears the fault-detected state', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ServerFaultService(ctx));
    const hap = s.api.hap;

    const failed: ServerStatus = { ...serverStatusFixture, database: { ...serverStatusFixture.database, status: 'failed' } };
    ctx.snapshot.observeServerStatus(failed);
    ctx.snapshot.observeServerStatus(serverStatusFixture);
    expect(handlers.get(UUID.contactState)!({} as never, undefined)).toBe(
      hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
  });
});

describe('a failing observation of subsystem health is distinguished from a failing subsystem', () => {
  it('StatusFault flips while ContactSensorState is unchanged', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ServerFaultService(ctx));
    const hap = s.api.hap;

    ctx.snapshot.observeServerStatus(serverStatusFixture);
    expect(handlers.get(UUID.contactState)!({} as never, undefined)).toBe(
      hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    expect(handlers.get(UUID.statusFault)!({} as never, undefined)).toBe(hap.Characteristic.StatusFault.NO_FAULT);

    ctx.snapshot.recordServerStatusFailure('network');
    expect(handlers.get(UUID.contactState)!({} as never, undefined)).toBe(
      hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
    ); // unchanged — no evidence of an actual fault
    expect(handlers.get(UUID.statusFault)!({} as never, undefined)).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
  });
});

describe('StatusActive', () => {
  it('stays false across a launch that never successfully reaches serverStatus', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ServerFaultService(ctx));
    ctx.snapshot.recordServerStatusFailure('network');
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(false);
  });

  it('goes true on first success and stays true through a later failure', () => {
    const s = setup();
    const ctx = contextFor(s);
    const handlers = buildGetHandlers(() => new ServerFaultService(ctx));
    ctx.snapshot.observeServerStatus(serverStatusFixture);
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);
    ctx.snapshot.recordServerStatusFailure('network');
    expect(handlers.get(UUID.statusActive)!({} as never, undefined)).toBe(true);
  });
});
