/**
 * `SkipAlarmService` (settings-switches, issue #17): skip-alarm-switch spec's own requirements —
 * synchronous read derived from `scheduleOverrides.alarm.expiresAt`, self-clearing once it
 * lapses (no write), a >= 2s service-level debounce, the noon-based next-occurrence computation,
 * and communication-failure surfacing with a reverted displayed value.
 */
import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler, CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SchedulesSchema, SettingsSchema, type DeviceStatus, type Schedules, type Settings } from '../../src/pod/types.js';
import { WriteQueue, type FastPollLane } from '../../src/pod/writeQueue.js';
import { isSkipAlarmOn, SKIP_ALARM_SUBTYPE, SkipAlarmService } from '../../src/services/skipAlarm.js';
import type { ServiceContext } from '../../src/services/types.js';
import { createFakePodClient, type FakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture: DeviceStatus = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture: Settings = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture: Schedules = SchedulesSchema.parse(loadFixture('schedules.json'));
const servicesFixture = loadFixture('services.json');

function baseConfig(overrides: Record<string, unknown> = {}): FreeSleepConfig {
  return FreeSleepConfigSchema.parse({ host: 'pod.local', ...overrides });
}

interface Setup {
  api: FakeHomebridgeApi;
  accessory: FakePlatformAccessory;
  snapshot: SnapshotStore;
  timers: TimerHarness;
  fake: FakePodClient;
  writeQueue: WriteQueue;
  fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }>;
  ctx: ServiceContext;
}

function setup(
  options: { config?: Record<string, unknown>; side?: 'left' | 'right'; settings?: Settings; schedules?: Schedules } = {},
): Setup {
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const side = options.side ?? 'left';
  const accessory = new api.platformAccessory(`Pod ${side}`, api.hap.uuid.generate(side), api.hap.Categories.THERMOSTAT);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  const settings = options.settings ?? settingsFixture;
  const schedules = options.schedules ?? schedulesFixture;
  snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
  snapshot.observeSettings(structuredClone(settings));
  snapshot.observeSchedules(structuredClone(schedules));
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings,
    schedules,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services: servicesFixture as any,
  });
  const fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }> = [];
  const config = baseConfig(options.config);
  const awayModeGuard = new AwayModeGuard({ snapshot, policy: config.awayModeWritePolicy });
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot,
    requestFastPoll: (lane, untilMs) => fastPollRequests.push({ lane, untilMs }),
    awayModeGuard,
    timers,
    writeSettleMs: config.writeSettleMs,
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
  return { api, accessory, snapshot, timers, fake, writeQueue, fastPollRequests, ctx };
}

function build(
  ctx: ServiceContext,
  side: 'left' | 'right',
  platformStartedAt = ctx.timers.now(),
): { service: SkipAlarmService; onGet: CharacteristicGetHandler; onSet: CharacteristicSetHandler } {
  let onGet!: CharacteristicGetHandler;
  let onSet!: CharacteristicSetHandler;
  const getSpy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicGetHandler,
  ) {
    if (this.UUID === Characteristic.On.UUID) onGet = handler;
    return this;
  });
  const setSpy = vi.spyOn(Characteristic.prototype, 'onSet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicSetHandler,
  ) {
    if (this.UUID === Characteristic.On.UUID) onSet = handler;
    return this;
  });
  const service = new SkipAlarmService(ctx, side, platformStartedAt);
  getSpy.mockRestore();
  setSpy.mockRestore();
  return { service, onGet, onSet };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// isSkipAlarmOn — pure helper (tasks.md 1.2)
// ---------------------------------------------------------------------------------------

describe('isSkipAlarmOn (tasks.md 1.2)', () => {
  it('empty expiresAt is off', () => {
    expect(isSkipAlarmOn('', 1000)).toBe(false);
    expect(isSkipAlarmOn(undefined, 1000)).toBe(false);
  });

  it('a past expiresAt is off', () => {
    expect(isSkipAlarmOn(new Date(500).toISOString(), 1000)).toBe(false);
  });

  it('a future expiresAt is on', () => {
    expect(isSkipAlarmOn(new Date(2000).toISOString(), 1000)).toBe(true);
  });

  it('an unparseable expiresAt is off', () => {
    expect(isSkipAlarmOn('not-a-date', 1000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------

describe('construction (5.1)', () => {
  it('adds exactly one Switch named "Skip Next Alarm Left" with subtype skipAlarm', () => {
    const { ctx, accessory, api } = setup();
    new SkipAlarmService(ctx, 'left', 0);
    const switches = accessory.services.filter((s) => s.UUID === api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(SKIP_ALARM_SUBTYPE);
    expect(switches[0]?.displayName).toBe('Skip Next Alarm Left');
  });

  it('restores by getServiceById rather than adding a second switch', () => {
    const { ctx, accessory, api } = setup();
    new SkipAlarmService(ctx, 'left', 0);
    new SkipAlarmService(ctx, 'left', 0);
    const switches = accessory.services.filter((s) => s.UUID === api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// onGet — derivation and self-clearing (5.1)
// ---------------------------------------------------------------------------------------

describe('onGet: derives on/off from scheduleOverrides.alarm.expiresAt, with no request (5.1)', () => {
  it('an unexpired override reads as on', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const settings: Settings = {
      ...structuredClone(settingsFixture),
      left: {
        ...settingsFixture.left,
        scheduleOverrides: { ...settingsFixture.left.scheduleOverrides, alarm: { disabled: true, timeOverride: '', expiresAt: new Date(nowMs + 60_000).toISOString() } },
      },
    };
    const { ctx, fake } = setup({ settings });
    const { onGet } = build(ctx, 'left');
    expect(onGet({} as never)).toBe(true);
    expect(fake.postSettingsCalls).toHaveLength(0);
  });

  it('an expired or empty override reads as off', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const settings: Settings = {
      ...structuredClone(settingsFixture),
      left: {
        ...settingsFixture.left,
        scheduleOverrides: { ...settingsFixture.left.scheduleOverrides, alarm: { disabled: true, timeOverride: '', expiresAt: new Date(nowMs - 60_000).toISOString() } },
      },
    };
    const { ctx } = setup({ settings });
    const { onGet } = build(ctx, 'left');
    expect(onGet({} as never)).toBe(false);
  });

  it('self-clears once the override lapses, with no write, once fake time advances past expiresAt', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const settings: Settings = {
      ...structuredClone(settingsFixture),
      left: {
        ...settingsFixture.left,
        scheduleOverrides: { ...settingsFixture.left.scheduleOverrides, alarm: { disabled: true, timeOverride: '', expiresAt: new Date(nowMs + 60_000).toISOString() } },
      },
    };
    const { ctx, fake } = setup({ settings });
    const { onGet } = build(ctx, 'left');
    expect(onGet({} as never)).toBe(true);

    vi.setSystemTime(nowMs + 61_000);
    expect(onGet({} as never)).toBe(false);
    expect(fake.postSettingsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// onSet ON — computation and write shape (5.2)
// ---------------------------------------------------------------------------------------

describe('onSet ON: computes the next-alarm expiresAt and writes it (5.2)', () => {
  it('before noon: writes an expiresAt targeting the sleep-day schedule\'s alarm time + 2 minutes, on a full ISO-8601 (UTC) string', async () => {
    const schedules: Schedules = structuredClone(schedulesFixture);
    schedules.left.tuesday.alarm.time = '06:45';
    const settings: Settings = { ...structuredClone(settingsFixture), timeZone: 'UTC' };
    const { ctx, fake, fastPollRequests } = setup({ settings, schedules });

    // Wednesday 2026-01-07 09:00 UTC, before noon; sleep-day (now-12h) is Tuesday.
    vi.setSystemTime(Date.UTC(2026, 0, 7, 9, 0, 0));
    const { onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2000); // service debounce
    await vi.advanceTimersByTimeAsync(500); // writeQueue's own settings-lane debounce + dispatch
    await p;

    const expected = new Date(Date.UTC(2026, 0, 7, 6, 47, 0)).toISOString();
    expect(fake.postSettingsCalls).toEqual([
      { left: { scheduleOverrides: { alarm: { disabled: true, timeOverride: '', expiresAt: expected } } } },
    ]);
    expect(expected.endsWith('Z')).toBe(true); // a complete ISO-8601 instant, not a bare local time
    // 5.4: the shipped settleWrite machinery requests a settings re-read on success.
    expect(fastPollRequests.some((r) => r.lane === 'settings')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// onSet OFF (5.3)
// ---------------------------------------------------------------------------------------

describe('onSet OFF: clears the override outright (5.3)', () => {
  it('writes disabled:false, timeOverride:"", expiresAt:""', async () => {
    const { ctx, fake } = setup();
    const { onSet } = build(ctx, 'left');
    const p = onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(fake.postSettingsCalls).toEqual([
      { left: { scheduleOverrides: { alarm: { disabled: false, timeOverride: '', expiresAt: '' } } } },
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// Debounce (5.4)
// ---------------------------------------------------------------------------------------

describe('rapid toggling produces at most one write, carrying the final state (5.4)', () => {
  it('two toggles within 2s produce exactly one write, carrying the final (off) state', async () => {
    const { ctx, fake } = setup();
    const { onSet } = build(ctx, 'left');
    const p1 = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(500);
    const p2 = onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all([p1, p2]);
    expect(fake.postSettingsCalls).toEqual([
      { left: { scheduleOverrides: { alarm: { disabled: false, timeOverride: '', expiresAt: '' } } } },
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// Failure surfacing
// ---------------------------------------------------------------------------------------

describe('a failed write throws SERVICE_COMMUNICATION_FAILURE and reverts the displayed value', () => {
  it('throws, and onGet immediately reads the last-confirmed (off) value', async () => {
    const { ctx, fake, api } = setup();
    fake.postSettingsOutcome = { kind: 'error', error: new Error('network down') };
    const { onGet, onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;

    expect(onGet({} as never)).toBe(false);
  });

  it('pushes a corrective updateValue(false) to the characteristic ~500ms after the failure, not immediately', async () => {
    const { ctx, fake, api } = setup();
    fake.postSettingsOutcome = { kind: 'error', error: new Error('network down') };
    const { onSet } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------------------

describe('stop() clears pending timers and rejects an unsubmitted write', () => {
  it('a debounced write not yet submitted rejects when stop() runs, and no timer is left', async () => {
    const { ctx, timers } = setup();
    const service = new SkipAlarmService(ctx, 'left', 0);
    const onChar = ctx.accessory
      .getServiceById(ctx.api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!
      .getCharacteristic(ctx.api.hap.Characteristic.On);

    const before = timers.pendingCount();
    const pending = onChar.handleSetRequest(true);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(timers.pendingCount()).toBeGreaterThan(before);

    service.stop();
    await expect(pending).rejects.toThrow();
    expect(timers.pendingCount()).toBe(before);
  });
});
