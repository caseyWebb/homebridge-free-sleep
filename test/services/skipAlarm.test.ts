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
import { CONFIGURED_NAME } from '../../src/services/serviceName.js';
import { isSkipAlarmChange, isSkipAlarmOn, SKIP_ALARM_SUBTYPE, SkipAlarmService } from '../../src/services/skipAlarm.js';
import type { ServiceContext } from '../../src/services/types.js';
import { captureCharacteristicWarnings } from './configuredNameHelpers.js';
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

    // Wednesday 2026-01-07 05:00 UTC, before noon and before today's 06:45 alarm has rung yet
    // (S5, settings-switches PR #46 review: a "before noon" instant that falls *after* today's
    // already-elapsed alarm — e.g. 09:00 here — lands in the post-alarm-to-noon dead window and
    // is correctly refused instead; see the dedicated 5.5 tests below). Sleep-day (now-12h) is
    // Tuesday.
    vi.setSystemTime(Date.UTC(2026, 0, 7, 5, 0, 0));
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
// S5 (settings-switches PR #46 review): the post-alarm-to-noon dead window — a "before noon"
// instant that has already elapsed (today's alarm already rang) must refuse the toggle, not
// make an expensive settings write that skips nothing.
// ---------------------------------------------------------------------------------------

describe('S5: the post-alarm-to-noon dead window refuses the toggle instead of writing a no-op skip', () => {
  function deadWindowSetup(nowUtc: [number, number, number, number, number, number]): ReturnType<typeof setup> {
    const schedules: Schedules = structuredClone(schedulesFixture);
    schedules.left.tuesday.alarm.time = '06:45';
    const settings: Settings = { ...structuredClone(settingsFixture), timeZone: 'UTC' };
    const s = setup({ settings, schedules });
    vi.setSystemTime(Date.UTC(...nowUtc));
    return s;
  }

  it('08:00 (reviewer case): refuses with zero POSTs, NOT_ALLOWED_IN_CURRENT_STATE, and the tile reverts', async () => {
    // Wednesday 2026-01-07 08:00 UTC — before noon, but Tuesday's (sleep-day) 06:45 alarm has
    // already rung; the noon rule's "today" target (06:47) is therefore already in the past.
    const { ctx, fake, api } = deadWindowSetup([2026, 0, 7, 8, 0, 0]);
    const { onGet, onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(fake.postSettingsCalls).toHaveLength(0);
    expect(onGet({} as never)).toBe(false); // reverted immediately — no shadow was ever installed

    await vi.advanceTimersByTimeAsync(500); // the scheduled corrective refresh
    expect(onGet({} as never)).toBe(false);
  });

  it('11:00 (reviewer case): refuses with zero POSTs', async () => {
    // Wednesday 2026-01-07 11:00 UTC — still before noon, still inside the same dead window.
    const { ctx, fake, api } = deadWindowSetup([2026, 0, 7, 11, 0, 0]);
    const { onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(fake.postSettingsCalls).toHaveLength(0);
  });

  it('a valid evening skip (after noon, targeting tomorrow) still proceeds normally', async () => {
    const schedules: Schedules = structuredClone(schedulesFixture);
    schedules.left.tuesday.alarm.time = '06:45';
    schedules.left.wednesday.alarm.time = '06:45';
    const settings: Settings = { ...structuredClone(settingsFixture), timeZone: 'UTC' };
    const { ctx, fake } = setup({ settings, schedules });

    // Wednesday 2026-01-07 22:00 UTC — after noon, targets tomorrow's (Thursday's) occurrence,
    // read from Wednesday's own schedule entry (today's sleep-day) — comfortably in the future.
    vi.setSystemTime(Date.UTC(2026, 0, 7, 22, 0, 0));
    const { onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await p; // resolves — not refused

    const expected = new Date(Date.UTC(2026, 0, 8, 6, 47, 0)).toISOString();
    expect(fake.postSettingsCalls).toEqual([
      { left: { scheduleOverrides: { alarm: { disabled: true, timeOverride: '', expiresAt: expected } } } },
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// onSet OFF (5.3)
// ---------------------------------------------------------------------------------------

/** Settings with `left`'s skip-alarm override already active (unexpired, one hour out) — S3
 * (settings-switches PR #46 review) makes turning the switch off (or on) a genuine no-op
 * whenever the coalesced value already matches the observed one, so a test that means to prove a
 * *real* transition happened must start from the opposite observed state. */
function settingsWithActiveOverride(nowMs: number): Settings {
  return {
    ...structuredClone(settingsFixture),
    left: {
      ...settingsFixture.left,
      scheduleOverrides: {
        ...settingsFixture.left.scheduleOverrides,
        alarm: { disabled: true, timeOverride: '', expiresAt: new Date(nowMs + 3_600_000).toISOString() },
      },
    },
  };
}

describe('onSet OFF: clears the override outright (5.3)', () => {
  it('writes disabled:false, timeOverride:"", expiresAt:""', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const { ctx, fake } = setup({ settings: settingsWithActiveOverride(nowMs) });
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
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    // Starts from an active override (observed "on") so the final coalesced "off" is a genuine
    // transition, not the S3 no-op case — that case has its own dedicated test below.
    const { ctx, fake } = setup({ settings: settingsWithActiveOverride(nowMs) });
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
// S3 no-op suppression (settings-switches PR #46 review)
// ---------------------------------------------------------------------------------------

describe('S3: a double-tap within the debounce window that nets out to no change produces zero writes', () => {
  it('on then off, starting (and ending) observed-off: zero POST /api/settings, waiters still resolve', async () => {
    const { ctx, fake } = setup(); // default fixture: left's override is already off/empty
    const { onGet, onSet } = build(ctx, 'left');
    const p1 = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(500);
    const p2 = onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all([p1, p2]); // resolves, not rejects — a no-op is still a successful toggle
    expect(fake.postSettingsCalls).toHaveLength(0);
    expect(onGet({} as never)).toBe(false);
  });

  it('off then on, starting (and ending) observed-on: zero POST /api/settings', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const { ctx, fake } = setup({ settings: settingsWithActiveOverride(nowMs) });
    const { onGet, onSet } = build(ctx, 'left');
    const p1 = onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(500);
    const p2 = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all([p1, p2]);
    expect(fake.postSettingsCalls).toHaveLength(0);
    expect(onGet({} as never)).toBe(true);
  });

  it('control case: a single toggle that is a real transition still produces exactly one write', async () => {
    const { ctx, fake } = setup(); // default fixture: left's override is already off/empty
    const { onSet } = build(ctx, 'left');
    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(fake.postSettingsCalls).toHaveLength(1);
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

  it('N4: a malformed alarm.time makes nextAlarmSkipInstant non-finite — mapped to SERVICE_COMMUNICATION_FAILURE, zero POSTs', async () => {
    const schedules: Schedules = structuredClone(schedulesFixture);
    schedules.left.tuesday.alarm.time = '6:45 AM'; // un-parseable minute -> nextAlarmSkipInstant returns NaN
    const settings: Settings = { ...structuredClone(settingsFixture), timeZone: 'UTC' };
    const { ctx, fake, api } = setup({ settings, schedules });
    vi.setSystemTime(Date.UTC(2026, 0, 7, 5, 0, 0)); // before noon; sleep-day is tuesday
    const { onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(fake.postSettingsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// S6 (settings-switches PR #46 review): learning of expiry/external changes without a read —
// `refresh()` (re-)arms a one-shot expiry timer against the raw `expiresAt`, and is what the
// platform's `isSkipAlarmChange` routing calls on an external change.
// ---------------------------------------------------------------------------------------

describe('isSkipAlarmChange — snapshot-change routing predicate (S6)', () => {
  it('matches a side-scoped alarmSkipExpiresAt change and nothing else', () => {
    expect(isSkipAlarmChange({ scope: 'side', field: 'alarmSkipExpiresAt', side: 'left', previous: '', current: 'x' })).toBe(true);
    expect(isSkipAlarmChange({ scope: 'side', field: 'awayMode', side: 'left', previous: false, current: true })).toBe(false);
    expect(isSkipAlarmChange({ scope: 'device', field: 'isPriming', previous: false, current: true })).toBe(false);
  });
});

describe('S6: skip switch learns of expiry/external changes', () => {
  it('external override observed on the snapshot pushes updateValue(true) once refresh() is routed to it', async () => {
    const { ctx, api } = setup(); // default fixture: left's override is off
    const { service, onGet } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(api.hap.Characteristic.On), 'updateValue');
    expect(onGet({} as never)).toBe(false);

    // Simulates a settings poll observing an out-of-band change (e.g. free-sleep's own web UI) —
    // the platform's `isSkipAlarmChange` routing (src/platform.ts) calls exactly this on the
    // resulting `Change`.
    const nowMs = ctx.timers.now();
    ctx.snapshot.observeSettings({
      ...structuredClone(settingsFixture),
      left: {
        ...settingsFixture.left,
        scheduleOverrides: {
          ...settingsFixture.left.scheduleOverrides,
          alarm: { disabled: true, timeOverride: '', expiresAt: new Date(nowMs + 3_600_000).toISOString() },
        },
      },
    });
    service.refresh();

    expect(spy).toHaveBeenCalledWith(true);
    expect(onGet({} as never)).toBe(true);
  });

  it('expiry instant: the tile drops back to off on its own, with no onGet/refresh call from the caller', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const { ctx, api } = setup({ settings: settingsWithActiveOverride(nowMs) }); // expires in 1h
    const { onGet } = build(ctx, 'left');
    expect(onGet({} as never)).toBe(true); // starts on

    const svc = ctx.accessory.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    await vi.advanceTimersByTimeAsync(3_600_000 + 1); // past the override's own expiresAt

    expect(spy).toHaveBeenCalledWith(false); // pushed by the S6 expiry timer alone
    expect(onGet({} as never)).toBe(false);
  });

  it('a change that extends an already-on override re-arms the timer to the later instant, not the original one', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const { ctx } = setup({ settings: settingsWithActiveOverride(nowMs) }); // expires at +1h
    const { service, onGet } = build(ctx, 'left');
    expect(onGet({} as never)).toBe(true);

    // Extends the override to +2h — still "on" throughout, so `refresh()`'s own idempotent push
    // does not fire, but the expiry timer must still re-arm to the *new* instant.
    ctx.snapshot.observeSettings({
      ...structuredClone(settingsFixture),
      left: {
        ...settingsFixture.left,
        scheduleOverrides: {
          ...settingsFixture.left.scheduleOverrides,
          alarm: { disabled: true, timeOverride: '', expiresAt: new Date(nowMs + 7_200_000).toISOString() },
        },
      },
    });
    service.refresh();

    await vi.advanceTimersByTimeAsync(3_600_000 + 1); // past the *original* +1h expiry
    expect(onGet({} as never)).toBe(true); // still on — the timer was re-armed to +2h, not +1h

    await vi.advanceTimersByTimeAsync(3_600_000); // now past the extended +2h expiry
    expect(onGet({} as never)).toBe(false);
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

  it('S6: stop() also tears down the expiry timer, and no updateValue push follows it', async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.setSystemTime(nowMs);
    const { ctx, api, timers } = setup({ settings: settingsWithActiveOverride(nowMs) });
    const beforeCount = timers.pendingCount();
    const { service } = build(ctx, 'left');
    expect(timers.pendingCount()).toBeGreaterThan(beforeCount); // the expiry timer is now armed

    const svc = ctx.accessory.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    service.stop();
    await vi.advanceTimersByTimeAsync(3_600_000 + 1); // past what would have been the expiry instant
    expect(spy).not.toHaveBeenCalled(); // the timer never fires — it was cleared by stop()
  });
});

// ---------------------------------------------------------------------------------------
// ConfiguredName seeding (release-polish tasks.md 2.5)
// ---------------------------------------------------------------------------------------

describe('ConfiguredName seeding (2.5)', () => {
  it('seeds ConfiguredName to "Skip Next Alarm" on first construction', () => {
    const { ctx, api } = setup();
    build(ctx, 'left');
    const service = ctx.accessory.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!;
    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe(CONFIGURED_NAME.skipNextAlarm);
  });

  it('leaves an existing ConfiguredName (e.g. a controller rename) untouched on reconstruction', () => {
    const { ctx, api } = setup();
    build(ctx, 'left');
    const service = ctx.accessory.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!;
    service.getCharacteristic(Characteristic.ConfiguredName).updateValue('Bedroom Skip Next Alarm');

    build(ctx, 'left'); // simulates a restart against the same accessory

    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Bedroom Skip Next Alarm');
  });

  it('adds ConfiguredName without emitting a characteristic-warning event', () => {
    const { ctx, accessory } = setup();
    const warnings = captureCharacteristicWarnings(accessory);
    build(ctx, 'left');
    expect(warnings).toHaveLength(0);
  });
});
