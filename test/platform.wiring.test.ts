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
  ServerStatusSchema,
  ServicesSchema,
  SettingsSchema,
  type DeviceStatus,
  type Schedules,
  type Side,
} from '../src/pod/types.js';
import { THERMOSTAT_SUBTYPE, type ThermostatService } from '../src/services/thermostat.js';
import { CONNECTION_SUBTYPE } from '../src/services/connection.js';
import { WATER_LOW_SUBTYPE } from '../src/services/waterLow.js';
import { PRIME_SUBTYPE } from '../src/services/prime.js';
import { LED_SUBTYPE } from '../src/services/led.js';
import { TEST_ALARM_LEFT_SUBTYPE, TEST_ALARM_RIGHT_SUBTYPE } from '../src/services/testAlarm.js';
import { SERVER_FAULT_SUBTYPE } from '../src/services/serverFault.js';
import { OCCUPANCY_SUBTYPE, type OccupancySensorService } from '../src/services/occupancy.js';
import { ALARM_DISMISS_SUBTYPE } from '../src/services/alarm.js';
import { fToC } from '../src/pod/temperature.js';
import {
  createFakeLogging,
  FakeHomebridgeApi,
  simulateRestart,
  type PlatformFactory,
  type FakePlatformAccessory,
} from './fakeHomebridgeApi.js';
import { loadFixture } from './loadFixture.js';
import { startMockPod, type MockPod } from './mockPod.js';
import { advanceFakeTime, createTimerHarness, type TimerHarness } from './timerHarness.js';

const fixtureDeviceStatus = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const fixtureSettings = SettingsSchema.parse(loadFixture('settings.json'));
const fixtureSchedules = SchedulesSchema.parse(loadFixture('schedules.json'));
const fixtureServices = ServicesSchema.parse(loadFixture('services.json'));
const fixtureServerStatus = ServerStatusSchema.parse(loadFixture('serverStatus.json'));

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
    getServerStatus: () => Promise.resolve(structuredClone(fixtureServerStatus)),
    postDeviceStatus: () => Promise.resolve(),
    postSettings: () => Promise.resolve(),
    postAlarm: () => Promise.resolve(),
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
  occupancySensors: Map<Side, OccupancySensorService>;
  connectionService: { refresh: () => void } | undefined;
  waterLowService: { refresh: () => void } | undefined;
  primeService: { refresh: () => void; stop: () => void } | undefined;
  ledService: { refresh: () => void } | undefined;
  testAlarmServices: Map<Side, { stop: () => void }>;
  serverFaultService: { refresh: () => void } | undefined;
  alarmServices: Map<Side, { handleChange: (change: Change) => void; stop: () => void }>;
  alarmWindowScheduler: { stop: () => void } | undefined;
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
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
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
        getServerStatus: () => Promise.reject(new Error('unreachable')),
        postDeviceStatus: () => Promise.reject(new Error('unreachable')),
        postSettings: () => Promise.reject(new Error('unreachable')),
        postAlarm: () => Promise.reject(new Error('unreachable')),
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
        getServerStatus: () => Promise.reject(new Error('unreachable')),
        postDeviceStatus: () => Promise.reject(new Error('unreachable')),
        postSettings: () => Promise.reject(new Error('unreachable')),
        postAlarm: () => Promise.reject(new Error('unreachable')),
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
        getServerStatus: () => Promise.reject(new Error('unreachable')),
        postDeviceStatus: () => Promise.reject(new Error('unreachable')),
        postSettings: () => Promise.reject(new Error('unreachable')),
        postAlarm: () => Promise.reject(new Error('unreachable')),
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
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
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
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
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
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
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
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
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

// ---------------------------------------------------------------------------------------
// keep-alive wiring (keep-alive change, tasks.md 3.1, 3.2)
// ---------------------------------------------------------------------------------------

describe('keep-alive wiring (tasks.md 3.1, 3.2)', () => {
  it('parsed.data.keepAliveMs/keepAliveThresholdMs/keepAlive flow through to an actual re-arm write', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const postDeviceStatusCalls: unknown[] = [];
      const onDeviceStatus = structuredClone(fixtureDeviceStatus);
      onDeviceStatus.left.isOn = true;
      onDeviceStatus.left.secondsRemaining = 60; // well under the configured 120_000ms threshold
      const client = resolvedFakeClient({
        getDeviceStatus: () => Promise.resolve(structuredClone(onDeviceStatus)),
        postDeviceStatus: (patch) => {
          postDeviceStatusCalls.push(patch);
          return Promise.resolve();
        },
      });
      await simulateRestart(
        factory(client, timers),
        baseConfig({ keepAliveMs: 600_000, keepAliveThresholdMs: 120_000 }),
        [],
      );

      // checkIntervalMs = clamp(120_000 / 2, 60_000, 900_000) = 60_000; +400 for the re-arm's
      // own write-queue debounce to flush and dispatch.
      await advanceFakeTime(60_000 + 400, 100);

      expect(postDeviceStatusCalls).toContainEqual({ left: { secondsRemaining: 600 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keepAlive: false disables the component entirely, even for a side already on and past threshold', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const postDeviceStatusCalls: unknown[] = [];
      const onDeviceStatus = structuredClone(fixtureDeviceStatus);
      onDeviceStatus.left.isOn = true;
      onDeviceStatus.left.secondsRemaining = 60;
      const client = resolvedFakeClient({
        getDeviceStatus: () => Promise.resolve(structuredClone(onDeviceStatus)),
        postDeviceStatus: (patch) => {
          postDeviceStatusCalls.push(patch);
          return Promise.resolve();
        },
      });
      await simulateRestart(
        factory(client, timers),
        baseConfig({ keepAlive: false, keepAliveMs: 600_000, keepAliveThresholdMs: 120_000 }),
        [],
      );

      // No real I/O settling needed here (resolvedFakeClient never touches a real socket), so a
      // single large fake-timer jump is enough — unlike advanceFakeTime's small-step convention,
      // which exists specifically for tests driving a real mock Pod over real sockets.
      await vi.advanceTimersByTimeAsync(2_000_000);
      expect(postDeviceStatusCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('platform shutdown stops the keep-alive timer alongside the poller and write queue', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const api = new FakeHomebridgeApi();
      const log = createFakeLogging();
      const client = resolvedFakeClient();
      const platform = new FreeSleepPlatform(
        log,
        baseConfig({ keepAliveMs: 600_000, keepAliveThresholdMs: 120_000 }),
        api.asApi(),
        client,
        timers,
      );
      await api.fireDidFinishLaunching();

      const perAccessoryOverhead = api.registeredAccessories.length;
      // The keep-alive check timer contributes to this pending count exactly like the poller's
      // and write queue's own timers do — no dedicated assertion of "which" timer it is, mirroring
      // the plain 7.4 shutdown test's own convention above.
      expect(timers.pendingCount()).toBeGreaterThan(perAccessoryOverhead);

      await api.fireShutdown();
      expect(timers.pendingCount()).toBe(perAccessoryOverhead);
      void platform;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: the hub's enabled service set grows and shrinks with config (tasks.md 9.1, 9.3)
// ---------------------------------------------------------------------------------------

const HUB_BOOLEAN_KEYS = ['primeSwitch', 'ledLightbulb', 'testAlarmSwitch', 'serverFaultSensor'] as const;

function hubServiceKeys(services: Array<{ UUID: string; subtype?: string }>): Set<string> {
  return new Set(services.map((sv) => `${sv.UUID}:${sv.subtype ?? ''}`));
}

describe('the hub\'s enabled service set grows and shrinks with its own configuration (tasks.md 9.1)', () => {
  it('across all 16 combinations of the four boolean keys, exactly the expected subtype set is present', async () => {
    for (let mask = 0; mask < 16; mask++) {
      const overrides: Record<string, boolean> = {};
      HUB_BOOLEAN_KEYS.forEach((key, i) => {
        overrides[key] = (mask & (1 << i)) !== 0;
      });

      const { api } = await simulateRestart(factory(resolvedFakeClient()), baseConfig(overrides), []);
      const hub = api.registeredAccessories.find((a) => a.displayName === 'Pod')!;
      const hap = api.hap;

      const nonInfo = hub.services.filter((sv) => sv.UUID !== hap.Service.AccessoryInformation.UUID);
      const keys = hubServiceKeys(nonInfo);

      const expected = new Set<string>([
        `${hap.Service.ContactSensor.UUID}:${CONNECTION_SUBTYPE}`,
        `${hap.Service.ContactSensor.UUID}:${WATER_LOW_SUBTYPE}`,
      ]);
      if (overrides.primeSwitch) expected.add(`${hap.Service.Switch.UUID}:${PRIME_SUBTYPE}`);
      if (overrides.ledLightbulb) expected.add(`${hap.Service.Lightbulb.UUID}:${LED_SUBTYPE}`);
      if (overrides.testAlarmSwitch) {
        expected.add(`${hap.Service.Switch.UUID}:${TEST_ALARM_LEFT_SUBTYPE}`);
        expected.add(`${hap.Service.Switch.UUID}:${TEST_ALARM_RIGHT_SUBTYPE}`);
      }
      if (overrides.serverFaultSensor) expected.add(`${hap.Service.ContactSensor.UUID}:${SERVER_FAULT_SUBTYPE}`);

      expect(keys).toEqual(expected);
    }
  });
});

describe('constructServicesFor grows to construct all four conditional hub services (tasks.md 9.3)', () => {
  it('all four enabled: all six hub services (plus connection) exist on the hub accessory', async () => {
    const { platform } = await simulateRestart(
      factory(resolvedFakeClient()),
      baseConfig({ primeSwitch: true, ledLightbulb: true, testAlarmSwitch: true, serverFaultSensor: true }),
      [],
    );
    const i = internals(platform);
    expect(i.connectionService).toBeDefined();
    expect(i.waterLowService).toBeDefined();
    expect(i.primeService).toBeDefined();
    expect(i.ledService).toBeDefined();
    // G0: two per-side TestAlarmServices, not one shared instance.
    expect(i.testAlarmServices.get('left')).toBeDefined();
    expect(i.testAlarmServices.get('right')).toBeDefined();
    expect(i.serverFaultService).toBeDefined();
  });

  it('all four disabled: only connection and water-low exist', async () => {
    const { platform } = await simulateRestart(
      factory(resolvedFakeClient()),
      baseConfig({ primeSwitch: false, ledLightbulb: false, testAlarmSwitch: false, serverFaultSensor: false }),
      [],
    );
    const i = internals(platform);
    expect(i.connectionService).toBeDefined();
    expect(i.waterLowService).toBeDefined();
    expect(i.primeService).toBeUndefined();
    expect(i.ledService).toBeUndefined();
    expect(i.testAlarmServices.size).toBe(0);
    expect(i.serverFaultService).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: snapshot-change routing for the three new device-level fields (tasks.md 9.4)
// ---------------------------------------------------------------------------------------

describe('the three new hub-accessory snapshot fields route only to their own service (tasks.md 9.4)', () => {
  it('isPriming routes only to PrimeService.refresh()', async () => {
    const { platform } = await simulateRestart(
      factory(resolvedFakeClient()),
      baseConfig({ primeSwitch: true, ledLightbulb: true, testAlarmSwitch: true, serverFaultSensor: true }),
      [],
    );
    const i = internals(platform);
    const primeSpy = vi.spyOn(i.primeService!, 'refresh');
    const waterLowSpy = vi.spyOn(i.waterLowService!, 'refresh');
    const serverFaultSpy = vi.spyOn(i.serverFaultService!, 'refresh');
    const connectionSpy = vi.spyOn(i.connectionService!, 'refresh');

    i.handleSnapshotChanges([{ scope: 'device', field: 'isPriming', previous: false, current: true }]);

    expect(primeSpy).toHaveBeenCalledTimes(1);
    expect(waterLowSpy).not.toHaveBeenCalled();
    expect(serverFaultSpy).not.toHaveBeenCalled();
    expect(connectionSpy).not.toHaveBeenCalled();
  });

  it('waterLevelState routes only to WaterLowService.refresh()', async () => {
    const { platform } = await simulateRestart(
      factory(resolvedFakeClient()),
      baseConfig({ primeSwitch: true, ledLightbulb: true, testAlarmSwitch: true, serverFaultSensor: true }),
      [],
    );
    const i = internals(platform);
    const primeSpy = vi.spyOn(i.primeService!, 'refresh');
    const waterLowSpy = vi.spyOn(i.waterLowService!, 'refresh');
    const serverFaultSpy = vi.spyOn(i.serverFaultService!, 'refresh');

    i.handleSnapshotChanges([{ scope: 'device', field: 'waterLevelState', previous: 'ok', current: 'low' }]);

    expect(waterLowSpy).toHaveBeenCalledTimes(1);
    expect(primeSpy).not.toHaveBeenCalled();
    expect(serverFaultSpy).not.toHaveBeenCalled();
  });

  it('serverFault routes only to ServerFaultService.refresh()', async () => {
    const { platform } = await simulateRestart(
      factory(resolvedFakeClient()),
      baseConfig({ primeSwitch: true, ledLightbulb: true, testAlarmSwitch: true, serverFaultSensor: true }),
      [],
    );
    const i = internals(platform);
    const primeSpy = vi.spyOn(i.primeService!, 'refresh');
    const waterLowSpy = vi.spyOn(i.waterLowService!, 'refresh');
    const serverFaultSpy = vi.spyOn(i.serverFaultService!, 'refresh');

    i.handleSnapshotChanges([{ scope: 'device', field: 'serverFault', previous: false, current: true }]);

    expect(serverFaultSpy).toHaveBeenCalledTimes(1);
    expect(primeSpy).not.toHaveBeenCalled();
    expect(waterLowSpy).not.toHaveBeenCalled();
  });

  // S1 fix (PR #44 review): the serverStatus poll's own reachability axis also routes to
  // ServerFaultService.refresh() — distinct from, but landing on the same service as, the
  // `serverFault` payload signal above.
  it('serverStatusOnline routes only to ServerFaultService.refresh()', async () => {
    const { platform } = await simulateRestart(
      factory(resolvedFakeClient()),
      baseConfig({ primeSwitch: true, ledLightbulb: true, testAlarmSwitch: true, serverFaultSensor: true }),
      [],
    );
    const i = internals(platform);
    const primeSpy = vi.spyOn(i.primeService!, 'refresh');
    const waterLowSpy = vi.spyOn(i.waterLowService!, 'refresh');
    const serverFaultSpy = vi.spyOn(i.serverFaultService!, 'refresh');

    i.handleSnapshotChanges([{ scope: 'device', field: 'serverStatusOnline', previous: true, current: false }]);

    expect(serverFaultSpy).toHaveBeenCalledTimes(1);
    expect(primeSpy).not.toHaveBeenCalled();
    expect(waterLowSpy).not.toHaveBeenCalled();
  });

  // S2 fix (PR #44 review): an externally-changed LED brightness/on-off routes to
  // LedService.refresh() so the tile no longer goes stale after construction.
  it('ledBrightness routes only to LedService.refresh()', async () => {
    const { platform } = await simulateRestart(
      factory(resolvedFakeClient()),
      baseConfig({ primeSwitch: true, ledLightbulb: true, testAlarmSwitch: true, serverFaultSensor: true }),
      [],
    );
    const i = internals(platform);
    const primeSpy = vi.spyOn(i.primeService!, 'refresh');
    const waterLowSpy = vi.spyOn(i.waterLowService!, 'refresh');
    const serverFaultSpy = vi.spyOn(i.serverFaultService!, 'refresh');
    const ledSpy = vi.spyOn(i.ledService!, 'refresh');

    i.handleSnapshotChanges([{ scope: 'device', field: 'ledBrightness', previous: 20, current: 80 }]);

    expect(ledSpy).toHaveBeenCalledTimes(1);
    expect(primeSpy).not.toHaveBeenCalled();
    expect(waterLowSpy).not.toHaveBeenCalled();
    expect(serverFaultSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: shutdown stops PrimeService and TestAlarmService (tasks.md 9.5)
// ---------------------------------------------------------------------------------------

describe('shutdown stops PrimeService and TestAlarmService alongside the existing stops (tasks.md 9.5)', () => {
  it('no pending timer remains after shutdown with a refused prime-off write and an in-flight test-alarm trigger both outstanding', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const api = new FakeHomebridgeApi();
      const log = createFakeLogging();
      const onDeviceStatus = structuredClone(fixtureDeviceStatus);
      onDeviceStatus.isPriming = true;
      const client = resolvedFakeClient({ getDeviceStatus: () => Promise.resolve(structuredClone(onDeviceStatus)) });

      const platform = new FreeSleepPlatform(
        log,
        baseConfig({ primeSwitch: true, testAlarmSwitch: true }),
        api.asApi(),
        client,
        timers,
      );
      await api.fireDidFinishLaunching();
      const perAccessoryOverhead = api.registeredAccessories.length;

      const hub = api.registeredAccessories.find((a) => a.displayName === 'Pod')!;
      const hap = api.hap;
      const primeSwitch = hub.getServiceById(hap.Service.Switch, PRIME_SUBTYPE)!;
      // G0: two per-side test-alarm switches — exercise both, so shutdown must clear both
      // TestAlarmService instances' self-reset timers.
      const testAlarmLeftSwitch = hub.getServiceById(hap.Service.Switch, TEST_ALARM_LEFT_SUBTYPE)!;
      const testAlarmRightSwitch = hub.getServiceById(hap.Service.Switch, TEST_ALARM_RIGHT_SUBTYPE)!;

      // Refused prime-off write — schedules PrimeService's revert timer.
      const primeOn = primeSwitch.getCharacteristic(hap.Characteristic.On);
      const primeOff = primeOn.handleSetRequest(false);
      primeOff.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);

      // In-flight test-alarm triggers, both sides — schedules each TestAlarmService's own
      // self-reset timer.
      const testAlarmLeftOn = testAlarmLeftSwitch.getCharacteristic(hap.Characteristic.On);
      const alarmLeftPending = testAlarmLeftOn.handleSetRequest(true);
      alarmLeftPending.catch(() => undefined);
      const testAlarmRightOn = testAlarmRightSwitch.getCharacteristic(hap.Characteristic.On);
      const alarmRightPending = testAlarmRightOn.handleSetRequest(true);
      alarmRightPending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);

      expect(timers.pendingCount()).toBeGreaterThan(perAccessoryOverhead);

      await api.fireShutdown();
      expect(timers.pendingCount()).toBe(perAccessoryOverhead);
      void platform;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Occupancy change (#19): platform wiring (tasks.md 8.1, 8.2, 8.3, 8.4)
// ---------------------------------------------------------------------------------------

describe('occupancy sensor wiring (tasks.md 8.1, 8.2)', () => {
  it('occupancySource: none (the default) constructs no occupancy sensor for either side', async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
    };
    const { api, platform } = await simulateRestart(factory(client), baseConfig(), []);
    expect(internals(platform).occupancySensors.size).toBe(0);

    for (const accessory of api.registeredAccessories) {
      expect(accessory.services.some((s) => s.UUID === api.hap.Service.OccupancySensor.UUID)).toBe(false);
    }
  });

  it("occupancySource: 'presence' constructs exactly one occupancy sensor per side", async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
    };
    const { api, platform } = await simulateRestart(factory(client), baseConfig({ occupancySource: 'presence' }), []);
    expect(internals(platform).occupancySensors.size).toBe(2);

    const left = api.registeredAccessories.find((a) => a.displayName === 'Pod Left')!;
    expect(left.getServiceById(api.hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)).toBeDefined();
  });

  it("restarting from 'none' to 'presence' adds the occupancy sensor without duplicating the thermostat", async () => {
    const client = (): MinimalPodClient => ({
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
    });
    const first = await simulateRestart(factory(client()), baseConfig(), []);
    const previous = first.api.registeredAccessories;

    const second = await simulateRestart(factory(client()), baseConfig({ occupancySource: 'presence' }), previous);
    expect(second.api.registerPlatformAccessoriesCalls).toHaveLength(0); // no new accessory
    expect(second.api.unregisterPlatformAccessoriesCalls).toHaveLength(0);

    const left = previous.find((a) => a.displayName === 'Pod Left')!;
    const hap = second.api.hap;
    expect(left.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)).toBeDefined();
    expect(left.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)).toBeDefined();
    expect(left.services.filter((s) => s.UUID === hap.Service.Thermostat.UUID)).toHaveLength(1);
  });

  it("restarting from 'presence' to 'none' prunes the occupancy sensor, leaving the thermostat untouched", async () => {
    const client = (): MinimalPodClient => ({
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
    });
    const first = await simulateRestart(factory(client()), baseConfig({ occupancySource: 'presence' }), []);
    const previous = first.api.registeredAccessories;
    const hap = first.api.hap;
    expect(previous.find((a) => a.displayName === 'Pod Left')!.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)).toBeDefined();

    const second = await simulateRestart(factory(client()), baseConfig({ occupancySource: 'none' }), previous);
    expect(internals(second.platform).occupancySensors.size).toBe(0);

    const left = previous.find((a) => a.displayName === 'Pod Left')!;
    expect(left.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)).toBeUndefined();
    expect(left.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)).toBeDefined();
  });

  it("switching between two non-'none' sources reuses the same occupancy service — no prune/re-add churn", async () => {
    const client = (): MinimalPodClient => ({
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
    });
    const first = await simulateRestart(factory(client()), baseConfig({ occupancySource: 'presence' }), []);
    const previous = first.api.registeredAccessories;
    const hap = first.api.hap;
    const left = previous.find((a) => a.displayName === 'Pod Left')!;
    const originalService = left.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)!;

    const second = await simulateRestart(factory(client()), baseConfig({ occupancySource: 'vitals' }), previous);
    void second;

    expect(left.services.filter((s) => s.UUID === hap.Service.OccupancySensor.UUID)).toHaveLength(1);
    expect(left.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)).toBe(originalService);
  });
});

describe('occupancy snapshot-change routing (tasks.md 8.3)', () => {
  it("a left-side vitalsOccupied change reaches only the left occupancy sensor", async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
    };
    const { platform } = await simulateRestart(factory(client), baseConfig({ occupancySource: 'vitals' }), []);
    const left = internals(platform).occupancySensors.get('left')!;
    const right = internals(platform).occupancySensors.get('right')!;
    const thermostatLeft = internals(platform).thermostats.get('left')!;
    const leftSpy = vi.spyOn(left, 'refresh');
    const rightSpy = vi.spyOn(right, 'refresh');
    const thermostatSpy = vi.spyOn(thermostatLeft, 'refresh');

    internals(platform).handleSnapshotChanges([
      { scope: 'side', field: 'vitalsOccupied', side: 'left', previous: false, current: true },
    ]);

    expect(leftSpy).toHaveBeenCalledTimes(1);
    expect(rightSpy).not.toHaveBeenCalled();
    expect(thermostatSpy).not.toHaveBeenCalled();
  });

  it('an occupancy change is ignored, without error, when occupancySource is none', async () => {
    const client: MinimalPodClient = {
      getDeviceStatus: () => Promise.reject(new Error('unreachable')),
      getSettings: () => Promise.reject(new Error('unreachable')),
      getSchedules: () => Promise.reject(new Error('unreachable')),
      getServices: () => Promise.reject(new Error('unreachable')),
      postDeviceStatus: () => Promise.reject(new Error('unreachable')),
      postSettings: () => Promise.reject(new Error('unreachable')),
      getServerStatus: () => Promise.reject(new Error('unreachable')),
      postAlarm: () => Promise.reject(new Error('unreachable')),
    };
    const { platform } = await simulateRestart(factory(client), baseConfig(), []);
    expect(internals(platform).occupancySensors.size).toBe(0);

    expect(() =>
      internals(platform).handleSnapshotChanges([
        { scope: 'side', field: 'presencePresent', side: 'left', previous: undefined, current: true },
      ]),
    ).not.toThrow();
  });
});

describe('occupancySource flows through to the poller (tasks.md 8.4)', () => {
  it("occupancySource: 'presence' with biometrics enabled polls GET /api/metrics/presence; 'none' never does", async () => {
    vi.useFakeTimers();
    const podPresence = await startMockPod();
    const podNone = await startMockPod();
    try {
      const timersPresence = createTimerHarness();
      timersPresence.random = () => 0.5;
      await simulateRestart(
        factory(clientFor(podPresence), timersPresence),
        baseConfig({ occupancySource: 'presence' }),
        [],
      );
      // One presence-poll interval (30s, fixed per design.md) past bootstrap plus the slow-tier
      // interval that lets `services` observe biometrics.enabled first (default 300s) would be
      // needlessly slow for a unit test — narrow both to the minimum this schema allows so the
      // whole sequence (services observes -> presence's `enabled` flips true -> presence polls)
      // completes well inside a normal test timeout.
      await advanceFakeTime(35_000, 100);
      const presenceRequests = podPresence.requests.filter((r) => r.path === '/api/metrics/presence');
      expect(presenceRequests.length).toBeGreaterThan(0);

      const timersNone = createTimerHarness();
      timersNone.random = () => 0.5;
      await simulateRestart(factory(clientFor(podNone), timersNone), baseConfig(), []);
      await advanceFakeTime(35_000, 100);
      expect(podNone.requests.filter((r) => r.path === '/api/metrics/presence')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await podPresence.close();
      await podNone.close();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------------------
// alarm-events (#16): platform wiring (tasks.md 7.1, 7.2, 7.5, 7.6, 8.2)
// ---------------------------------------------------------------------------------------

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Clones the shared schedules fixture (every day power/alarm disabled by default) and enables
 * exactly one eligible weekday/time on `left`, computed from `instantMs` in UTC (no calendar-day
 * shift: `power.off: '20:00'`) — paired with a `settings.timeZone: 'UTC'` override so the derived
 * instant equals `instantMs` directly, no offset arithmetic to reason about in the test. */
function scheduleWithOneAlarmAt(instantMs: number): Schedules {
  const d = new Date(instantMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const weekday = WEEKDAY_NAMES[d.getUTCDay()]!;

  const schedules = structuredClone(fixtureSchedules);
  schedules.left[weekday] = {
    ...schedules.left[weekday],
    power: { ...schedules.left[weekday].power, enabled: true, off: '20:00' },
    alarm: { ...schedules.left[weekday].alarm, enabled: true, time: `${hh}:${mm}` },
  };
  return schedules;
}

describe('alarmPollIntervalMs threads from config into the constructed AlarmWindowScheduler (tasks.md 7.1, 8.2)', () => {
  it('a custom alarmPollIntervalMs governs the deviceStatus poll cadence while a window is active, distinct from a default-configured platform', async () => {
    vi.useFakeTimers();
    // Aligned to a whole-minute boundary — schedules.alarm.time is HH:mm (minute granularity).
    const nowMs = Math.ceil(Date.now() / 60_000) * 60_000;
    vi.setSystemTime(nowMs);
    const instantMs = nowMs + 90_000; // 1.5 min out — inside the default ±3 min margin
    const schedules = scheduleWithOneAlarmAt(instantMs);

    const podFast = await startMockPod({ state: { settings: { timeZone: 'UTC' }, schedules } });
    const podSlow = await startMockPod({ state: { settings: { timeZone: 'UTC' }, schedules } });
    try {
      const timersFast = createTimerHarness();
      timersFast.random = () => 0.5;
      const timersSlow = createTimerHarness();
      timersSlow.random = () => 0.5;

      // Both platforms start with the identical armed window; only their configured
      // alarmPollIntervalMs differs (9000 vs the schema's own 3000 default).
      await simulateRestart(
        factory(clientFor(podFast), timersFast),
        baseConfig({ pollIntervals: { alarmPollIntervalMs: 9000 } }),
        [],
      );
      await simulateRestart(factory(clientFor(podSlow), timersSlow), baseConfig(), []);

      const countDeviceStatus = (pod: MockPod): number =>
        pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/deviceStatus').length;
      const beforeFast = countDeviceStatus(podFast);
      const beforeSlow = countDeviceStatus(podSlow);

      // ~3 polls at a 9000ms cadence, ~9 at the 3000ms default, over the same 27s span.
      await advanceFakeTime(27_000, 100);

      const afterFast = countDeviceStatus(podFast) - beforeFast;
      const afterSlow = countDeviceStatus(podSlow) - beforeSlow;

      expect(afterFast).toBeGreaterThanOrEqual(2);
      expect(afterFast).toBeLessThanOrEqual(4);
      expect(afterFast).toBeLessThan(afterSlow);
    } finally {
      vi.useRealTimers();
      await podFast.close();
      await podSlow.close();
    }
  }, 15_000);
});

describe('shutdown stops the alarm-window scheduler (tasks.md 7.2)', () => {
  it('leaves no pending timer beyond the fixed per-accessory overhead, even with a window currently armed', async () => {
    vi.useFakeTimers();
    try {
      // `resolvedFakeClient()`, not a real `PodClient` against a mock Pod — this file's own
      // `resolvedFakeClient` doc explains why: a real client's own un-cancelable
      // `AbortSignal.timeout()` per-request timer never clears under `vi.useFakeTimers()`,
      // which would make "no timer pending after shutdown" unprovable here regardless of this
      // change's own correctness.
      const nowMs = Math.ceil(Date.now() / 60_000) * 60_000;
      vi.setSystemTime(nowMs);
      const schedules = scheduleWithOneAlarmAt(nowMs + 60_000);
      const client = resolvedFakeClient({
        getSchedules: () => Promise.resolve(schedules),
        getSettings: () => Promise.resolve({ ...structuredClone(fixtureSettings), timeZone: 'UTC' }),
      });

      const timers = createTimerHarness();
      const api = new FakeHomebridgeApi();
      const log = createFakeLogging();
      const platform = new FreeSleepPlatform(log, baseConfig(), api.asApi(), client, timers);
      await api.fireDidFinishLaunching();

      const perAccessoryOverhead = api.registeredAccessories.length;
      expect(timers.pendingCount()).toBeGreaterThan(perAccessoryOverhead);

      await api.fireShutdown();
      expect(timers.pendingCount()).toBe(perAccessoryOverhead);
      void platform;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a side's alarm-vibration change reaches only that side's AlarmService (tasks.md 7.5)", () => {
  it('a left-side isAlarmVibrating change reaches only the left AlarmService', async () => {
    const client: MinimalPodClient = resolvedFakeClient();
    const { platform } = await simulateRestart(factory(client), baseConfig(), []);
    const i = internals(platform);
    const left = i.alarmServices.get('left')!;
    const right = i.alarmServices.get('right')!;
    const leftSpy = vi.spyOn(left, 'handleChange');
    const rightSpy = vi.spyOn(right, 'handleChange');
    const thermostatLeft = i.thermostats.get('left')!;
    const thermostatSpy = vi.spyOn(thermostatLeft, 'refresh');

    i.handleSnapshotChanges([{ scope: 'side', field: 'isAlarmVibrating', side: 'left', previous: false, current: true }]);

    expect(leftSpy).toHaveBeenCalledTimes(1);
    expect(rightSpy).not.toHaveBeenCalled();
    expect(thermostatSpy).not.toHaveBeenCalled();
  });

  it('alarmEvents: false constructs no AlarmService for either side, and the change is ignored without error', async () => {
    const client: MinimalPodClient = resolvedFakeClient();
    const { platform } = await simulateRestart(factory(client), baseConfig({ alarmEvents: false }), []);
    const i = internals(platform);
    expect(i.alarmServices.size).toBe(0);
    expect(i.alarmWindowScheduler).toBeUndefined();

    expect(() =>
      i.handleSnapshotChanges([{ scope: 'side', field: 'isAlarmVibrating', side: 'left', previous: false, current: true }]),
    ).not.toThrow();
  });
});

describe('shutdown clears each AlarmService\'s pending revert timer (tasks.md 7.6)', () => {
  it('no pending timer remains after shutdown with an on-write\'s accept-then-revert timer outstanding', async () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const api = new FakeHomebridgeApi();
      const log = createFakeLogging();
      const client = resolvedFakeClient();
      const platform = new FreeSleepPlatform(log, baseConfig(), api.asApi(), client, timers);
      await api.fireDidFinishLaunching();
      const perAccessoryOverhead = api.registeredAccessories.length;

      // `resolvedFakeClient()` returns the real settings fixture, so new accessories are named
      // from `settings.left.name`/`settings.right.name` ("Left"/"Right"), not the "Pod Left"/
      // "Pod Right" fallback (mirrors this file's own "a blocked write's pending away-mode-
      // revert timer..." test above).
      const left = accessoryByName(api, 'Left');
      const hap = api.hap;
      const dismissSwitch = left.getServiceById(hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
      const onChar = dismissSwitch.getCharacteristic(hap.Characteristic.On);

      const pending = onChar.handleSetRequest(true);
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);

      expect(timers.pendingCount()).toBeGreaterThan(perAccessoryOverhead);

      await api.fireShutdown();
      expect(timers.pendingCount()).toBe(perAccessoryOverhead);
      void platform;
    } finally {
      vi.useRealTimers();
    }
  });
});

function accessoryByName(api: FakeHomebridgeApi, name: string): FakePlatformAccessory {
  const accessory = api.registeredAccessories.find((a) => a.displayName === name);
  if (!accessory) throw new Error(`no registered accessory named ${name}`);
  return accessory;
}
