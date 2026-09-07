/**
 * `AwayModeService` (settings-switches, issue #18): away-mode-switch spec's own requirements —
 * synchronous read with no request, service-level debounce (>= 2s) and rate limit (>= 10s per
 * side), `awayModeTurnsSideOff` sequencing, and communication-failure surfacing with a reverted
 * displayed value.
 */
import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler, CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SettingsSchema, type DeviceStatus, type Settings } from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { AWAY_MODE_SUBTYPE, AwayModeService, isAwayModeChange } from '../../src/services/awayMode.js';
import type { ServiceContext } from '../../src/services/types.js';
import { createFakePodClient, type FakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture: DeviceStatus = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture: Settings = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture = loadFixture('schedules.json');
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
  ctx: ServiceContext;
  /** Shared arrival-order log across both endpoints — `fakePodClient.ts`'s own
   * `postDeviceStatusCalls`/`postSettingsCalls` are separate arrays with no shared ordering. */
  order: string[];
}

function setup(options: { config?: Record<string, unknown>; side?: 'left' | 'right' } = {}): Setup {
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const side = options.side ?? 'left';
  const accessory = new api.platformAccessory(`Pod ${side}`, api.hap.uuid.generate(side), api.hap.Categories.THERMOSTAT);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
  snapshot.observeSettings(structuredClone(settingsFixture));
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings: settingsFixture,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schedules: schedulesFixture as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services: servicesFixture as any,
  });
  const order: string[] = [];
  const originalPostDeviceStatus = fake.client.postDeviceStatus.bind(fake.client);
  const originalPostSettings = fake.client.postSettings.bind(fake.client);
  fake.client.postDeviceStatus = (async (patch) => {
    order.push('deviceStatus');
    return originalPostDeviceStatus(patch);
  }) as typeof fake.client.postDeviceStatus;
  fake.client.postSettings = (async (patch) => {
    order.push('settings');
    return originalPostSettings(patch);
  }) as typeof fake.client.postSettings;

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
  return { api, accessory, snapshot, timers, fake, writeQueue, ctx, order };
}

function build(
  ctx: ServiceContext,
  side: 'left' | 'right',
  platformStartedAt = ctx.timers.now(),
): { service: AwayModeService; onGet: CharacteristicGetHandler; onSet: CharacteristicSetHandler } {
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
  const service = new AwayModeService(ctx, side, platformStartedAt);
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
// 4.1 — construction and reads
// ---------------------------------------------------------------------------------------

describe('construction (4.1)', () => {
  it('adds exactly one Switch named "Away Mode Left" with subtype awayMode', () => {
    const { ctx, accessory, api } = setup();
    new AwayModeService(ctx, 'left', 0);
    const switches = accessory.services.filter((s) => s.UUID === api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(AWAY_MODE_SUBTYPE);
    expect(switches[0]?.displayName).toBe('Away Mode Left');
  });

  it('restores by getServiceById rather than adding a second switch', () => {
    const { ctx, accessory, api } = setup();
    new AwayModeService(ctx, 'left', 0);
    new AwayModeService(ctx, 'left', 0);
    const switches = accessory.services.filter((s) => s.UUID === api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
  });
});

describe('onGet reads the cached snapshot synchronously, with no request (4.1)', () => {
  it('reflects the cached awayMode value and issues no request', () => {
    const { ctx, fake } = setup();
    const { onGet } = build(ctx, 'left');
    expect(onGet({} as never)).toBe(false);
    expect(fake.postSettingsCalls).toHaveLength(0);
    expect(fake.settings.calls).toBe(0);
  });

  it('reflects a true cached value', () => {
    const { ctx, snapshot, fake } = setup();
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });
    const { onGet } = build(ctx, 'left');
    expect(onGet({} as never)).toBe(true);
    expect(fake.postSettingsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// 4.2 — debounce and rate limit
// ---------------------------------------------------------------------------------------

describe('onSet: service-level debounce and rate limit (4.2)', () => {
  it('a single toggle produces exactly one write after the 2s debounce, carrying the new value', async () => {
    const { ctx, fake } = setup();
    const { onSet } = build(ctx, 'left');
    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake.postSettingsCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(500); // let writeQueue's own inner debounce/dispatch settle
    await p;
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }]);
  });

  it('three toggles within 10s for one side produce at most one write in that window, carrying the latest value', async () => {
    const { ctx, fake } = setup();
    const { onSet } = build(ctx, 'left');
    const p1 = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(500);
    const p2 = onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(500);
    const p3 = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2500); // 2s debounce measured from the third toggle
    await Promise.all([p1, p2, p3]);
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }]);
  });

  it('a second toggle within 10s of the first submission is delayed until the 10s window elapses, not sent immediately', async () => {
    const { ctx, fake } = setup();
    const { onSet } = build(ctx, 'left');
    const p1 = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await p1;
    expect(fake.postSettingsCalls).toHaveLength(1);

    const p2 = onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(2000); // past the plain 2s debounce, still well inside the 10s floor
    expect(fake.postSettingsCalls).toHaveLength(1); // still rate-limited
    await vi.advanceTimersByTimeAsync(8000); // now past the 10s floor from the first submission
    await p2;
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }, { left: { awayMode: false } }]);
  });
});

// ---------------------------------------------------------------------------------------
// 4.2 — failure surfacing
// ---------------------------------------------------------------------------------------

describe('onSet: a failed write throws SERVICE_COMMUNICATION_FAILURE and reverts the displayed value (4.2)', () => {
  it('throws and, once resolved, onGet reads the last-confirmed (pre-toggle) value', async () => {
    const { ctx, fake, api } = setup();
    fake.postSettingsOutcome = { kind: 'error', error: new Error('network down') };
    const { onGet, onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;

    expect(onGet({} as never)).toBe(false); // reverted — the overlay was cleared synchronously on failure
  });

  it('pushes a corrective updateValue(false) to the characteristic ~500ms after the failure, not immediately', async () => {
    const { ctx, fake, api } = setup();
    fake.postSettingsOutcome = { kind: 'error', error: new Error('network down') };
    const { onSet } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(api.hap.Service.Switch, AWAY_MODE_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(2500); // debounce flush -> dispatch -> settings write fails
    await assertion;
    expect(spy).not.toHaveBeenCalled(); // not yet — the corrective refresh hasn't fired

    await vi.advanceTimersByTimeAsync(500); // the scheduled corrective refresh fires
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------------------
// 4.3 — awayModeTurnsSideOff sequencing
// ---------------------------------------------------------------------------------------

describe('awayModeTurnsSideOff sequencing (4.3)', () => {
  it('flag on + turning on while the side is on: the power-off write observably precedes the settings write', async () => {
    const { ctx, fake, order } = setup({ config: { awayModeTurnsSideOff: true } });
    const { onSet } = build(ctx, 'left');
    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2000); // service debounce
    await vi.advanceTimersByTimeAsync(500); // writeQueue's own side-lane debounce + dispatch
    await vi.advanceTimersByTimeAsync(500); // then the settings-lane debounce + dispatch
    await p;
    expect(order).toEqual(['deviceStatus', 'settings']);
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isOn: false } }]);
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }]);
  });

  it('flag off: only the settings write occurs, no power-state write', async () => {
    const { ctx, fake } = setup({ config: { awayModeTurnsSideOff: false } });
    const { onSet } = build(ctx, 'left');
    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }]);
  });

  it('turning off never touches power, regardless of the flag', async () => {
    const { ctx, fake, snapshot } = setup({ config: { awayModeTurnsSideOff: true } });
    // S3 (settings-switches PR #46 review): away mode must actually start *on* here, or turning
    // it off is a no-op the new no-op suppression correctly skips before this test ever gets to
    // observe whether power was touched — this test's own point is a real off transition.
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });
    const { onSet } = build(ctx, 'left');
    const p = onSet(false, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: false } }]);
  });
});

// ---------------------------------------------------------------------------------------
// S2 (settings-switches PR #46 review): the awayModeTurnsSideOff pre-step's own
// AwayModeBlockedError ruling — the partner side already being away must not make Away Mode
// itself unreachable.
// ---------------------------------------------------------------------------------------

describe('S2: awayModeTurnsSideOff pre-step guard-block ruling (settings-switches PR #46 review)', () => {
  it('flag on + partner already away under \'block\': the guard-blocked pre-step is logged and the away-mode write still proceeds', async () => {
    const { ctx, fake, snapshot, order } = setup({ config: { awayModeTurnsSideOff: true, awayModeWritePolicy: 'block' } });
    // The *right* side is already away — the guard's 'block' policy therefore refuses left's own
    // isOn:false pre-step too ("either side away" gates every side write).
    snapshot.observeSettings({ ...structuredClone(settingsFixture), right: { ...settingsFixture.right, awayMode: true } });
    const { onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2000); // service debounce
    await vi.advanceTimersByTimeAsync(500); // writeQueue's own side-lane debounce + dispatch (blocked)
    await vi.advanceTimersByTimeAsync(500); // then the settings-lane debounce + dispatch
    await expect(p).resolves.toBeUndefined(); // executed scenario: completes, does not abort

    expect(fake.postDeviceStatusCalls).toHaveLength(0); // the pre-step never reached the Pod
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }]);
    expect(order).toEqual(['settings']);
  });

  it('flag on + a genuine (non-guard) pre-step failure still aborts the whole toggle', async () => {
    const { ctx, fake, api } = setup({ config: { awayModeTurnsSideOff: true } });
    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('network down') };
    const { onSet } = build(ctx, 'left');

    const p = onSet(true, {} as never);
    const assertion = expect(p).rejects.toMatchObject({ hapStatus: api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;

    // Aborted before ever attempting the settings write — unchanged from the pre-existing
    // (non-guard-failure) abort behavior.
    expect(fake.postSettingsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// S3 (settings-switches PR #46 review): no-op suppression — a coalesced value that already
// matches the observed one produces zero settings writes.
// ---------------------------------------------------------------------------------------

describe('S3: a double-tap within the debounce window that nets out to no change produces zero writes', () => {
  it('on then off, starting (and ending) observed-off: zero POST /api/settings, waiters still resolve', async () => {
    const { ctx, fake } = setup(); // default fixture: left's awayMode is already false
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
    const { ctx, fake, snapshot } = setup();
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });
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
    const { ctx, fake } = setup(); // default fixture: left's awayMode is already false
    const { onSet } = build(ctx, 'left');
    const p = onSet(true, {} as never);
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }]);
  });

  it('a no-op toggle does not advance the rate-limit floor — a genuine toggle right after is not delayed by it', async () => {
    const { ctx, fake } = setup();
    const { onSet } = build(ctx, 'left');
    const noOp = onSet(false, {} as never); // already false — suppressed, no submission
    await vi.advanceTimersByTimeAsync(2500);
    await noOp;
    expect(fake.postSettingsCalls).toHaveLength(0);

    const real = onSet(true, {} as never); // a real transition, immediately after
    await vi.advanceTimersByTimeAsync(2500); // just the plain 2s debounce — no 10s floor to wait out
    await real;
    expect(fake.postSettingsCalls).toEqual([{ left: { awayMode: true } }]);
  });
});

// ---------------------------------------------------------------------------------------
// isAwayModeChange — snapshot-change routing predicate (4.4)
// ---------------------------------------------------------------------------------------

describe('isAwayModeChange (4.4)', () => {
  it('matches a side-scoped awayMode change and nothing else', () => {
    expect(isAwayModeChange({ scope: 'side', field: 'awayMode', side: 'left', previous: false, current: true })).toBe(true);
    expect(isAwayModeChange({ scope: 'side', field: 'isOn', side: 'left', previous: false, current: true })).toBe(false);
    expect(isAwayModeChange({ scope: 'device', field: 'isPriming', previous: false, current: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------------------

describe('stop() clears pending timers and rejects an unsubmitted write', () => {
  it('a debounced write not yet submitted rejects when stop() runs, and no timer is left', async () => {
    const { ctx, timers } = setup();
    const service = new AwayModeService(ctx, 'left', 0);
    const { onSet } = build(ctx, 'left');
    void onSet;

    const before = timers.pendingCount();
    const onChar = ctx.accessory
      .getServiceById(ctx.api.hap.Service.Switch, AWAY_MODE_SUBTYPE)!
      .getCharacteristic(ctx.api.hap.Characteristic.On);
    const pending = onChar.handleSetRequest(true);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(timers.pendingCount()).toBeGreaterThan(before);

    service.stop();
    await expect(pending).rejects.toThrow();
    expect(timers.pendingCount()).toBe(before);
  });
});
