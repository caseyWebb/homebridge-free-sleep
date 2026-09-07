/**
 * `AlarmService` (`src/services/alarm.ts`) — alarm-events tasks.md group 6.
 *
 * Mirrors `test/services/thermostat.test.ts`'s conventions: a real `WriteQueue`/`AwayModeGuard`
 * against a `FakePodClient` so a dismiss write's actual dispatched body is verified end-to-end,
 * plus a lightweight fake `ServiceContext.writeQueue` for the one test that isolates
 * `AwayModeBlockedError` mapping from `WriteQueue`'s own alarm-only bypass (writeQueue.test.ts's
 * "away-mode guard: alarm-only bypass" section covers that bypass itself).
 */
import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler, CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeBlockedError } from '../../src/pod/awayModeGuard.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore, type Change } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, type DeviceStatus, type Settings } from '../../src/pod/types.js';
import { WriteQueue, type FastPollLane } from '../../src/pod/writeQueue.js';
import { ALARM_DISMISS_SUBTYPE, ALARM_PRESS_SUBTYPE, AlarmService, isAlarmChange } from '../../src/services/alarm.js';
import type { ServiceContext } from '../../src/services/types.js';
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

/** Captures the `onGet`/`onSet` handler functions each characteristic was actually wired with —
 * mirrors thermostat.test.ts's own `build`. */
function build(
  ctx: ServiceContext,
  side: 'left' | 'right' = 'left',
  platformStartedAt = ctx.timers.now(),
): {
  service: AlarmService;
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
  const service = new AlarmService(ctx, side, platformStartedAt);
  getSpy.mockRestore();
  setSpy.mockRestore();
  return { service, getHandlers, setHandlers };
}

const UUID = {
  press: Characteristic.ProgrammableSwitchEvent.UUID,
  dismissOn: Characteristic.On.UUID,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 6.2 — the programmable switch service
// ---------------------------------------------------------------------------------------

describe('construction: the alarm-press service (tasks.md 6.2)', () => {
  it('adds exactly one StatelessProgrammableSwitch, named "<displayName> Alarm", subtype alarm-press', () => {
    const { ctx, accessory, api } = setup();
    new AlarmService(ctx, 'left', 0);

    const presses = accessory.services.filter((s) => s.UUID === api.hap.Service.StatelessProgrammableSwitch.UUID);
    expect(presses).toHaveLength(1);
    expect(presses[0]!.subtype).toBe(ALARM_PRESS_SUBTYPE);
    expect(presses[0]!.displayName).toBe(`${accessory.displayName} Alarm`);
  });

  it('ProgrammableSwitchEvent validValues are restricted to exactly [SINGLE_PRESS]', () => {
    const { ctx, api, accessory } = setup();
    new AlarmService(ctx, 'left', 0);
    const service = accessory.getServiceById(api.hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!;
    const char = service.getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent);
    expect(Array.from(char.validValuesIterator())).toEqual([api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS]);
  });

  it('has no onGet handler at all — push-only via updateValue', () => {
    const { ctx } = setup();
    const { getHandlers } = build(ctx, 'left');
    expect(getHandlers.has(UUID.press)).toBe(false);
  });

  it('restores by getServiceById rather than adding a second service', () => {
    const { ctx, accessory, api } = setup();
    new AlarmService(ctx, 'left', 0);
    new AlarmService(ctx, 'left', 0);
    expect(accessory.services.filter((s) => s.UUID === api.hap.Service.StatelessProgrammableSwitch.UUID)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// 6.3 — the dismiss switch service and its escalation predicate
// ---------------------------------------------------------------------------------------

describe('construction: the dismiss switch service (tasks.md 6.3)', () => {
  it('adds exactly one Switch, named "Dismiss Alarm", subtype alarm-dismiss', () => {
    const { ctx, accessory, api } = setup();
    new AlarmService(ctx, 'left', 0);

    const dismiss = accessory.services.filter((s) => s.UUID === api.hap.Service.Switch.UUID);
    expect(dismiss).toHaveLength(1);
    expect(dismiss[0]!.subtype).toBe(ALARM_DISMISS_SUBTYPE);
    expect(dismiss[0]!.displayName).toBe('Dismiss Alarm');
  });

  it('onGet reports the observed isAlarmVibrating value, default false when unknown', () => {
    const { ctx } = setup({ observe: false });
    const { getHandlers } = build(ctx, 'left');
    expect(getHandlers.get(UUID.dismissOn)!({} as never, undefined)).toBe(false);

    const ds = structuredClone(deviceStatusFixture);
    ds.left.isAlarmVibrating = true;
    ctx.snapshot.observeDeviceStatus(ds);
    expect(getHandlers.get(UUID.dismissOn)!({} as never, undefined)).toBe(true);
  });

  it('onGet escalates to SERVICE_COMMUNICATION_FAILURE under the same conditions as the thermostat escalation', () => {
    const { ctx } = setup({ config: { noResponseAfterMs: 1000 } });
    const hap = ctx.api.hap;
    const { getHandlers } = build(ctx, 'left', 0);

    ctx.snapshot.recordDeviceStatusFailure('network');
    vi.setSystemTime(ctx.timers.now() + 1001);

    expect(() => getHandlers.get(UUID.dismissOn)!({} as never, undefined)).toThrowError(
      expect.objectContaining({ hapStatus: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE }),
    );
  });

  it('does not escalate while the connection is online, regardless of elapsed time', () => {
    const { ctx } = setup({ config: { noResponseAfterMs: 1000 } });
    const { getHandlers } = build(ctx, 'left', 0);
    vi.setSystemTime(ctx.timers.now() + 100_000);
    expect(() => getHandlers.get(UUID.dismissOn)!({} as never, undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------
// 6.4 — handleChange: rising edge, falling edge, unchanged, bootstrap
// ---------------------------------------------------------------------------------------

function alarmChange(side: 'left' | 'right', previous: boolean | undefined, current: boolean): Change & { field: 'isAlarmVibrating' } {
  return { scope: 'side', field: 'isAlarmVibrating', side, previous, current };
}

describe('handleChange — rising edge fires a press, everything else does not (tasks.md 6.4)', () => {
  it('a rising edge (false -> true) fires exactly one SINGLE_PRESS', () => {
    const { ctx, accessory, api } = setup();
    const service = new AlarmService(ctx, 'left', 0);
    const press = accessory.getServiceById(api.hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!;
    const spy = vi.spyOn(press.getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent), 'updateValue');

    service.handleChange(alarmChange('left', false, true));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
  });

  it('the falling edge (true -> false) fires no press', () => {
    const { ctx, accessory, api } = setup();
    const service = new AlarmService(ctx, 'left', 0);
    const press = accessory.getServiceById(api.hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!;
    const spy = vi.spyOn(press.getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent), 'updateValue');

    service.handleChange(alarmChange('left', true, false));

    expect(spy).not.toHaveBeenCalled();
  });

  it('an unchanged-value report (true -> true) fires no press', () => {
    const { ctx, accessory, api } = setup();
    const service = new AlarmService(ctx, 'left', 0);
    const press = accessory.getServiceById(api.hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!;
    const spy = vi.spyOn(press.getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent), 'updateValue');

    service.handleChange(alarmChange('left', true, true));

    expect(spy).not.toHaveBeenCalled();
  });

  it('the platform bootstrap\'s first-ever observation (previous === undefined) fires no press, even when current is true', () => {
    const { ctx, accessory, api } = setup();
    const service = new AlarmService(ctx, 'left', 0);
    const press = accessory.getServiceById(api.hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!;
    const spy = vi.spyOn(press.getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent), 'updateValue');

    service.handleChange(alarmChange('left', undefined, true));

    expect(spy).not.toHaveBeenCalled();
  });

  it('every scenario also pushes the dismiss switch to the new current value when it differs', () => {
    const { ctx, accessory, api } = setup();
    const service = new AlarmService(ctx, 'left', 0);
    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;

    service.handleChange(alarmChange('left', false, true));
    expect(dismiss.getCharacteristic(api.hap.Characteristic.On).value).toBe(true);

    service.handleChange(alarmChange('left', true, false));
    expect(dismiss.getCharacteristic(api.hap.Characteristic.On).value).toBe(false);
  });

  it('isAlarmChange narrows only isAlarmVibrating side changes', () => {
    expect(isAlarmChange(alarmChange('left', false, true))).toBe(true);
    expect(isAlarmChange({ scope: 'side', field: 'isOn', side: 'left', previous: false, current: true })).toBe(false);
    expect(isAlarmChange({ scope: 'device', field: 'isPriming', previous: false, current: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 6.7 — B1: initial publish from the constructor, no press on bootstrap
// ---------------------------------------------------------------------------------------

describe('B1: initial publish seeds the dismiss switch without ever firing a press (tasks.md 6.7)', () => {
  it('constructing against a snapshot already reporting isAlarmVibrating: true seeds the switch on, with zero presses', () => {
    const { ctx, accessory, api } = setup({ observe: false });
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isAlarmVibrating = true;
    ctx.snapshot.observeDeviceStatus(ds);

    // Spy before construction — the press service (and its ProgrammableSwitchEvent
    // characteristic) does not exist yet, so this is the only way to prove nothing ever calls
    // updateValue on it during construction, rather than inferring it from a default `.value`
    // that happens to coincide with SINGLE_PRESS's own numeric value (0).
    const pressSpy = vi.spyOn(Characteristic.prototype, 'updateValue');

    new AlarmService(ctx, 'left', 0);

    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    expect(dismiss.getCharacteristic(api.hap.Characteristic.On).value).toBe(true);
    const press = accessory.getServiceById(api.hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!;
    const pressCharUuid = press.getCharacteristic(api.hap.Characteristic.ProgrammableSwitchEvent).UUID;
    expect(pressSpy.mock.instances.some((instance) => (instance as Characteristic).UUID === pressCharUuid)).toBe(false);
    pressSpy.mockRestore();
  });

  it('constructing against an unobserved snapshot seeds the switch off (default false)', () => {
    const { ctx, accessory, api } = setup({ observe: false });
    new AlarmService(ctx, 'left', 0);
    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    expect(dismiss.getCharacteristic(api.hap.Characteristic.On).value).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 6.5 / 6.6 — dismiss switch writes: off dismisses, on is accepted-and-reverted
// ---------------------------------------------------------------------------------------

describe('dismiss switch: turning it off submits an isAlarmVibrating: false write (tasks.md 6.5)', () => {
  it('submits {isAlarmVibrating: false} for this side only, and no other field', async () => {
    const { ctx, fake } = setup();
    const { setHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.dismissOn)!(false, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await pending;

    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isAlarmVibrating: false } }]);
  });

  it('turning it off while already not vibrating is harmless — same write, no error, still reports off', async () => {
    const { ctx, fake } = setup({ observe: false });
    ctx.snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture)); // left.isAlarmVibrating: false
    ctx.snapshot.observeSettings(structuredClone(settingsFixture));
    const { setHandlers, getHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.dismissOn)!(false, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBeUndefined();
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isAlarmVibrating: false } }]);
    expect(getHandlers.get(UUID.dismissOn)!({} as never, undefined)).toBe(false);
  });

  it('a non-away-mode write failure maps to SERVICE_COMMUNICATION_FAILURE', async () => {
    const { ctx, fake } = setup();
    const hap = ctx.api.hap;
    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('boom') };
    const { setHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.dismissOn)!(false, {} as never, undefined);
    const assertion = expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });
});

describe('dismiss switch: turning it on is accepted, never forwarded, and reverts (tasks.md 6.5, 6.6)', () => {
  it('an on-write never submits isAlarmVibrating: true to the Pod', async () => {
    const { ctx, fake } = setup();
    const { setHandlers } = build(ctx, 'left');

    const pending = setHandlers.get(UUID.dismissOn)!(true, {} as never, undefined);
    await expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
  });

  it('~500ms after an on-write, the switch reverts to the actual observed value — not vibrating', async () => {
    const { ctx, accessory, api } = setup();
    const { setHandlers } = build(ctx, 'left'); // fixture: left.isAlarmVibrating false
    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    const spy = vi.spyOn(dismiss.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    await setHandlers.get(UUID.dismissOn)!(true, {} as never, undefined);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(false);
  });

  it('an on-write racing a genuine alarm start never falsely reverts the switch to off (re-read, not hardcoded false)', async () => {
    const { ctx, accessory, api } = setup();
    const { setHandlers } = build(ctx, 'left');
    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    const spy = vi.spyOn(dismiss.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    await setHandlers.get(UUID.dismissOn)!(true, {} as never, undefined);
    // A genuine alarm start lands between the on-write and the revert timer firing.
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isAlarmVibrating = true;
    ctx.snapshot.observeDeviceStatus(ds);

    await vi.advanceTimersByTimeAsync(500);
    // A revert that re-reads the snapshot at fire time correctly finds the switch's own
    // already-accepted "on" claim now agrees with reality and pushes nothing further — a
    // hardcoded-`false` revert (the bug design.md warns against) would have wrongly snapped the
    // switch off despite the alarm genuinely, currently vibrating.
    expect(spy).not.toHaveBeenCalledWith(false);
  });

  it('a second on-write before the first revert fires resets the timer to exactly one pending revert', async () => {
    const { ctx, accessory, api } = setup();
    const { setHandlers } = build(ctx, 'left');
    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    const spy = vi.spyOn(dismiss.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    await setHandlers.get(UUID.dismissOn)!(true, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(300);
    await setHandlers.get(UUID.dismissOn)!(true, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(300); // 600ms since the first write, only 300ms since the second
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200); // 500ms since the second write
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------
// AwayModeBlockedError mapping, isolated from WriteQueue's own alarm-only bypass (design.md,
// "Dismiss switch mechanics"; writeQueue.test.ts's "alarm-only bypass" section covers the real
// bypass — this proves AlarmService's own onSet still maps the error correctly if it were ever
// reached, e.g. a future multi-field patch on this lane).
// ---------------------------------------------------------------------------------------

describe('onSet maps AwayModeBlockedError to NOT_ALLOWED_IN_CURRENT_STATE and schedules a revert', () => {
  it('a rejected submitSide mapped through AwayModeBlockedError throws the distinct status and reverts to the still-true observed value', async () => {
    const { ctx, accessory, api } = setup({ observe: false });
    // The side is genuinely still vibrating — the write's optimistic "off" claim (below) must be
    // corrected back to "on", proving the revert reflects reality rather than the blocked
    // write's own intended value.
    const ds = structuredClone(deviceStatusFixture);
    ds.left.isAlarmVibrating = true;
    ctx.snapshot.observeDeviceStatus(ds);
    ctx.snapshot.observeSettings(structuredClone(settingsFixture));

    const fakeWriteQueue = {
      submitSide: vi.fn().mockRejectedValue(new AwayModeBlockedError()),
    } as unknown as ServiceContext['writeQueue'];
    const isolatedCtx: ServiceContext = { ...ctx, writeQueue: fakeWriteQueue };
    const { setHandlers } = build(isolatedCtx, 'left');
    const hap = isolatedCtx.api.hap;
    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    const revertSpy = vi.spyOn(dismiss.getCharacteristic(api.hap.Characteristic.On), 'updateValue');

    const pending = setHandlers.get(UUID.dismissOn)!(false, {} as never, undefined);
    await expect(pending).rejects.toMatchObject({ hapStatus: hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE });

    await vi.advanceTimersByTimeAsync(500);
    expect(revertSpy).toHaveBeenCalledTimes(1);
    expect(revertSpy).toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------------------------------
// 6.8 — stop() clears any pending revert timer
// ---------------------------------------------------------------------------------------

describe('stop() (tasks.md 6.8)', () => {
  it('clears a pending revert timer, even with one outstanding at shutdown time', async () => {
    const { ctx, accessory, api, timers } = setup();
    const { setHandlers, service } = build(ctx, 'left');
    const dismiss = accessory.getServiceById(api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    const onChar = dismiss.getCharacteristic(api.hap.Characteristic.On);

    // An on-write schedules the accept-then-revert timer this test needs outstanding.
    await setHandlers.get(UUID.dismissOn)!(true, {} as never, undefined);
    const before = timers.pendingCount();
    expect(before).toBeGreaterThan(0);

    service.stop();
    expect(timers.pendingCount()).toBe(before - 1);

    const spy = vi.spyOn(onChar, 'updateValue');
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// 7.3 / 7.4 — both services exist for a published side and neither on the hub (platform-level
// enforcement is in test/platform.wiring.test.ts; this confirms the per-role constructor choice
// this service itself has no say in — included here only as a construction sanity check).
// ---------------------------------------------------------------------------------------

describe('both alarm services are constructed together, sharing one watched field (tasks.md 6.1)', () => {
  it('constructing once adds exactly one press service and one dismiss service', () => {
    const { ctx, accessory, api } = setup();
    new AlarmService(ctx, 'left', 0);
    expect(accessory.services.filter((s) => s.UUID === api.hap.Service.StatelessProgrammableSwitch.UUID)).toHaveLength(1);
    expect(accessory.services.filter((s) => s.UUID === api.hap.Service.Switch.UUID)).toHaveLength(1);
  });
});
