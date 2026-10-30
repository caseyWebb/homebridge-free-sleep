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
import { CONFIGURED_NAME } from '../../src/services/serviceName.js';
import type { ServiceContext } from '../../src/services/types.js';
import { WAKE_ALARM_SUBTYPE, WakeAlarmService } from '../../src/services/wakeAlarm.js';
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
  return FreeSleepConfigSchema.parse({ host: 'pod.local', wakeAlarmSwitch: true, ...overrides });
}

interface Setup {
  api: FakeHomebridgeApi;
  accessory: FakePlatformAccessory;
  snapshot: SnapshotStore;
  timers: TimerHarness;
  postAlarmCalls: AlarmRequest[];
  ctx: ServiceContext;
  warnings: string[];
}

function setup(options: { postAlarm?: (request: AlarmRequest) => Promise<void>; config?: Record<string, unknown> } = {}): Setup {
  const api = new FakeHomebridgeApi();
  const accessory = new api.platformAccessory('Right', api.hap.uuid.generate('right'), api.hap.Categories.THERMOSTAT);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  const log = createFakeLogging();
  const warnings: string[] = [];
  const originalWarn = log.warn;
  log.warn = ((message: string, ...rest: unknown[]) => {
    warnings.push(message);
    return originalWarn.call(log, message, ...rest);
  }) as typeof log.warn;
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
      if (options.postAlarm) await options.postAlarm(request);
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
    config: baseConfig(options.config),
    podClient,
  };
  return { api, accessory, snapshot, timers, postAlarmCalls, ctx, warnings };
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

describe.each(SIDES)('construction (%s)', (side) => {
  it('adds exactly one Switch with the wakeAlarm subtype and seeds its ConfiguredName', () => {
    const s = setup();
    new WakeAlarmService(s.ctx, side);
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(WAKE_ALARM_SUBTYPE);
    expect(switches[0]?.displayName).toBe(side === 'left' ? 'Wake Alarm Left' : 'Wake Alarm Right');
    expect(switches[0]?.getCharacteristic(s.api.hap.Characteristic.ConfiguredName).value).toBe(CONFIGURED_NAME.wakeAlarm);
  });

  it('restores by getServiceById rather than adding a second switch', () => {
    const s = setup();
    new WakeAlarmService(s.ctx, side);
    new WakeAlarmService(s.ctx, side);
    const switches = s.accessory.services.filter(
      (sv) => sv.UUID === s.api.hap.Service.Switch.UUID && sv.subtype === WAKE_ALARM_SUBTYPE,
    );
    expect(switches).toHaveLength(1);
  });
});

describe.each(SIDES)('turning the %s switch on fires the configured alarm for that side only', (side) => {
  it('posts the config defaults (180s, intensity 100, double) with force: true', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new WakeAlarmService(s.ctx, side));
    await onSet(true, {} as never);
    expect(s.postAlarmCalls).toEqual([
      { side, duration: 180, vibrationIntensity: 100, vibrationPattern: 'double', force: true },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('posts the configured wakeAlarm parameters when overridden', async () => {
    const s = setup({ config: { wakeAlarm: { duration: 45, vibrationIntensity: 30, vibrationPattern: 'rise' } } });
    const onSet = buildOnSet(() => new WakeAlarmService(s.ctx, side));
    await onSet(true, {} as never);
    expect(s.postAlarmCalls).toEqual([{ side, duration: 45, vibrationIntensity: 30, vibrationPattern: 'rise', force: true }]);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('an explicit off write triggers nothing', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new WakeAlarmService(s.ctx, side));
    await onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.postAlarmCalls).toHaveLength(0);
  });

  it('never fires the other side', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new WakeAlarmService(s.ctx, side));
    await onSet(true, {} as never);
    expect(s.postAlarmCalls.map((c) => c.side)).toEqual([side]);
    await vi.advanceTimersByTimeAsync(1000);
  });
});

describe('a rejected postAlarm surfaces to HomeKit, unlike the hub test-alarm switch', () => {
  it('throws SERVICE_COMMUNICATION_FAILURE and logs at warn', async () => {
    const s = setup({ postAlarm: () => Promise.reject(new Error('network down')) });
    const onSet = buildOnSet(() => new WakeAlarmService(s.ctx, 'right'));
    const hap = s.api.hap;
    await expect(onSet(true, {} as never)).rejects.toMatchObject({ hapStatus: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    expect(s.warnings.some((w) => w.includes('wake-alarm trigger failed'))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
  });
});

describe.each(SIDES)('the %s switch self-resets after ~1s regardless of outcome', (side) => {
  it('resets to off after ~1s when the trigger succeeds', async () => {
    const s = setup();
    new WakeAlarmService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, WAKE_ALARM_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(onChar.value).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(onChar.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(onChar.value).toBe(false);
  });

  it('resets to off after ~1s even when the trigger fails', async () => {
    const s = setup({ postAlarm: () => Promise.reject(new Error('network down')) });
    new WakeAlarmService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, WAKE_ALARM_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    const pending = onChar.handleSetRequest(true).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    await vi.advanceTimersByTimeAsync(1000);
    expect(onChar.value).toBe(false);
  });

  it('stop() clears the pending reset timer', async () => {
    const s = setup();
    const service = new WakeAlarmService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, WAKE_ALARM_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);
    const before = s.timers.pendingCount();
    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(s.timers.pendingCount()).toBe(before + 1);
    service.stop();
    expect(s.timers.pendingCount()).toBe(before);
  });
});
