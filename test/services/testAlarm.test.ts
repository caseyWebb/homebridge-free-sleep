import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import {
  DeviceStatusSchema,
  SchedulesSchema,
  ServicesSchema,
  SettingsSchema,
  type AlarmRequest,
  type Side,
} from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { TEST_ALARM_CONFIGURED_NAME } from '../../src/services/serviceName.js';
import {
  TEST_ALARM_LEFT_SUBTYPE,
  TEST_ALARM_RIGHT_SUBTYPE,
  TEST_ALARM_SUBTYPES,
  TestAlarmService,
} from '../../src/services/testAlarm.js';
import type { ServiceContext } from '../../src/services/types.js';
import { captureCharacteristicWarnings } from './configuredNameHelpers.js';
import { createFakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture = SchedulesSchema.parse(loadFixture('schedules.json'));
const servicesFixture = ServicesSchema.parse(loadFixture('services.json'));

const SIDES: readonly Side[] = ['left', 'right'];

function baseConfig(overrides: Record<string, unknown> = {}): FreeSleepConfig {
  return FreeSleepConfigSchema.parse({ host: 'pod.local', testAlarmSwitch: true, ...overrides });
}

interface Setup {
  api: FakeHomebridgeApi;
  accessory: FakePlatformAccessory;
  snapshot: SnapshotStore;
  timers: TimerHarness;
  postAlarmCalls: AlarmRequest[];
  ctx: ServiceContext;
}

function setup(postAlarmImpl?: (request: AlarmRequest) => Promise<void>): Setup {
  const api = new FakeHomebridgeApi();
  const accessory = new api.platformAccessory('Pod', api.hap.uuid.generate('hub'), api.hap.Categories.OTHER);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  const log = createFakeLogging();
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings: settingsFixture,
    schedules: schedulesFixture,
    services: servicesFixture,
  });
  const awayModeGuard = new AwayModeGuard({ snapshot, policy: 'mirror' });
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot,
    requestFastPoll: () => {},
    awayModeGuard,
    timers,
  });

  const postAlarmCalls: AlarmRequest[] = [];
  const podClient: MinimalPodClient = {
    getDeviceStatus: () => Promise.reject(new Error('unused')),
    getSettings: () => Promise.reject(new Error('unused')),
    getSchedules: () => Promise.reject(new Error('unused')),
    getServices: () => Promise.reject(new Error('unused')),
    getServerStatus: () => Promise.reject(new Error('unused')),
    postDeviceStatus: () => Promise.reject(new Error('unused')),
    postSettings: () => Promise.reject(new Error('unused')),
    postAlarm: async (request) => {
      postAlarmCalls.push(request);
      if (postAlarmImpl) await postAlarmImpl(request);
    },
  };

  const ctx: ServiceContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: api.asApi() as any,
    log,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessory: accessory as any,
    snapshot,
    writeQueue,
    awayModeGuard,
    timers,
    config: baseConfig(),
    podClient,
  };
  return { api, accessory, snapshot, timers, postAlarmCalls, ctx };
}

function buildOnSet(build: () => void): CharacteristicSetHandler {
  let onSet!: CharacteristicSetHandler;
  const spy = vi.spyOn(Characteristic.prototype, 'onSet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicSetHandler,
  ) {
    onSet = handler;
    return this;
  });
  build();
  spy.mockRestore();
  return onSet;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('construction (8.4, revised G0 — two per-side switches)', () => {
  it('adds exactly one Switch named "Test Alarm Left" with subtype testAlarmLeft', () => {
    const s = setup();
    new TestAlarmService(s.ctx, 'left');
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(TEST_ALARM_LEFT_SUBTYPE);
    expect(switches[0]?.displayName).toBe('Test Alarm Left');
  });

  it('adds exactly one Switch named "Test Alarm Right" with subtype testAlarmRight', () => {
    const s = setup();
    new TestAlarmService(s.ctx, 'right');
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(TEST_ALARM_RIGHT_SUBTYPE);
    expect(switches[0]?.displayName).toBe('Test Alarm Right');
  });

  it('both sides construct two independent switches on the same accessory', () => {
    const s = setup();
    new TestAlarmService(s.ctx, 'left');
    new TestAlarmService(s.ctx, 'right');
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(2);
    expect(switches.map((sv) => sv.subtype).sort()).toEqual([TEST_ALARM_LEFT_SUBTYPE, TEST_ALARM_RIGHT_SUBTYPE].sort());
  });

  it('restores by getServiceById rather than adding a second switch, per side', () => {
    const s = setup();
    new TestAlarmService(s.ctx, 'left');
    new TestAlarmService(s.ctx, 'left');
    const switches = s.accessory.services.filter(
      (sv) => sv.UUID === s.api.hap.Service.Switch.UUID && sv.subtype === TEST_ALARM_LEFT_SUBTYPE,
    );
    expect(switches).toHaveLength(1);
  });
});

describe.each(SIDES)('turning the %s switch on triggers only that side (G0)', (side) => {
  it(`calls postAlarm with force: true for ${side} only`, async () => {
    const s = setup();
    const onSet = buildOnSet(() => new TestAlarmService(s.ctx, side));
    onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.postAlarmCalls).toHaveLength(1);
    expect(s.postAlarmCalls[0]?.side).toBe(side);
    expect(s.postAlarmCalls[0]?.force).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('an explicit off write triggers nothing', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new TestAlarmService(s.ctx, side));
    onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.postAlarmCalls).toHaveLength(0);
  });
});

describe('the other side is never triggered by a one-sided switch (G0 regression)', () => {
  it('turning on the left switch never calls postAlarm for right, and vice versa', async () => {
    const s = setup();
    const leftOnSet = buildOnSet(() => new TestAlarmService(s.ctx, 'left'));
    const rightOnSet = buildOnSet(() => new TestAlarmService(s.ctx, 'right'));

    leftOnSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.postAlarmCalls.map((c) => c.side)).toEqual(['left']);
    await vi.advanceTimersByTimeAsync(1000);

    rightOnSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.postAlarmCalls.map((c) => c.side)).toEqual(['left', 'right']);
    await vi.advanceTimersByTimeAsync(1000);
  });
});

describe.each(SIDES)('the %s switch self-resets on the same short timeline regardless of outcome', (side) => {
  it('resets to off after ~1s when the trigger succeeds', async () => {
    const s = setup(); // default: postAlarm resolves
    new TestAlarmService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPES[side])!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    // `handleSetRequest` is HAP's own real entry point: our (synchronous) onSet handler resolves
    // immediately, so HAP assigns `.value = true` right away, before the 1s reset timer fires.
    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(onChar.value).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(onChar.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(onChar.value).toBe(false);
  });

  it('resets to off after ~1s even when the triggering request fails', async () => {
    const s = setup(() => Promise.reject(new Error('network down')));
    new TestAlarmService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPES[side])!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    await vi.advanceTimersByTimeAsync(1000);
    expect(onChar.value).toBe(false);
  });

  it('the reset requires no characteristic write from any controller', async () => {
    const s = setup();
    new TestAlarmService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPES[side])!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);
    const updateSpy = vi.spyOn(onChar, 'updateValue');

    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateSpy).toHaveBeenCalledWith(false);
  });
});

describe.each(SIDES)('stop() clears the %s switch\'s pending self-reset timer', (side) => {
  it('leaves no pending timer after a trigger followed by stop()', async () => {
    const s = setup();
    const service = new TestAlarmService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPES[side])!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    const before = s.timers.pendingCount();
    onChar.setValue(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.timers.pendingCount()).toBeGreaterThan(before);

    service.stop();
    expect(s.timers.pendingCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------
// ConfiguredName seeding (release-polish tasks.md 2.11)
// ---------------------------------------------------------------------------------------

describe('ConfiguredName seeding (2.11)', () => {
  it('seeds "Test Alarm Left" / "Test Alarm Right" on first construction — distinct labels on the same hub accessory', () => {
    const s = setup();
    new TestAlarmService(s.ctx, 'left');
    new TestAlarmService(s.ctx, 'right');
    const left = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_LEFT_SUBTYPE)!;
    const right = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_RIGHT_SUBTYPE)!;
    expect(left.getCharacteristic(Characteristic.ConfiguredName).value).toBe(TEST_ALARM_CONFIGURED_NAME.left);
    expect(right.getCharacteristic(Characteristic.ConfiguredName).value).toBe(TEST_ALARM_CONFIGURED_NAME.right);
    expect(left.getCharacteristic(Characteristic.ConfiguredName).value).not.toBe(
      right.getCharacteristic(Characteristic.ConfiguredName).value,
    );
  });

  it('leaves an existing ConfiguredName (e.g. a controller rename) untouched on reconstruction', () => {
    const s = setup();
    new TestAlarmService(s.ctx, 'left');
    const service = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_LEFT_SUBTYPE)!;
    service.getCharacteristic(Characteristic.ConfiguredName).updateValue('Bedroom Test Alarm');

    new TestAlarmService(s.ctx, 'left'); // simulates a restart against the same accessory

    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Bedroom Test Alarm');
  });

  it('adds ConfiguredName without emitting a characteristic-warning event', () => {
    const s = setup();
    const warnings = captureCharacteristicWarnings(s.accessory);
    new TestAlarmService(s.ctx, 'left');
    new TestAlarmService(s.ctx, 'right');
    expect(warnings).toHaveLength(0);
  });
});
