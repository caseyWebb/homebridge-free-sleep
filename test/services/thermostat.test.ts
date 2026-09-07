import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler, CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { cToF, F_MAX, F_MIN, fToC } from '../../src/pod/temperature.js';
import { DeviceStatusSchema, type DeviceStatus, type Settings } from '../../src/pod/types.js';
import { WriteQueue, type FastPollLane } from '../../src/pod/writeQueue.js';
import { CONFIGURED_NAME } from '../../src/services/serviceName.js';
import { isThermostatChange, THERMOSTAT_SUBTYPE, ThermostatService } from '../../src/services/thermostat.js';
import type { ServiceContext } from '../../src/services/types.js';
import { captureCharacteristicWarnings } from './configuredNameHelpers.js';
import { createFakePodClient, type FakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture: DeviceStatus = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture = loadFixture('settings.json') as Settings;
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
  fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }>;
  ctx: ServiceContext;
}

function setup(options: { config?: Record<string, unknown>; observe?: boolean } = {}): Setup {
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const accessory = new api.platformAccessory('Pod Left', api.hap.uuid.generate('left'), api.hap.Categories.THERMOSTAT);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  if (options.observe !== false) {
    snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    snapshot.observeSettings(structuredClone(settingsFixture));
  }
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings: settingsFixture,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schedules: schedulesFixture as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services: servicesFixture as any,
  });
  const fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }> = [];
  const config = baseConfig(options.config);
  // Built from the same config key `platform.ts` reads (`awayModeWritePolicy`) and the same
  // shared `snapshot` — matching real wiring, so a test can flip the policy or seed away mode
  // via `options.config`/`snapshot.observeSettings` and see `writeQueue`'s own dispatch-time
  // guard react exactly as it would in production.
  const awayModeGuard = new AwayModeGuard({ snapshot, policy: config.awayModeWritePolicy });
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot,
    requestFastPoll: (lane, untilMs) => fastPollRequests.push({ lane, untilMs }),
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
  return { api, accessory, snapshot, timers, fake, writeQueue, fastPollRequests, ctx };
}

/** Captures the `onGet`/`onSet` handler functions each characteristic was actually wired with,
 * keyed by characteristic UUID — calling the captured function directly is a much more direct
 * way to assert "this handler is synchronous" or "this handler produced this Pod write" than
 * routing through HAP's own async `handleGetRequest`/`handleSetRequest` machinery, which wraps
 * every handler in a promise regardless of whether the handler itself is sync or async. */
function build(
  ctx: ServiceContext,
  side: 'left' | 'right',
  platformStartedAt = ctx.timers.now(),
): {
  service: ThermostatService;
  getHandlers: Map<string, CharacteristicGetHandler>;
  setHandlers: Map<string, CharacteristicSetHandler>;
} {
  const getHandlers = new Map<string, CharacteristicGetHandler>();
  const setHandlers = new Map<string, CharacteristicSetHandler>();
  const getSpy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicGetHandler,
  ) {
    getHandlers.set(this.UUID, handler);
    return this;
  });
  const setSpy = vi.spyOn(Characteristic.prototype, 'onSet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicSetHandler,
  ) {
    setHandlers.set(this.UUID, handler);
    return this;
  });
  const service = new ThermostatService(ctx, side, platformStartedAt);
  getSpy.mockRestore();
  setSpy.mockRestore();
  return { service, getHandlers, setHandlers };
}

const UUID = {
  targetState: Characteristic.TargetHeatingCoolingState.UUID,
  currentState: Characteristic.CurrentHeatingCoolingState.UUID,
  targetTemp: Characteristic.TargetTemperature.UUID,
  currentTemp: Characteristic.CurrentTemperature.UUID,
  displayUnits: Characteristic.TemperatureDisplayUnits.UUID,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 2. Thermostat construction and properties
// ---------------------------------------------------------------------------------------

describe('construction (2.1)', () => {
  it('adds exactly one Thermostat service, primary, with the five characteristics and neither threshold', () => {
    const { ctx, accessory, api } = setup();
    new ThermostatService(ctx, 'left', 0);

    const thermostats = accessory.services.filter((s) => s.UUID === api.hap.Service.Thermostat.UUID);
    expect(thermostats).toHaveLength(1);
    const service = thermostats[0]!;
    expect(service.subtype).toBe(THERMOSTAT_SUBTYPE);
    expect(service.isPrimaryService).toBe(true);

    const uuids = service.characteristics.map((c) => c.UUID);
    expect(uuids).toEqual(
      expect.arrayContaining([UUID.targetState, UUID.currentState, UUID.targetTemp, UUID.currentTemp, UUID.displayUnits]),
    );
    expect(uuids).not.toContain(api.hap.Characteristic.HeatingThresholdTemperature.UUID);
    expect(uuids).not.toContain(api.hap.Characteristic.CoolingThresholdTemperature.UUID);
  });

  it('restores by getServiceById rather than adding a second Thermostat service', () => {
    const { ctx, accessory, api } = setup();
    new ThermostatService(ctx, 'left', 0);
    new ThermostatService(ctx, 'left', 0);

    const thermostats = accessory.services.filter((s) => s.UUID === api.hap.Service.Thermostat.UUID);
    expect(thermostats).toHaveLength(1);
  });
});

describe('properties declared at construction (2.2)', () => {
  it('TargetHeatingCoolingState validValues are exactly [OFF, AUTO], OFF first', () => {
    const { ctx, api } = setup();
    new ThermostatService(ctx, 'left', 0);
    const accessory = ctx.accessory;
    const service = accessory.getServiceById(api.hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const char = service.getCharacteristic(api.hap.Characteristic.TargetHeatingCoolingState);
    expect(Array.from(char.validValuesIterator())).toEqual([
      api.hap.Characteristic.TargetHeatingCoolingState.OFF,
      api.hap.Characteristic.TargetHeatingCoolingState.AUTO,
    ]);
  });

  it('TargetTemperature validValues has 56 whole degrees, 110°F reachable', () => {
    const { ctx, api } = setup();
    new ThermostatService(ctx, 'left', 0);
    const service = ctx.accessory.getServiceById(api.hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const char = service.getCharacteristic(api.hap.Characteristic.TargetTemperature);
    const validValues = Array.from(char.validValuesIterator()) as number[];
    expect(validValues).toHaveLength(F_MAX - F_MIN + 1);
    expect(Math.round(cToF(validValues[validValues.length - 1]!))).toBe(F_MAX);
  });

  it('CurrentTemperature is not clamped to the settable range — a sub-55°F reading round-trips', () => {
    const { ctx, api } = setup();
    new ThermostatService(ctx, 'left', 0);
    const service = ctx.accessory.getServiceById(api.hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const char = service.getCharacteristic(api.hap.Characteristic.CurrentTemperature);
    char.updateValue(fToC(40));
    // HAP snaps a pushed float onto the characteristic's minStep grid (default 0.1 here, since
    // this service declares no explicit minStep for CurrentTemperature) — so the stored value
    // is fToC(40) rounded to the nearest 0.1°C, not lied about by clamping to fToC(F_MIN).
    expect(char.value).toBeCloseTo(fToC(40), 1);
    expect(char.value).not.toBeCloseTo(fToC(F_MIN), 1);
  });

  it('CurrentHeatingCoolingState has no explicit setProps call — its default valid values already [OFF, HEAT, COOL]', () => {
    const { ctx, api } = setup();
    new ThermostatService(ctx, 'left', 0);
    const service = ctx.accessory.getServiceById(api.hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const char = service.getCharacteristic(api.hap.Characteristic.CurrentHeatingCoolingState);
    expect(Array.from(char.validValuesIterator())).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------------------
// 3. Thermostat reads
// ---------------------------------------------------------------------------------------

describe('reads are synchronous (3.1)', () => {
  it('none of the five onGet handlers return a Promise', () => {
    const { ctx } = setup();
    const { getHandlers } = build(ctx, 'left');
    expect(getHandlers.size).toBe(5);
    for (const [, handler] of getHandlers) {
      const result = handler({} as never, undefined);
      expect(result).not.toBeInstanceOf(Promise);
    }
  });

  it('reading every characteristic 100 times against a started mock Pod adds zero requests', async () => {
    const { startMockPod } = await import('../mockPod.js');
    const pod = await startMockPod();
    try {
      const { ctx } = setup({ observe: false });
      const { getHandlers } = build(ctx, 'left');
      for (let i = 0; i < 100; i++) {
        for (const [, handler] of getHandlers) handler({} as never, undefined);
      }
      expect(pod.requests).toHaveLength(0);
    } finally {
      await pod.close();
    }
  });
});

describe('sticky ±1°F deadband (3.2)', () => {
  function currentState(ctx: ServiceContext, deviceStatus: DeviceStatus, seedValue?: number): number {
    const { getHandlers, service } = build(ctx, 'left');
    void service;
    if (seedValue !== undefined) {
      const svc = ctx.accessory.getServiceById(ctx.api.hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
      svc.getCharacteristic(ctx.api.hap.Characteristic.CurrentHeatingCoolingState).updateValue(seedValue);
    }
    ctx.snapshot.observeDeviceStatus(deviceStatus);
    return getHandlers.get(UUID.currentState)!({} as never, undefined) as number;
  }

  it('side off -> OFF', () => {
    const { ctx } = setup({ observe: false });
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isOn = false;
    ds.left.secondsRemaining = 0;
    expect(currentState(ctx, ds)).toBe(ctx.api.hap.Characteristic.CurrentHeatingCoolingState.OFF);
  });

  it('delta >= +1 -> HEAT', () => {
    const { ctx } = setup({ observe: false });
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isOn = true;
    ds.left.targetTemperatureF = 80;
    ds.left.currentTemperatureF = 70;
    expect(currentState(ctx, ds)).toBe(ctx.api.hap.Characteristic.CurrentHeatingCoolingState.HEAT);
  });

  it('delta <= -1 -> COOL', () => {
    const { ctx } = setup({ observe: false });
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isOn = true;
    ds.left.targetTemperatureF = 70;
    ds.left.currentTemperatureF = 80;
    expect(currentState(ctx, ds)).toBe(ctx.api.hap.Characteristic.CurrentHeatingCoolingState.COOL);
  });

  it('an oscillation inside the deadband holds the previous state across at least six observations', () => {
    const { ctx } = setup({ observe: false });
    const { getHandlers, service } = build(ctx, 'left');
    void service;
    const hap = ctx.api.hap;
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    svc.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState).updateValue(hap.Characteristic.CurrentHeatingCoolingState.HEAT);

    // Strictly inside the (-1, +1) deadband — a delta reaching exactly ±1 is the deadband's own
    // boundary and would legitimately flip state, so it would not exercise stickiness at all.
    const deltas = [0, 0.5, -0.5, 0.9, -0.9, 0.2];
    for (const delta of deltas) {
      const ds = structuredClone(deviceStatusFixture);
      ds.left.isOn = true;
      ds.left.currentTemperatureF = 75;
      ds.left.targetTemperatureF = 75 + delta;
      ctx.snapshot.observeDeviceStatus(ds);
      const result = getHandlers.get(UUID.currentState)!({} as never, undefined);
      expect(result).toBe(hap.Characteristic.CurrentHeatingCoolingState.HEAT);
    }
  });

  it('first-ever launch inside the deadband seeds HEAT for a non-negative delta', () => {
    const { ctx } = setup({ observe: false });
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isOn = true;
    ds.left.currentTemperatureF = 75;
    ds.left.targetTemperatureF = 75;
    expect(currentState(ctx, ds)).toBe(ctx.api.hap.Characteristic.CurrentHeatingCoolingState.HEAT);
  });

  it('first-ever launch inside the deadband seeds COOL for a negative delta', () => {
    const { ctx } = setup({ observe: false });
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isOn = true;
    ds.left.currentTemperatureF = 75;
    ds.left.targetTemperatureF = 74.6; // rounds to a delta just under 0 in whole-degree terms
    // Whole-degree deltas only ever land on integers in real data, but the rule is defined on
    // the raw difference — use an exact -0.4 to hit the negative-but-inside-deadband branch.
    expect(currentState(ctx, ds)).toBe(ctx.api.hap.Characteristic.CurrentHeatingCoolingState.COOL);
  });
});

describe('unknown-snapshot fallback (3.3)', () => {
  it('every onGet returns characteristic.value when the device-status class has never been observed', () => {
    const { ctx } = setup({ observe: false });
    const hap = ctx.api.hap;
    const { getHandlers } = build(ctx, 'left');
    const service = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;

    service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).updateValue(hap.Characteristic.TargetHeatingCoolingState.AUTO);
    service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState).updateValue(hap.Characteristic.CurrentHeatingCoolingState.HEAT);
    service.getCharacteristic(hap.Characteristic.TargetTemperature).updateValue(fToC(70));
    service.getCharacteristic(hap.Characteristic.CurrentTemperature).updateValue(fToC(68));

    expect(getHandlers.get(UUID.targetState)!({} as never, undefined)).toBe(hap.Characteristic.TargetHeatingCoolingState.AUTO);
    expect(getHandlers.get(UUID.currentState)!({} as never, undefined)).toBe(hap.Characteristic.CurrentHeatingCoolingState.HEAT);
    expect(getHandlers.get(UUID.targetTemp)!({} as never, undefined)).toBeCloseTo(fToC(70), 10);
    expect(getHandlers.get(UUID.currentTemp)!({} as never, undefined)).toBeCloseTo(fToC(68), 10);

    for (const [, handler] of getHandlers) {
      expect(() => handler({} as never, undefined)).not.toThrow();
    }
  });
});

describe('TemperatureDisplayUnits lazy seed (3.4)', () => {
  it("a 'celsius' settings value seeds CELSIUS", () => {
    const { ctx } = setup({ observe: false });
    const hap = ctx.api.hap;
    const { getHandlers } = build(ctx, 'left');
    ctx.snapshot.observeSettings({ ...settingsFixture, temperatureFormat: 'celsius' });

    expect(getHandlers.get(UUID.displayUnits)!({} as never, undefined)).toBe(hap.Characteristic.TemperatureDisplayUnits.CELSIUS);
  });

  it('a subsequent write to FAHRENHEIT is served on the next read', () => {
    const { ctx } = setup({ observe: false });
    const hap = ctx.api.hap;
    const { getHandlers, setHandlers } = build(ctx, 'left');
    ctx.snapshot.observeSettings({ ...settingsFixture, temperatureFormat: 'celsius' });
    getHandlers.get(UUID.displayUnits)!({} as never, undefined);

    setHandlers.get(UUID.displayUnits)!(hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT, {} as never, undefined);

    expect(getHandlers.get(UUID.displayUnits)!({} as never, undefined)).toBe(hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
  });

  it('a later settings change to celsius does not overwrite an already-written unit', () => {
    const { ctx, fake } = setup({ observe: false });
    const hap = ctx.api.hap;
    const { getHandlers, setHandlers } = build(ctx, 'left');
    setHandlers.get(UUID.displayUnits)!(hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT, {} as never, undefined);

    ctx.snapshot.observeSettings({ ...settingsFixture, temperatureFormat: 'celsius' });

    expect(getHandlers.get(UUID.displayUnits)!({} as never, undefined)).toBe(hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
    expect(fake.deviceStatus.calls + fake.settings.calls + fake.schedules.calls + fake.services.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// 4. Thermostat writes
// ---------------------------------------------------------------------------------------

describe('writes map to minimal patches (4.1)', () => {
  it('AUTO produces a body carrying only isOn', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { setHandlers } = build(ctx, 'left');
    const pending = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.AUTO, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isOn: true } }]);
  });

  it('OFF produces a body carrying only isOn: false', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { setHandlers } = build(ctx, 'left');
    const pending = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.OFF, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isOn: false } }]);
  });

  it('a setpoint write produces a body carrying only the rounded targetTemperatureF', async () => {
    const { ctx, fake } = setup();
    const { setHandlers } = build(ctx, 'left');
    const pending = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { targetTemperatureF: 70 } }]);
  });

  it('no write ever reaches the settings endpoint', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { setHandlers } = build(ctx, 'left');
    const p1 = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.AUTO, {} as never, undefined);
    const p2 = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    setHandlers.get(UUID.displayUnits)!(hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([p1, p2]);
    expect(fake.postSettingsCalls).toHaveLength(0);
  });
});

describe('write failure surfaces as SERVICE_COMMUNICATION_FAILURE (4.2)', () => {
  it('a rejected dispatch makes the mode-write handler throw HapStatusError(SERVICE_COMMUNICATION_FAILURE)', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('network down') };
    const { setHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.AUTO, {} as never, undefined);
    const assertion = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });

  it('a rejected dispatch makes the setpoint-write handler throw the same status', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('network down') };
    const { setHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    const assertion = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });
});

describe('away-mode block maps to NOT_ALLOWED_IN_CURRENT_STATE and reverts the tile (3.2, 3.3)', () => {
  it("a mode write blocked by the away-mode guard throws NOT_ALLOWED_IN_CURRENT_STATE, distinct from SERVICE_COMMUNICATION_FAILURE, and the Pod receives nothing", async () => {
    const { ctx, fake } = setup({ config: { awayModeWritePolicy: 'block' } });
    const hap = ctx.api.hap;
    ctx.snapshot.observeSettings({ ...structuredClone(settingsFixture), right: { ...settingsFixture.right, awayMode: true } });
    const { setHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.AUTO, {} as never, undefined);
    const assertion = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
  });

  it('a setpoint write blocked by the away-mode guard throws the same distinct status', async () => {
    const { ctx, fake } = setup({ config: { awayModeWritePolicy: 'block' } });
    const hap = ctx.api.hap;
    ctx.snapshot.observeSettings({ ...structuredClone(settingsFixture), right: { ...settingsFixture.right, awayMode: true } });
    const { setHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    const assertion = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
  });

  it('~500ms after a blocked setpoint write, the characteristic is corrected back to the cached snapshot value', async () => {
    const { ctx, fake } = setup({ config: { awayModeWritePolicy: 'block' } });
    const hap = ctx.api.hap;
    ctx.snapshot.observeSettings({ ...structuredClone(settingsFixture), right: { ...settingsFixture.right, awayMode: true } });
    const { setHandlers } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(hap.Characteristic.TargetTemperature), 'updateValue');
    // Deliberately no `ctx.snapshot.subscribe(() => service.refresh())` here (contrast with
    // "failed-write revert (5.4)" above) — isolating this test to *only* the explicit
    // `scheduleAwayModeRevert` timer this change adds (task 3.3), not the platform-level
    // snapshot-subscription revert `handleSnapshotChanges` provides in real wiring.

    const pending = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    const assertion = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE });
    await vi.advanceTimersByTimeAsync(400); // debounce flush -> dispatch -> guard blocks
    await assertion;
    expect(spy).not.toHaveBeenCalled(); // not yet — nothing has called refresh() at this point

    await vi.advanceTimersByTimeAsync(500); // the scheduled corrective refresh fires
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(fToC(deviceStatusFixture.left.targetTemperatureF));
    void fake;
  });
});

describe('write coalescing end to end (4.3)', () => {
  it('a mode write and a setpoint write 10ms apart produce exactly one POST carrying both fields', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { setHandlers } = build(ctx, 'left');

    const p1 = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.AUTO, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(10);
    const p2 = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([p1, p2]);

    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isOn: true, targetTemperatureF: 70 } }]);
  });
});

// ---------------------------------------------------------------------------------------
// 5. The °F shadow
// ---------------------------------------------------------------------------------------

describe('the °F shadow (5.1)', () => {
  it('two successive observations of the same degree push exactly once; a different degree pushes again', () => {
    const { ctx } = setup({ observe: false });
    const hap = ctx.api.hap;
    const { service } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(hap.Characteristic.TargetTemperature), 'updateValue');

    const ds1 = structuredClone(deviceStatusFixture);
    ds1.left.targetTemperatureF = 70;
    ctx.snapshot.observeDeviceStatus(ds1);
    service.refresh();
    expect(spy).toHaveBeenCalledTimes(1);

    const ds2 = structuredClone(deviceStatusFixture);
    ds2.left.targetTemperatureF = 70;
    ctx.snapshot.observeDeviceStatus(ds2);
    service.refresh();
    expect(spy).toHaveBeenCalledTimes(1);

    const ds3 = structuredClone(deviceStatusFixture);
    ds3.left.targetTemperatureF = 71;
    ctx.snapshot.observeDeviceStatus(ds3);
    service.refresh();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('a write claims the shadow without pushing (5.2)', () => {
  it('write -> overlay change event -> confirming observation of the same degree produces zero updateValue calls', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { service, setHandlers } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const targetTempChar = svc.getCharacteristic(hap.Characteristic.TargetTemperature);
    const spy = vi.spyOn(targetTempChar, 'updateValue');

    ctx.snapshot.subscribe(() => service.refresh());

    const pending = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(spy).not.toHaveBeenCalled();

    const confirming = structuredClone(deviceStatusFixture);
    confirming.left.targetTemperatureF = 70;
    ctx.snapshot.observeDeviceStatus(confirming);
    expect(spy).not.toHaveBeenCalled();
    void fake;
  });
});

describe('shadow persistence across a restart (5.3)', () => {
  it('a first observation reporting the same degrees published before produces zero updateValue calls', () => {
    const { ctx } = setup({ observe: false });
    const hap = ctx.api.hap;
    const first = build(ctx, 'left');
    const ds = structuredClone(deviceStatusFixture);
    ds.left.currentTemperatureF = 68;
    ds.left.targetTemperatureF = 70;
    ctx.snapshot.observeDeviceStatus(ds);
    first.service.refresh();

    // Simulate a restart: a fresh ThermostatService instance over the SAME accessory (so the
    // SAME `accessory.context.publishedF` persists), against a fresh SnapshotStore seeded with
    // the identical observation.
    const freshSnapshot = new SnapshotStore({ timers: ctx.timers });
    freshSnapshot.observeDeviceStatus(structuredClone(ds));
    const restartCtx: ServiceContext = { ...ctx, snapshot: freshSnapshot };
    const restarted = build(restartCtx, 'left');
    const restartedService = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const targetSpy = vi.spyOn(restartedService.getCharacteristic(hap.Characteristic.TargetTemperature), 'updateValue');
    const currentSpy = vi.spyOn(restartedService.getCharacteristic(hap.Characteristic.CurrentTemperature), 'updateValue');

    restarted.service.refresh();

    expect(targetSpy).not.toHaveBeenCalled();
    expect(currentSpy).not.toHaveBeenCalled();
  });
});

describe('failed-write revert (5.4)', () => {
  it('a failed dispatch clearing the overlay pushes the last observed degree back exactly once', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { service, setHandlers } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(hap.Characteristic.TargetTemperature), 'updateValue');
    ctx.snapshot.subscribe(() => service.refresh());

    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('rejected') };
    const pending = setHandlers.get(UUID.targetTemp)!(fToC(70), {} as never, undefined);
    const assertion = expect(pending).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(400);
    await assertion;

    // The failed dispatch cleared the overlay; the effective value reverts to the last raw
    // observation (the fixture's 84°F for `left`) and the resulting change event pushes it.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(fToC(deviceStatusFixture.left.targetTemperatureF));
  });
});

// ---------------------------------------------------------------------------------------
// #33 — an out-of-range observed target temperature is clamped at the service boundary
// ---------------------------------------------------------------------------------------

describe('#33: an out-of-range target temperature is clamped at the service boundary (1.2, 1.4)', () => {
  it('onGet reports the clamped bound, converted, for an above-range or below-range observation', () => {
    const { ctx } = setup({ observe: false });
    const { getHandlers } = build(ctx, 'left');

    const above = structuredClone(deviceStatusFixture);
    above.left.targetTemperatureF = F_MAX + 20;
    ctx.snapshot.observeDeviceStatus(above);
    expect(getHandlers.get(UUID.targetTemp)!({} as never, undefined)).toBeCloseTo(fToC(F_MAX), 10);

    const below = structuredClone(deviceStatusFixture);
    below.left.targetTemperatureF = F_MIN - 20;
    ctx.snapshot.observeDeviceStatus(below);
    expect(getHandlers.get(UUID.targetTemp)!({} as never, undefined)).toBeCloseTo(fToC(F_MIN), 10);
  });

  it('an out-of-range observation publishes the clamped bound, the shadow records the clamped value, and a later in-range observation still pushes exactly once', () => {
    const { ctx } = setup({ observe: false });
    const hap = ctx.api.hap;
    const { service } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(hap.Characteristic.TargetTemperature), 'updateValue');

    // An observation outside 55-110 °F: before the fix, the shadow would record the raw 130 °F,
    // and the characteristic would be pushed the unclamped (and unreachable) degree.
    const outOfRange = structuredClone(deviceStatusFixture);
    outOfRange.left.targetTemperatureF = F_MAX + 20;
    ctx.snapshot.observeDeviceStatus(outOfRange);
    service.refresh();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(fToC(F_MAX));

    // A second observation reporting the SAME out-of-range degree pushes nothing further — as
    // far as the shadow comparison is concerned, this is a genuine repeat of the clamped bound
    // already recorded.
    const stillOutOfRange = structuredClone(deviceStatusFixture);
    stillOutOfRange.left.targetTemperatureF = F_MAX + 20;
    ctx.snapshot.observeDeviceStatus(stillOutOfRange);
    service.refresh();
    expect(spy).toHaveBeenCalledTimes(1);

    // A later in-range observation, different from the clamped bound, still produces exactly one
    // correcting push: the earlier out-of-range reading did not permanently desynchronize the
    // shadow (design.md's #33 regression scenario; the pre-fix shadow would have recorded 130,
    // which this 105 °F reading would also have differed from — masking the actual bug this test
    // guards, which is the *value* pushed on the first observation, asserted above).
    const inRange = structuredClone(deviceStatusFixture);
    inRange.left.targetTemperatureF = F_MAX - 5;
    ctx.snapshot.observeDeviceStatus(inRange);
    service.refresh();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(fToC(F_MAX - 5));
  });
});

// ---------------------------------------------------------------------------------------
// S2 — a mode write claims a shadow too, so it is not echoed back to the writer
// ---------------------------------------------------------------------------------------

describe('a mode write claims the shadow without pushing (S2)', () => {
  it('write -> overlay change event -> confirming observation of the same mode produces zero updateValue calls', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { service, setHandlers } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const targetStateChar = svc.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState);
    const spy = vi.spyOn(targetStateChar, 'updateValue');

    ctx.snapshot.subscribe(() => service.refresh());

    const pending = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.AUTO, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    // Before the S2 fix, `submitSide`'s synchronous overlay install reached `refresh()` before
    // HAP had assigned the characteristic's own new value, producing exactly one echo push here.
    expect(spy).not.toHaveBeenCalled();

    const confirming = structuredClone(deviceStatusFixture);
    confirming.left.isOn = true;
    confirming.left.secondsRemaining = 43200;
    ctx.snapshot.observeDeviceStatus(confirming);
    expect(spy).not.toHaveBeenCalled();
    void fake;
  });
});

describe('failed mode write revert (S2)', () => {
  it('a rejected mode write still reverts, pushing the observed mode back exactly once', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    const { service, setHandlers } = build(ctx, 'left');
    const svc = ctx.accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE)!;
    const spy = vi.spyOn(svc.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState), 'updateValue');
    ctx.snapshot.subscribe(() => service.refresh());

    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('rejected') };
    const pending = setHandlers.get(UUID.targetState)!(hap.Characteristic.TargetHeatingCoolingState.AUTO, {} as never, undefined);
    const assertion = expect(pending).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(400);
    await assertion;

    // The failed dispatch cleared the overlay; the effective `isOn` reverts to the last raw
    // observation (`false`/OFF for `left`'s fixture) and the resulting change event pushes it —
    // the "a genuinely divergent later observation still pushes" half of the S2 fix.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(hap.Characteristic.TargetHeatingCoolingState.OFF);
  });
});

// ---------------------------------------------------------------------------------------
// N9 — a TemperatureDisplayUnits write is persisted, only on an actual change
// ---------------------------------------------------------------------------------------

describe('TemperatureDisplayUnits is persisted on an actual change (N9)', () => {
  it('a unit write calls updatePlatformAccessories; a repeat write of the same unit does not', () => {
    const { ctx, api } = setup({ observe: false });
    const hap = ctx.api.hap;
    const { setHandlers } = build(ctx, 'left');

    const before = api.updatePlatformAccessoriesCalls.length;
    setHandlers.get(UUID.displayUnits)!(hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT, {} as never, undefined);
    expect(api.updatePlatformAccessoriesCalls.length).toBe(before + 1);

    setHandlers.get(UUID.displayUnits)!(hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT, {} as never, undefined);
    expect(api.updatePlatformAccessoriesCalls.length).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------
// 6.4 — No-Response escalation (implemented here; ConnectionService deliberately never
// escalates its own reads — see src/services/connection.ts's module doc)
// ---------------------------------------------------------------------------------------

describe('No-Response escalation (6.4)', () => {
  it('reads succeed just inside the escalation window', () => {
    const { ctx } = setup({ observe: false, config: { noResponseAfterMs: 10000 } });
    const platformStartedAt = ctx.timers.now();
    const { getHandlers } = build(ctx, 'left', platformStartedAt);
    ctx.snapshot.recordDeviceStatusFailure('network');

    vi.setSystemTime(platformStartedAt + 9999);

    expect(() => getHandlers.get(UUID.currentState)!({} as never, undefined)).not.toThrow();
  });

  it('reads throw SERVICE_COMMUNICATION_FAILURE just outside the window', () => {
    const { ctx } = setup({ observe: false, config: { noResponseAfterMs: 10000 } });
    const platformStartedAt = ctx.timers.now();
    const { getHandlers } = build(ctx, 'left', platformStartedAt);
    ctx.snapshot.recordDeviceStatusFailure('network');

    vi.setSystemTime(platformStartedAt + 10001);

    expect(() => getHandlers.get(UUID.currentState)!({} as never, undefined)).toThrow(
      expect.objectContaining({ hapStatus: ctx.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE }),
    );
  });

  it('the first successful poll makes the very next read succeed', () => {
    const { ctx } = setup({ observe: false, config: { noResponseAfterMs: 10000 } });
    const platformStartedAt = ctx.timers.now();
    const { getHandlers } = build(ctx, 'left', platformStartedAt);
    ctx.snapshot.recordDeviceStatusFailure('network');

    vi.setSystemTime(platformStartedAt + 20000);
    expect(() => getHandlers.get(UUID.currentState)!({} as never, undefined)).toThrow();

    ctx.snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    expect(() => getHandlers.get(UUID.currentState)!({} as never, undefined)).not.toThrow();
  });

  it('noResponseAfterMs: 0 disables escalation entirely', () => {
    const { ctx } = setup({ observe: false, config: { noResponseAfterMs: 0 } });
    const platformStartedAt = ctx.timers.now();
    const { getHandlers } = build(ctx, 'left', platformStartedAt);
    ctx.snapshot.recordDeviceStatusFailure('network');

    vi.setSystemTime(platformStartedAt + 10_000_000);

    for (const [, handler] of getHandlers) {
      expect(() => handler({} as never, undefined)).not.toThrow();
    }
  });

  it('a launch that never reached the Pod escalates measured from platform start', () => {
    const { ctx } = setup({ observe: false, config: { noResponseAfterMs: 10000 } });
    const platformStartedAt = ctx.timers.now();
    const { getHandlers } = build(ctx, 'left', platformStartedAt);
    // No observation at all this launch: `connection.online` stays false and
    // `lastSuccessAt` stays null from the store's own initial state — the `?? platformStartedAt`
    // fallback is what's under test here.

    vi.setSystemTime(platformStartedAt + 10001);

    expect(() => getHandlers.get(UUID.currentState)!({} as never, undefined)).toThrow(
      expect.objectContaining({ hapStatus: ctx.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE }),
    );
  });
});

// ---------------------------------------------------------------------------------------
// isThermostatChange routing helper
// ---------------------------------------------------------------------------------------

describe('isThermostatChange', () => {
  it('is true for currentTemperatureF/targetTemperatureF/isOn side changes, false for others', () => {
    expect(isThermostatChange({ scope: 'side', field: 'currentTemperatureF', side: 'left', previous: 1, current: 2 })).toBe(true);
    expect(isThermostatChange({ scope: 'side', field: 'targetTemperatureF', side: 'left', previous: 1, current: 2 })).toBe(true);
    expect(isThermostatChange({ scope: 'side', field: 'isOn', side: 'left', previous: false, current: true })).toBe(true);
    expect(isThermostatChange({ scope: 'side', field: 'awayMode', side: 'left', previous: false, current: true })).toBe(false);
    expect(isThermostatChange({ scope: 'device', field: 'connectionOnline', previous: false, current: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// ConfiguredName seeding (release-polish tasks.md 2.1)
// ---------------------------------------------------------------------------------------

describe('ConfiguredName seeding (2.1)', () => {
  it('seeds ConfiguredName to "Thermostat" on first construction', () => {
    const { ctx, accessory, api } = setup();
    new ThermostatService(ctx, 'left', 0);
    const service = accessory.services.find((sv) => sv.UUID === api.hap.Service.Thermostat.UUID)!;
    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe(CONFIGURED_NAME.thermostat);
  });

  it('leaves an existing ConfiguredName (e.g. a controller rename) untouched on reconstruction', () => {
    const { ctx, accessory, api } = setup();
    new ThermostatService(ctx, 'left', 0);
    const service = accessory.services.find((sv) => sv.UUID === api.hap.Service.Thermostat.UUID)!;
    service.getCharacteristic(Characteristic.ConfiguredName).updateValue('Bedroom Thermostat');

    new ThermostatService(ctx, 'left', 0); // simulates a restart against the same accessory

    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Bedroom Thermostat');
  });

  it('adds ConfiguredName without emitting a characteristic-warning event', () => {
    const { ctx, accessory } = setup();
    const warnings = captureCharacteristicWarnings(accessory);
    new ThermostatService(ctx, 'left', 0);
    expect(warnings).toHaveLength(0);
  });
});
