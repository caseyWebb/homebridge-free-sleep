/**
 * Platform-level runtime wiring introduced by `thermostat-and-offline` (tasks.md group 7, plus
 * the 2.3 construction-ordering guarantee and the 1.2 "in-set services survive restore"
 * guarantee): the shared poller/write-queue/snapshot lifecycle, bootstrap-before-handlers
 * ordering, snapshot-change routing, and shutdown. Complements `test/platform.test.ts` (identity
 * and accessory lifecycle) and `test/integration/session.test.ts` (the full Home-app-session
 * guardrail).
 */
import { Characteristic } from '@homebridge/hap-nodejs';
import { describe, expect, it, vi } from 'vitest';

import type { API, Logging, PlatformConfig } from 'homebridge';

import { FreeSleepPlatform, type MinimalPodClient } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { PodClient } from '../src/pod/client.js';
import type { Change } from '../src/pod/snapshot.js';
import {
  DeviceStatusSchema,
  SchedulesSchema,
  ServicesSchema,
  SettingsSchema,
  type DeviceStatus,
  type Side,
} from '../src/pod/types.js';
import { THERMOSTAT_SUBTYPE, type ThermostatService } from '../src/services/thermostat.js';
import { CONNECTION_SUBTYPE } from '../src/services/connection.js';
import { fToC } from '../src/pod/temperature.js';
import {
  createFakeLogging,
  FakeHomebridgeApi,
  simulateRestart,
  type PlatformFactory,
} from './fakeHomebridgeApi.js';
import { loadFixture } from './loadFixture.js';
import { startMockPod, type MockPod } from './mockPod.js';
import { advanceFakeTime, createTimerHarness, type TimerHarness } from './timerHarness.js';

const fixtureDeviceStatus = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const fixtureSettings = SettingsSchema.parse(loadFixture('settings.json'));
const fixtureSchedules = SchedulesSchema.parse(loadFixture('schedules.json'));
const fixtureServices = ServicesSchema.parse(loadFixture('services.json'));

/** A resolved-by-default fake client for tests that need real bootstrap data without a real
 * mock Pod (avoids `PodClient`'s own un-cancelable `AbortSignal.timeout()` per-request timer,
 * which — unrelated to this change's shutdown wiring — never clears under `vi.useFakeTimers()`
 * and would otherwise make "no timer pending after stop()" unprovable through a real client). */
function resolvedFakeClient(overrides: Partial<MinimalPodClient> = {}): MinimalPodClient {
  return {
    getDeviceStatus: () => Promise.resolve(structuredClone(fixtureDeviceStatus)),
    getSettings: () => Promise.resolve(fixtureSettings),
    getSchedules: () => Promise.resolve(fixtureSchedules),
    getServices: () => Promise.resolve(fixtureServices),
    postDeviceStatus: () => Promise.resolve(),
    postSettings: () => Promise.resolve(),
    ...overrides,
  };
}

function baseConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return { platform: PLATFORM_NAME, host: 'pod.local', ...overrides };
}

function clientFor(pod: MockPod): PodClient {
  const { hostname, port } = new URL(pod.url);
  return new PodClient({ host: hostname, port: Number(port) });
}

function factory(podClient?: MinimalPodClient, timers?: TimerHarness): PlatformFactory<FreeSleepPlatform> {
  return (log: Logging, config: PlatformConfig, api: API) => new FreeSleepPlatform(log, config, api, podClient, timers);
}

/** Reaches into the platform's private runtime — the same reach-into-internals convention
 * `test/platform.test.ts` already uses for `cachedByUuid`. */
interface PlatformInternals {
  thermostats: Map<Side, ThermostatService>;
  connectionService: { refresh: () => void } | undefined;
  handleSnapshotChanges: (changes: readonly Change[]) => void;
}

function internals(platform: FreeSleepPlatform): PlatformInternals {
  return platform as unknown as PlatformInternals;
}

// ---------------------------------------------------------------------------------------
// 2.3 — construction ordering, at the platform level
// ---------------------------------------------------------------------------------------

describe('construction ordering: setProps before registration (tasks.md 2.3)', () => {
  it('every setProps call happens before registerPlatformAccessories is called', async () => {
    const calls: string[] = [];
    const originalSetProps = Characteristic.prototype.setProps;
    const setPropsSpy = vi.spyOn(Characteristic.prototype, 'setProps').mockImplementation(function (
      this: Characteristic,
      props,
    ) {
      calls.push('setProps');
      return originalSetProps.call(this, props);
    });

    const api = new FakeHomebridgeApi();
    const registerSpy = vi.spyOn(api, 'registerPlatformAccessories').mockImplementation(function (
      this: FakeHomebridgeApi,
      ...args: Parameters<FakeHomebridgeApi['registerPlatformAccessories']>
    ) {
      calls.push('register');
      return FakeHomebridgeApi.prototype.registerPlatformAccessories.apply(this, args);
    });

    const log = createFakeLogging();
    new FreeSleepPlatform(log, baseConfig(), api.asApi(), {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
    });
    await api.fireDidFinishLaunching();

    setPropsSpy.mockRestore();
    registerSpy.mockRestore();

    const firstRegisterIndex = calls.indexOf('register');
    const lastSetPropsIndex = calls.lastIndexOf('setProps');
    expect(firstRegisterIndex).toBeGreaterThan(-1);
    expect(lastSetPropsIndex).toBeGreaterThan(-1);
    expect(lastSetPropsIndex).toBeLessThan(firstRegisterIndex);
  });
});

// ---------------------------------------------------------------------------------------
// 1.2 — an in-set service survives restore, a synthetic out-of-set one does not
// ---------------------------------------------------------------------------------------

describe('enabled-subtype services survive restore (tasks.md 1.2)', () => {
  it("a side's thermostat and the hub's connection sensor both survive a restart", async () => {
    const first = await simulateRestart(
      factory({
        getDeviceStatus: () => Promise.reject(new Error('unreachable')),
        getSettings: () => Promise.reject(new Error('unreachable')),
        getSchedules: () => Promise.reject(new Error('unreachable')),
        getServices: () => Promise.reject(new Error('unreachable')),
        postDeviceStatus: () => Promise.reject(new Error('unreachable')),
        postSettings: () => Promise.reject(new Error('unreachable')),
      }),
      baseConfig(),
      [],
    );
    const previous = first.api.registeredAccessories;
    expect(previous).toHaveLength(3);

    const second = await simulateRestart(
      factory({
        getDeviceStatus: () => Promise.reject(new Error('unreachable')),
        getSettings: () => Promise.reject(new Error('unreachable')),
        getSchedules: () => Promise.reject(new Error('unreachable')),
        getServices: () => Promise.reject(new Error('unreachable')),
        postDeviceStatus: () => Promise.reject(new Error('unreachable')),
        postSettings: () => Promise.reject(new Error('unreachable')),
      }),
      baseConfig(),
      previous,
    );

    expect(second.api.registerPlatformAccessoriesCalls).toHaveLength(0);
    expect(second.api.unregisterPlatformAccessoriesCalls).toHaveLength(0);

    const left = previous.find((a) => a.displayName === 'Pod Left')!;
    const hub = previous.find((a) => a.displayName === 'Pod')!;
    const hap = second.api.hap;
    expect(left.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)).toBeDefined();
    expect(hub.getServiceById(hap.Service.ContactSensor, CONNECTION_SUBTYPE)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------
// 7.1 — one poller serves every service
// ---------------------------------------------------------------------------------------

describe('one poller serves every published service (tasks.md 7.1)', () => {
  it('one polling period produces exactly one GET /api/deviceStatus regardless of accessory count', async () => {
    vi.useFakeTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      timers.random = () => 0.5;
      const client = clientFor(pod);

      await simulateRestart(factory(client, timers), baseConfig({ sides: 'both' }), []);

      const before = pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/deviceStatus').length;
      // A margin past the exact 30s base interval — advancing to precisely the boundary is
      // occasionally racy against the real HTTP round trip landing (design.md's own rationale
      // for `advanceFakeTime`'s real-tick-per-step design); `pollBudget.test.ts`'s equivalent
      // guardrail advances a full interval past its target for the same reason.
      await advanceFakeTime(35_000, 100);
      const after = pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/deviceStatus').length;

      expect(after - before).toBe(1);
    } finally {
      vi.useRealTimers();
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 7.2 — bootstrap settles before handlers are wired
// ---------------------------------------------------------------------------------------

describe('handlers are wired after bootstrap settles (tasks.md 7.2)', () => {
  it('the first read after startup against a reachable Pod returns an observed value', async () => {
    vi.useFakeTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      const client = clientFor(pod);
      const { api, platform } = await simulateRestart(factory(client, timers), baseConfig(), []);

      const left = internals(platform).thermostats.get('left')!;
      expect(left).toBeDefined();
      const hap = api.hap;

      // Reaching the underlying characteristic through the same accessory the platform built,
      // and reading it through HAP's own real `handleGetRequest` — the same path a real
      // HomeKit controller's read takes (matching `test/integration/session.test.ts`'s own
      // convention) — the read must reflect the mock's seeded fixture (B1 regression guard:
      // without a bootstrap-time `refresh()` call in each service's constructor, every
      // characteristic below would still be sitting at HAP's own default — 12.78°C target, 0°C
      // current, StatusActive false — rather than the observed value).
      const leftAccessory = api.registeredAccessories.find((a) => a.displayName === fixtureSettings.left.name)!;
      expect(leftAccessory).toBeDefined();
      const thermostatService = leftAccessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
      // Precision 1, not exact: HAP snaps a pushed float onto each characteristic's minStep
      // grid (`TargetTemperature`'s explicit 5/9 step, `CurrentTemperature`'s default 0.1) —
      // matching the same convention `test/services/thermostat.test.ts` already uses for a
      // snapped value.
      expect(await thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature).handleGetRequest()).toBeCloseTo(
        fToC(fixtureDeviceStatus.left.targetTemperatureF),
        1,
      );
      expect(await thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest()).toBeCloseTo(
        fToC(fixtureDeviceStatus.left.currentTemperatureF),
        1,
      );
      expect(await thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).handleGetRequest()).toBe(
        fixtureDeviceStatus.left.isOn
          ? hap.Characteristic.TargetHeatingCoolingState.AUTO
          : hap.Characteristic.TargetHeatingCoolingState.OFF,
      );
      // TemperatureDisplayUnits is seeded lazily, inside its own `onGet` handler — only a real
      // read (not the raw `.value`) actually triggers the seed from settings.
      expect(await thermostatService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits).handleGetRequest()).toBe(
        fixtureSettings.temperatureFormat === 'celsius'
          ? hap.Characteristic.TemperatureDisplayUnits.CELSIUS
          : hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
      );

      const hubAccessory = api.registeredAccessories.find((a) => a.displayName === 'Pod')!;
      const connectionService = hubAccessory.getServiceById(hap.Service.ContactSensor, CONNECTION_SUBTYPE)!;
      expect(await connectionService.getCharacteristic(hap.Characteristic.ContactSensorState).handleGetRequest()).toBe(
        hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
      expect(await connectionService.getCharacteristic(hap.Characteristic.StatusActive).handleGetRequest()).toBe(true);
    } finally {
      vi.useRealTimers();
      await pod.close();
    }
  });

  it('an unreachable Pod still publishes all three accessories with services, with polling running and no read throwing', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      let deviceStatusCalls = 0;
      const client: MinimalPodClient = {
        getDeviceStatus: () => {
          deviceStatusCalls += 1;
          return Promise.reject(new Error('unreachable'));
        },
        getSettings: () => Promise.reject(new Error('unreachable')),
        getSchedules: () => Promise.reject(new Error('unreachable')),
        getServices: () => Promise.reject(new Error('unreachable')),
        postDeviceStatus: () => Promise.reject(new Error('unreachable')),
        postSettings: () => Promise.reject(new Error('unreachable')),
      };
      const { api, platform } = await simulateRestart(factory(client, timers), baseConfig(), []);

      expect(api.registeredAccessories).toHaveLength(3);
      const left = internals(platform).thermostats.get('left')!;
      const right = internals(platform).thermostats.get('right')!;
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      expect(internals(platform).connectionService).toBeDefined();

      // Polling is running despite every request failing: advancing well past one
      // deviceStatus poll interval (30s base, backed off to 60s after the bootstrap's own
      // failure) produces at least one more attempt beyond the bootstrap's.
      const callsAtBootstrap = deviceStatusCalls;
      expect(callsAtBootstrap).toBeGreaterThan(0);
      await advanceFakeTime(65_000, 100);
      expect(deviceStatusCalls).toBeGreaterThan(callsAtBootstrap);

      // A read still returns rather than throwing — default `noResponseAfterMs` (10 minutes)
      // is well past this test's advanced time.
      const hap = api.hap;
      const leftAccessory = api.registeredAccessories.find((a) => a.displayName === 'Pod Left')!;
      const targetTemp = leftAccessory
        .getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!
        .getCharacteristic(hap.Characteristic.TargetTemperature);
      await expect(targetTemp.handleGetRequest()).resolves.toBeTypeOf('number');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 7.3 — snapshot-change routing
// ---------------------------------------------------------------------------------------

describe('snapshot changes are routed to the services that publish them (tasks.md 7.3)', () => {
  it('a left-side change updates only the left thermostat', async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
    };
    const { platform } = await simulateRestart(factory(client), baseConfig(), []);
    const left = internals(platform).thermostats.get('left')!;
    const right = internals(platform).thermostats.get('right')!;
    const leftSpy = vi.spyOn(left, 'refresh');
    const rightSpy = vi.spyOn(right, 'refresh');

    internals(platform).handleSnapshotChanges([
      { scope: 'side', field: 'targetTemperatureF', side: 'left', previous: 60, current: 65 },
    ]);

    expect(leftSpy).toHaveBeenCalledTimes(1);
    expect(rightSpy).not.toHaveBeenCalled();
  });

  it('a connectionOnline change updates only the hub sensor, no thermostat', async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
    };
    const { platform } = await simulateRestart(factory(client), baseConfig(), []);
    const left = internals(platform).thermostats.get('left')!;
    const right = internals(platform).thermostats.get('right')!;
    const connection = internals(platform).connectionService!;
    const leftSpy = vi.spyOn(left, 'refresh');
    const rightSpy = vi.spyOn(right, 'refresh');
    const connectionSpy = vi.spyOn(connection, 'refresh');

    internals(platform).handleSnapshotChanges([{ scope: 'device', field: 'connectionOnline', previous: false, current: true }]);

    expect(connectionSpy).toHaveBeenCalledTimes(1);
    expect(leftSpy).not.toHaveBeenCalled();
    expect(rightSpy).not.toHaveBeenCalled();
  });

  it('an unpublished field (awayMode, waterLevelState) updates nothing and raises nothing', async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
    };
    const { platform } = await simulateRestart(factory(client), baseConfig(), []);
    const left = internals(platform).thermostats.get('left')!;
    const connection = internals(platform).connectionService!;
    const leftSpy = vi.spyOn(left, 'refresh');
    const connectionSpy = vi.spyOn(connection, 'refresh');

    expect(() =>
      internals(platform).handleSnapshotChanges([
        { scope: 'side', field: 'awayMode', side: 'left', previous: false, current: true },
        { scope: 'device', field: 'waterLevelState', previous: 'ok', current: 'low' },
      ]),
    ).not.toThrow();

    expect(leftSpy).not.toHaveBeenCalled();
    expect(connectionSpy).not.toHaveBeenCalled();
  });

  it('one throwing service does not prevent the other from being notified', async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
    };
    const log = createFakeLogging();
    const api = new FakeHomebridgeApi();
    const platform = new FreeSleepPlatform(log, baseConfig(), api.asApi(), client);
    await api.fireDidFinishLaunching();

    const left = internals(platform).thermostats.get('left')!;
    const connection = internals(platform).connectionService!;
    vi.spyOn(left, 'refresh').mockImplementation(() => {
      throw new Error('synthetic failure');
    });
    const connectionSpy = vi.spyOn(connection, 'refresh');

    internals(platform).handleSnapshotChanges([
      { scope: 'side', field: 'isOn', side: 'left', previous: false, current: true },
      { scope: 'device', field: 'connectionOnline', previous: false, current: true },
    ]);

    expect(connectionSpy).toHaveBeenCalledTimes(1);
    expect(
      (log as unknown as { lines: Array<{ level: string; message: string }> }).lines.some(
        (l) => l.level === 'warn' && l.message.includes('synthetic failure'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// 7.4 — shutdown releases everything
// ---------------------------------------------------------------------------------------

describe('shutdown stops polling, the write path and the subscription (tasks.md 7.4)', () => {
  it('after shutdown no timer remains pending beyond hap-nodejs\'s own fixed per-accessory overhead', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const api = new FakeHomebridgeApi();
      const log = createFakeLogging();
      // Before any accessory exists, nothing is scheduled at all.
      expect(timers.pendingCount()).toBe(0);

      const platform = new FreeSleepPlatform(log, baseConfig(), api.asApi(), resolvedFakeClient(), timers);
      await api.fireDidFinishLaunching();

      // hap-nodejs's own `Accessory` constructor schedules one timer per accessory,
      // independent of anything this plugin does (confirmed separately by constructing bare
      // accessories with no platform involved at all) — that fixed, perpetual overhead is what
      // `perAccessoryOverhead` isolates below, so the real assertion after shutdown checks only
      // what this change's poller/write-queue/subscription shutdown is responsible for releasing.
      const perAccessoryOverhead = api.registeredAccessories.length;
      expect(timers.pendingCount()).toBeGreaterThan(perAccessoryOverhead);

      await api.fireShutdown();

      expect(timers.pendingCount()).toBe(perAccessoryOverhead);
      void platform;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a request already in flight when shutdown fires commits nothing once it settles', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      let deviceStatusCalls = 0;
      let resolveSecondPoll!: (value: DeviceStatus) => void;
      const secondPoll = new Promise<DeviceStatus>((resolve) => {
        resolveSecondPoll = resolve;
      });
      const client = resolvedFakeClient({
        getDeviceStatus: () => {
          deviceStatusCalls += 1;
          return deviceStatusCalls === 1 ? Promise.resolve(structuredClone(fixtureDeviceStatus)) : secondPoll;
        },
      });
      const api = new FakeHomebridgeApi();
      const log = createFakeLogging();
      const platform = new FreeSleepPlatform(log, baseConfig(), api.asApi(), client, timers);
      await api.fireDidFinishLaunching();

      const left = internals(platform).thermostats.get('left')!;
      const refreshSpy = vi.spyOn(left, 'refresh');

      // Advance to the next deviceStatus poll (base interval 30s) — it is now in flight,
      // awaiting `secondPoll`.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deviceStatusCalls).toBe(2);

      await api.fireShutdown();

      const changed = structuredClone(fixtureDeviceStatus);
      changed.left.targetTemperatureF = 99;
      resolveSecondPoll(changed);
      await vi.advanceTimersByTimeAsync(0);

      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a blocked write's pending away-mode-revert timer is cleared by shutdown (tasks.md 2.3, F2 regression)", async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const api = new FakeHomebridgeApi();
      const log = createFakeLogging();
      const awaySettings = {
        ...structuredClone(fixtureSettings),
        left: { ...fixtureSettings.left, awayMode: true },
      };
      const client = resolvedFakeClient({ getSettings: () => Promise.resolve(awaySettings) });

      const platform = new FreeSleepPlatform(
        log,
        baseConfig({ awayModeWritePolicy: 'block' }),
        api.asApi(),
        client,
        timers,
      );
      await api.fireDidFinishLaunching();
      const perAccessoryOverhead = api.registeredAccessories.length;

      // Left is away under the 'block' policy, so a write to *either* side is refused —
      // addressed here at right, matching `writeQueue`'s "either side away" symmetry. The
      // seeded `getSettings` response above carries the fixture's own side names ("Left"/
      // "Right", `test/fixtures/settings.json`), not the `FALLBACK_NAME` ones, since
      // `nameFor` prefers a non-empty name from the one-time settings read.
      const hap = api.asApi().hap;
      const right = api.registeredAccessories.find((a) => a.displayName === 'Right')!;
      const targetTemp = right
        .getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!
        .getCharacteristic(hap.Characteristic.TargetTemperature);

      const pending = targetTemp.handleSetRequest(fToC(70));
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(400); // debounce flush -> dispatch -> guard blocks
      await expect(pending).rejects.toBe(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);

      // The block's ~500ms corrective-refresh timer (thermostat.ts's `scheduleAwayModeRevert`)
      // is now pending, not yet fired — exactly the reviewer-reproduced state ("1 pending timer
      // after fireShutdown with a blocked write") this test locks in a fix for.
      expect(timers.pendingCount()).toBeGreaterThan(perAccessoryOverhead);

      await api.fireShutdown();

      // Before the F2 fix, this timer was never retained/cleared and survived shutdown; after
      // the fix, `ThermostatService.stop()` (wired into the platform's shutdown handler) clears
      // it, so shutdown leaves nothing pending beyond hap-nodejs's own fixed per-accessory
      // overhead — same bar the plain 7.4 shutdown test above holds to.
      expect(timers.pendingCount()).toBe(perAccessoryOverhead);
      void platform;
    } finally {
      vi.useRealTimers();
    }
  });
});
