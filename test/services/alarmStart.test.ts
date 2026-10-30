/**
 * `alarm-switch-start`: with `alarmSwitchStartsAlarm` on, the dismiss switch's ON write starts
 * the configured alarm, the tile reads on until the Pod is seen to stop (or the alarm's own
 * duration elapses with nothing observed), and the OFF write still dismisses.
 */
import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler, CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore, type Change } from '../../src/pod/snapshot.js';
import {
  DeviceStatusSchema,
  SchedulesSchema,
  ServicesSchema,
  SettingsSchema,
  type AlarmRequest,
  type Side,
} from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { ALARM_DISMISS_SUBTYPE, AlarmService, isAlarmChange } from '../../src/services/alarm.js';
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
  return FreeSleepConfigSchema.parse({ host: 'pod.local', alarmSwitchStartsAlarm: true, ...overrides });
}

interface Setup {
  api: FakeHomebridgeApi;
  accessory: FakePlatformAccessory;
  snapshot: SnapshotStore;
  timers: TimerHarness;
  fake: FakePodClient;
  ctx: ServiceContext;
  pollRequests: number[];
  pollReleases: number;
  warnings: string[];
}

function setup(options: { config?: Record<string, unknown>; withPoll?: boolean } = {}): Setup {
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const warnings: string[] = [];
  const originalWarn = log.warn;
  log.warn = ((message: string, ...rest: unknown[]) => {
    warnings.push(message);
    return originalWarn.call(log, message, ...rest);
  }) as typeof log.warn;
  const accessory = new api.platformAccessory('Right', api.hap.uuid.generate('right'), api.hap.Categories.THERMOSTAT);
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
  const config = baseConfig(options.config);
  const awayModeGuard = new AwayModeGuard({ snapshot, policy: config.awayModeWritePolicy });
  const writeQueue = new WriteQueue({ client: fake.client, snapshot, requestFastPoll: () => {}, awayModeGuard, timers });
  const pollRequests: number[] = [];
  const result: Setup = {
    api,
    accessory,
    snapshot,
    timers,
    fake,
    pollRequests,
    pollReleases: 0,
    warnings,
    ctx: {
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
      ...(options.withPoll === false
        ? {}
        : {
            requestAlarmPoll: (untilMs: number) => {
              pollRequests.push(untilMs);
              return () => {
                result.pollReleases += 1;
              };
            },
          }),
    },
  };
  return result;
}

/** Wires the platform's own change routing: snapshot changes on isAlarmVibrating reach
 * `handleChange`, exactly as `FreeSleepPlatform.handleSnapshotChanges` does. */
function route(snapshot: SnapshotStore, service: AlarmService): void {
  snapshot.subscribe((changes: readonly Change[]) => {
    for (const change of changes) if (isAlarmChange(change)) service.handleChange(change);
  });
}

function build(ctx: ServiceContext, side: Side): {
  service: AlarmService;
  onGet: CharacteristicGetHandler;
  onSet: CharacteristicSetHandler;
  presses: number;
  pressSpy: () => number;
} {
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
  const service = new AlarmService(ctx, side, ctx.timers.now());
  getSpy.mockRestore();
  setSpy.mockRestore();
  route(ctx.snapshot, service);
  const press = ctx.accessory.services
    .find((sv) => sv.UUID === ctx.api.hap.Service.StatelessProgrammableSwitch.UUID)!
    .getCharacteristic(ctx.api.hap.Characteristic.ProgrammableSwitchEvent);
  let presses = 0;
  const originalUpdate = press.updateValue.bind(press);
  press.updateValue = ((value: unknown) => {
    presses += 1;
    return originalUpdate(value as never);
  }) as typeof press.updateValue;
  return { service, onGet, onSet, presses, pressSpy: () => presses };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(SIDES)('ON write with alarmSwitchStartsAlarm (%s)', (side) => {
  it('posts the configured alarm for this side only, with force: true, and the tile reads on at once', async () => {
    const s = setup();
    const { onGet, onSet, pressSpy } = build(s.ctx, side);
    expect(onGet(undefined)).toBe(false);

    await onSet(true, {} as never, undefined);
    const expected: AlarmRequest = { side, duration: 180, vibrationIntensity: 100, vibrationPattern: 'double', force: true };
    expect(s.fake.postAlarmCalls).toEqual([expected]);
    expect(onGet(undefined)).toBe(true);
    // Starting the alarm is a rising edge: the alarm-press event fires once.
    expect(pressSpy()).toBe(1);
    // Nothing was written to /api/deviceStatus — ON is a start, never an `isAlarmVibrating: true`.
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.fake.postDeviceStatusCalls).toHaveLength(0);
  });

  it('uses the configured alarmSwitchAlarm parameters', async () => {
    const s = setup({ config: { alarmSwitchAlarm: { duration: 45, vibrationIntensity: 30, vibrationPattern: 'rise' } } });
    const { onSet } = build(s.ctx, side);
    await onSet(true, {} as never, undefined);
    expect(s.fake.postAlarmCalls[0]).toMatchObject({ side, duration: 45, vibrationIntensity: 30, vibrationPattern: 'rise' });
  });

  it('requests a fast-poll window covering the alarm plus a tail, and releases it on stop()', async () => {
    const s = setup({ config: { alarmSwitchAlarm: { duration: 60 } } });
    const { service, onSet } = build(s.ctx, side);
    const t0 = s.timers.now();
    await onSet(true, {} as never, undefined);
    expect(s.pollRequests).toEqual([t0 + 60_000 + 30_000]);
    service.stop();
    expect(s.pollReleases).toBe(1);
  });

  it('a duration below upstream\'s 10s floor is held on for the real 10s, not the nominal duration', async () => {
    const s = setup({ config: { alarmSwitchAlarm: { duration: 1 } } });
    const { onGet, onSet } = build(s.ctx, side);
    await onSet(true, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(onGet(undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(onGet(undefined)).toBe(false);
  });

  it('with nothing ever observed from the Pod, the tile turns itself off when the alarm would have ended', async () => {
    const s = setup();
    const { onGet, onSet } = build(s.ctx, side);
    await onSet(true, {} as never, undefined);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(onGet(undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(onGet(undefined)).toBe(false);
  });

  it('once a poll confirms the vibration, the tile follows the Pod: still on past the nominal end, off when the Pod reports off', async () => {
    const s = setup();
    const { onGet, onSet, pressSpy } = build(s.ctx, side);
    await onSet(true, {} as never, undefined);

    const ringing = structuredClone(deviceStatusFixture);
    ringing[side].isAlarmVibrating = true;
    await vi.advanceTimersByTimeAsync(3000);
    s.snapshot.observeDeviceStatus(ringing); // raw agrees -> start overlay retires silently
    expect(onGet(undefined)).toBe(true);
    expect(pressSpy()).toBe(1); // no second press for the confirming observation

    await vi.advanceTimersByTimeAsync(200_000); // well past the 180s nominal end
    expect(onGet(undefined)).toBe(true); // raw is authoritative now

    const stopped = structuredClone(deviceStatusFixture);
    stopped[side].isAlarmVibrating = false;
    s.snapshot.observeDeviceStatus(stopped);
    expect(onGet(undefined)).toBe(false);
  });

  it('an OFF write after a start submits the usual dismiss, and the tile reads off immediately', async () => {
    const s = setup();
    const { onGet, onSet } = build(s.ctx, side);
    await onSet(true, {} as never, undefined);
    expect(onGet(undefined)).toBe(true);

    const pending = onSet(false, {} as never, undefined);
    expect(onGet(undefined)).toBe(false); // the dismiss overlay supersedes the start overlay
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(s.fake.postDeviceStatusCalls).toEqual([{ [side]: { isAlarmVibrating: false } }]);
  });

  it('a rejected postAlarm surfaces as SERVICE_COMMUNICATION_FAILURE, warns, and the tile reverts to off', async () => {
    const s = setup();
    s.fake.postAlarmOutcome = { kind: 'error', error: new Error('unreachable') };
    const { onGet, onSet, pressSpy } = build(s.ctx, side);
    const hap = s.api.hap;
    await expect(onSet(true, {} as never, undefined)).rejects.toMatchObject({
      hapStatus: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    });
    expect(s.warnings.some((w) => w.includes('alarm start failed'))).toBe(true);
    expect(pressSpy()).toBe(0);
    expect(s.pollRequests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(onGet(undefined)).toBe(false);
  });

  it('works without a requestAlarmPoll in the context (no fast poll, same tile behaviour)', async () => {
    const s = setup({ withPoll: false });
    const { onGet, onSet } = build(s.ctx, side);
    await onSet(true, {} as never, undefined);
    expect(onGet(undefined)).toBe(true);
    expect(s.pollRequests).toHaveLength(0);
  });

  it('stop() clears the start overlay\'s expiry timer', async () => {
    const s = setup({ withPoll: false });
    const { service, onSet } = build(s.ctx, side);
    const before = s.timers.pendingCount();
    await onSet(true, {} as never, undefined);
    expect(s.timers.pendingCount()).toBe(before + 1);
    service.stop();
    expect(s.timers.pendingCount()).toBe(before);
  });
});

describe('with alarmSwitchStartsAlarm off (the default), ON is still accepted-and-reverted, never sent', () => {
  it('posts no alarm and reverts after ~500ms', async () => {
    const s = setup({ config: { alarmSwitchStartsAlarm: false } });
    const { onGet, onSet } = build(s.ctx, 'right');
    await onSet(true, {} as never, undefined);
    expect(s.fake.postAlarmCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(onGet(undefined)).toBe(false);
    expect(s.pollRequests).toHaveLength(0);
  });
});

describe('the dismiss switch keeps its subtype and identity either way', () => {
  it('is the same alarm-dismiss Switch, not a new service', () => {
    const s = setup();
    build(s.ctx, 'right');
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(ALARM_DISMISS_SUBTYPE);
  });
});

describe('alarmPressEvent: false hides the button (hide-alarm-press)', () => {
  it('constructs no StatelessProgrammableSwitch, fires no press on a start, and the dismiss switch still works', async () => {
    const s = setup({ config: { alarmPressEvent: false } });
    // `build` looks the press service up to count presses; it does not exist here, so wire by hand.
    const service = new AlarmService(s.ctx, 'right', s.timers.now());
    route(s.snapshot, service);
    const presses = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.StatelessProgrammableSwitch.UUID);
    expect(presses).toHaveLength(0);
    const dismiss = s.accessory.getServiceById(s.api.hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!;
    expect(dismiss).toBeDefined();
    const on = dismiss.getCharacteristic(s.api.hap.Characteristic.On);

    const pending = on.handleSetRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(s.fake.postAlarmCalls).toHaveLength(1);
    expect(await on.handleGetRequest()).toBe(true);

    // A genuine observed rising edge later also fires nothing — there is no service to fire on.
    const ringing = structuredClone(deviceStatusFixture);
    ringing.right.isAlarmVibrating = true;
    expect(() => s.snapshot.observeDeviceStatus(ringing)).not.toThrow();
    service.stop();
  });
});
