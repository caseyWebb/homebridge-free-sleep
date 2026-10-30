import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { F_MAX, F_MIN } from '../../src/pod/temperature.js';
import { DeviceStatusSchema, SchedulesSchema, ServicesSchema, SettingsSchema, type Side } from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { CONFIGURED_NAME } from '../../src/services/serviceName.js';
import { SNOOZE_SUBTYPE, SnoozeService, snoozePatch } from '../../src/services/snooze.js';
import type { ServiceContext } from '../../src/services/types.js';
import { createFakePodClient, type FakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture = SchedulesSchema.parse(loadFixture('schedules.json'));
const servicesFixture = ServicesSchema.parse(loadFixture('services.json'));

const SIDES: readonly Side[] = ['left', 'right'];

function baseConfig(overrides: Record<string, unknown> = {}): FreeSleepConfig {
  return FreeSleepConfigSchema.parse({ host: 'pod.local', snoozeSwitch: true, ...overrides });
}

interface Setup {
  api: FakeHomebridgeApi;
  accessory: FakePlatformAccessory;
  snapshot: SnapshotStore;
  timers: TimerHarness;
  fake: FakePodClient;
  ctx: ServiceContext;
  warnings: string[];
}

function setup(options: { config?: Record<string, unknown>; observe?: boolean } = {}): Setup {
  const api = new FakeHomebridgeApi();
  const accessory = new api.platformAccessory('Right', api.hap.uuid.generate('right'), api.hap.Categories.THERMOSTAT);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  if (options.observe !== false) {
    snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    snapshot.observeSettings(structuredClone(settingsFixture));
  }
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schedules: schedulesFixture as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services: servicesFixture as any,
  });
  const config = baseConfig(options.config);
  const awayModeGuard = new AwayModeGuard({ snapshot, policy: config.awayModeWritePolicy });
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot,
    requestFastPoll: () => {},
    awayModeGuard,
    timers,
  });
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
    config,
    podClient: fake.client as unknown as MinimalPodClient,
  };
  return { api, accessory, snapshot, timers, fake, ctx, warnings };
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

describe('snoozePatch (pure)', () => {
  it('dismisses, turns the side on, and bumps the target by the delta', () => {
    expect(snoozePatch(88, 10)).toEqual({ isAlarmVibrating: false, isOn: true, targetTemperatureF: 98 });
  });

  it('accepts a negative delta', () => {
    expect(snoozePatch(88, -5)).toEqual({ isAlarmVibrating: false, isOn: true, targetTemperatureF: 83 });
  });

  it('clamps to the Pod range at both ends', () => {
    expect(snoozePatch(105, 10).targetTemperatureF).toBe(F_MAX);
    expect(snoozePatch(58, -10).targetTemperatureF).toBe(F_MIN);
  });

  it('rounds a fractional base to a whole degree', () => {
    expect(snoozePatch(87.6, 10).targetTemperatureF).toBe(98);
  });

  it('degrades to a plain dismiss when no target is known', () => {
    expect(snoozePatch(undefined, 10)).toEqual({ isAlarmVibrating: false });
  });
});

describe.each(SIDES)('construction (%s)', (side) => {
  it('adds exactly one Switch with the snooze subtype and seeds its ConfiguredName', () => {
    const s = setup();
    new SnoozeService(s.ctx, side);
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(SNOOZE_SUBTYPE);
    expect(switches[0]?.displayName).toBe(side === 'left' ? 'Snooze Left' : 'Snooze Right');
    expect(switches[0]?.getCharacteristic(s.api.hap.Characteristic.ConfiguredName).value).toBe(CONFIGURED_NAME.snooze);
  });

  it('restores by getServiceById rather than adding a second switch', () => {
    const s = setup();
    new SnoozeService(s.ctx, side);
    new SnoozeService(s.ctx, side);
    expect(s.accessory.services.filter((sv) => sv.subtype === SNOOZE_SUBTYPE)).toHaveLength(1);
  });
});

describe.each(SIDES)('pressing the %s Snooze submits one side patch, dispatched as a peeled dismiss plus the remainder', (side) => {
  it('dismisses the alarm (own guard-exempt write) then raises the cached target by the default 10°F, turning the side on', async () => {
    const s = setup();
    const base = s.snapshot.get()[side].targetTemperatureF!;
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, side));
    const pending = onSet(true, {} as never);
    // The overlay is installed at submission, before the debounced dispatch lands.
    expect(s.snapshot.get()[side].targetTemperatureF).toBe(base + 10);
    expect(s.snapshot.get()[side].isAlarmVibrating).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    // The write queue's N8 peel: the dismiss goes out first on its own (never guarded), then
    // the power/temperature remainder — so the alarm stops even if the remainder is refused.
    expect(s.fake.postDeviceStatusCalls).toEqual([
      { [side]: { isAlarmVibrating: false } },
      { [side]: { isOn: true, targetTemperatureF: base + 10 } },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('uses the configured snoozeTemperatureDeltaF', async () => {
    const s = setup({ config: { snoozeTemperatureDeltaF: -4 } });
    const base = s.snapshot.get()[side].targetTemperatureF!;
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, side));
    const pending = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(s.fake.postDeviceStatusCalls.at(-1)?.[side]?.targetTemperatureF).toBe(base - 4);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('two presses stack on the effective (overlaid) target, not the stale raw one', async () => {
    const s = setup();
    const base = s.snapshot.get()[side].targetTemperatureF!;
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, side));
    const first = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(400);
    await first;
    const second = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(400);
    await second;
    const targets = s.fake.postDeviceStatusCalls.map((c) => c[side]?.targetTemperatureF).filter((t) => t !== undefined);
    expect(targets).toEqual([base + 10, base + 20]);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('never writes the other side', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, side));
    const pending = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    const other: Side = side === 'left' ? 'right' : 'left';
    expect(s.fake.postDeviceStatusCalls.every((c) => c[other] === undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('an explicit off write submits nothing', async () => {
    const s = setup();
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, side));
    await onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.fake.postDeviceStatusCalls).toHaveLength(0);
  });
});

describe('degraded and failure paths', () => {
  it('with no cached target, dismisses only and warns', async () => {
    const s = setup({ observe: false });
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, 'right'));
    const pending = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(s.fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]);
    expect(s.warnings.some((w) => w.includes('no cached target temperature'))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('a failed write throws SERVICE_COMMUNICATION_FAILURE and warns', async () => {
    const s = setup();
    s.fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('boom') };
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, 'right'));
    const hap = s.api.hap;
    const pending = onSet(true, {} as never);
    const expectation = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(400);
    await expectation;
    expect(s.warnings.some((w) => w.includes('snooze write failed'))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
  });

  it("under the 'block' policy with the partner side away, the dismiss still lands and only the bump is refused as NOT_ALLOWED_IN_CURRENT_STATE", async () => {
    const s = setup({ config: { awayModeWritePolicy: 'block' } });
    const settings = structuredClone(settingsFixture);
    settings.left.awayMode = true;
    s.snapshot.observeSettings(settings);
    const onSet = buildOnSet(() => new SnoozeService(s.ctx, 'right'));
    const hap = s.api.hap;
    const pending = onSet(true, {} as never);
    const expectation = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE });
    await vi.advanceTimersByTimeAsync(400);
    await expectation;
    expect(s.fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]);
    await vi.advanceTimersByTimeAsync(1000);
  });
});

describe.each(SIDES)('the %s tile self-resets after ~1s regardless of outcome', (side) => {
  it('resets to off after ~1s on success', async () => {
    const s = setup();
    new SnoozeService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, SNOOZE_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);
    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(onChar.value).toBe(true);
    await vi.advanceTimersByTimeAsync(599);
    expect(onChar.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(onChar.value).toBe(false);
  });

  it('resets to off after ~1s on failure', async () => {
    const s = setup();
    s.fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('boom') };
    new SnoozeService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, SNOOZE_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);
    const pending = onChar.handleSetRequest(true).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChar.value).toBe(false);
  });

  it('stop() clears the pending reset timer', async () => {
    const s = setup();
    const service = new SnoozeService(s.ctx, side);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, SNOOZE_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);
    const pending = onChar.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    // The write has settled; only this service's own reset timer and the write queue's settle
    // bookkeeping remain. Stopping must remove exactly the reset timer.
    const before = s.timers.pendingCount();
    service.stop();
    expect(s.timers.pendingCount()).toBe(before - 1);
  });
});
