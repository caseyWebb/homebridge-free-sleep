import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SchedulesSchema, ServicesSchema, SettingsSchema, type AlarmRequest } from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { TEST_ALARM_SUBTYPE, TestAlarmService } from '../../src/services/testAlarm.js';
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

describe('construction (8.4)', () => {
  it('adds exactly one Switch named "Pod Test Alarm" with subtype testAlarm', () => {
    const s = setup();
    new TestAlarmService(s.ctx);
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(TEST_ALARM_SUBTYPE);
    expect(switches[0]?.displayName).toBe('Pod Test Alarm');
  });
});

describe('turning the switch on sends an overriding trigger to both sides', () => {
  it('calls postAlarm with force: true for left and right', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new TestAlarmService(s.ctx));
    onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.postAlarmCalls).toHaveLength(2);
    expect(s.postAlarmCalls.map((c) => c.side).sort()).toEqual(['left', 'right']);
    for (const call of s.postAlarmCalls) {
      expect(call.force).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('an explicit off write triggers nothing', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new TestAlarmService(s.ctx));
    onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.postAlarmCalls).toHaveLength(0);
  });
});

describe('the switch self-resets on the same short timeline regardless of outcome', () => {
  it('resets to off after ~1s when the trigger succeeds', async () => {
    const s = setup(); // default: postAlarm resolves
    new TestAlarmService(s.ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPE)!;
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
    new TestAlarmService(s.ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    await vi.advanceTimersByTimeAsync(1000);
    expect(onChar.value).toBe(false);
  });

  it('the reset requires no characteristic write from any controller', async () => {
    const s = setup();
    new TestAlarmService(s.ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);
    const updateSpy = vi.spyOn(onChar, 'updateValue');

    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(updateSpy).toHaveBeenCalledWith(false);
  });
});

describe('stop() clears the pending self-reset timer', () => {
  it('leaves no pending timer after a trigger followed by stop()', async () => {
    const s = setup();
    const service = new TestAlarmService(s.ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, TEST_ALARM_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    const before = s.timers.pendingCount();
    onChar.setValue(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.timers.pendingCount()).toBeGreaterThan(before);

    service.stop();
    expect(s.timers.pendingCount()).toBe(before);
  });
});
