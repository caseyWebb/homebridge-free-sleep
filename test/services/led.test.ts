import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler, CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SchedulesSchema, ServicesSchema, SettingsSchema } from '../../src/pod/types.js';
import { WriteQueue } from '../../src/pod/writeQueue.js';
import { LED_SUBTYPE, LedService } from '../../src/services/led.js';
import { CONFIGURED_NAME } from '../../src/services/serviceName.js';
import type { ServiceContext } from '../../src/services/types.js';
import { captureCharacteristicWarnings } from './configuredNameHelpers.js';
import { createFakePodClient, type FakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture = SchedulesSchema.parse(loadFixture('schedules.json'));
const servicesFixture = ServicesSchema.parse(loadFixture('services.json'));

function baseConfig(overrides: Record<string, unknown> = {}): FreeSleepConfig {
  return FreeSleepConfigSchema.parse({ host: 'pod.local', ledLightbulb: true, ...overrides });
}

interface Setup {
  api: FakeHomebridgeApi;
  accessory: FakePlatformAccessory;
  snapshot: SnapshotStore;
  timers: TimerHarness;
  fake: FakePodClient;
  ctx: ServiceContext;
}

function setup(): Setup {
  const api = new FakeHomebridgeApi();
  const accessory = new api.platformAccessory('Pod', api.hap.uuid.generate('hub'), api.hap.Categories.OTHER);
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  const log = createFakeLogging();
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
    config: baseConfig(),
    podClient: fake.client as unknown as MinimalPodClient,
  };
  return { api, accessory, snapshot, timers, fake, ctx };
}

interface Handlers {
  onGet: CharacteristicGetHandler;
  onSet: CharacteristicSetHandler;
}

function buildHandlersFor(uuid: string, build: () => void): Handlers {
  let onGet!: CharacteristicGetHandler;
  let onSet!: CharacteristicSetHandler;
  const getSpy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicGetHandler,
  ) {
    if (this.UUID === uuid) onGet = handler;
    return this;
  });
  const setSpy = vi.spyOn(Characteristic.prototype, 'onSet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicSetHandler,
  ) {
    if (this.UUID === uuid) onSet = handler;
    return this;
  });
  build();
  getSpy.mockRestore();
  setSpy.mockRestore();
  return { onGet, onSet };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('construction (8.3)', () => {
  it('adds exactly one Lightbulb named "Pod LED" with subtype led, carrying On and Brightness', () => {
    const s = setup();
    new LedService(s.ctx);
    const bulbs = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Lightbulb.UUID);
    expect(bulbs).toHaveLength(1);
    expect(bulbs[0]?.subtype).toBe(LED_SUBTYPE);
    const uuids = bulbs[0]!.characteristics.map((c) => c.UUID);
    expect(uuids).toEqual(
      expect.arrayContaining([s.api.hap.Characteristic.On.UUID, s.api.hap.Characteristic.Brightness.UUID]),
    );
  });
});

describe('a brightness write carries every other device setting unchanged', () => {
  it('submits the new brightness together with the currently-observed v/gainLeft/gainRight, none of them altered', async () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({
      ...deviceStatusFixture,
      settings: { v: 3, gainLeft: 411, gainRight: 412, ledBrightness: 20 },
    });
    const { onSet } = buildHandlersFor(s.api.hap.Characteristic.Brightness.UUID, () => new LedService(s.ctx));
    const pending = onSet(55, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(s.fake.postDeviceStatusCalls).toEqual([
      { settings: { v: 3, gainLeft: 411, gainRight: 412, ledBrightness: 55 } },
    ]);
  });
});

describe('turning on with no brightness restores the last nonzero value', () => {
  it('uses accessory.context.lastNonZeroBrightness once a nonzero brightness has been written', async () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({
      ...deviceStatusFixture,
      settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 0 },
    });
    const handlers = buildHandlersFor(s.api.hap.Characteristic.Brightness.UUID, () => new LedService(s.ctx));

    // Write a nonzero brightness first.
    const p1 = handlers.onSet(75, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await p1;
    expect(s.fake.postDeviceStatusCalls[0]).toEqual({ settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 75 } });
  });

  it('defaults to full brightness the first time On is set true with no prior brightness ever written', async () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({
      ...deviceStatusFixture,
      settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 0 },
    });
    const { onSet } = buildHandlersFor(s.api.hap.Characteristic.On.UUID, () => new LedService(s.ctx));
    const pending = onSet(true, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(s.fake.postDeviceStatusCalls).toEqual([{ settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 100 } }]);
  });

  it('restores the most recent nonzero brightness this plugin itself wrote, after On is set true with no accompanying Brightness', async () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({
      ...deviceStatusFixture,
      settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 0 },
    });
    let onSetOn!: CharacteristicSetHandler;
    let onSetBrightness!: CharacteristicSetHandler;
    const getSpy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (this: Characteristic) {
      return this;
    });
    const setSpy = vi.spyOn(Characteristic.prototype, 'onSet').mockImplementation(function (
      this: Characteristic,
      handler: CharacteristicSetHandler,
    ) {
      if (this.UUID === s.api.hap.Characteristic.On.UUID) onSetOn = handler;
      if (this.UUID === s.api.hap.Characteristic.Brightness.UUID) onSetBrightness = handler;
      return this;
    });
    new LedService(s.ctx);
    getSpy.mockRestore();
    setSpy.mockRestore();

    // First: an explicit nonzero brightness write.
    const p1 = onSetBrightness(42, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await p1;
    expect(s.fake.postDeviceStatusCalls[0]).toEqual({ settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 42 } });

    // Then: turn on with no brightness accompanying the write — restores 42, not 100.
    const p2 = onSetOn(true, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await p2;
    expect(s.fake.postDeviceStatusCalls[1]).toEqual({ settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 42 } });
  });
});

describe('turning off zeroes the brightness', () => {
  it('On set to false submits ledBrightness: 0', async () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({
      ...deviceStatusFixture,
      settings: { v: 2, gainLeft: 5, gainRight: 6, ledBrightness: 80 },
    });
    const { onSet } = buildHandlersFor(s.api.hap.Characteristic.On.UUID, () => new LedService(s.ctx));
    const pending = onSet(false, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(s.fake.postDeviceStatusCalls).toEqual([{ settings: { v: 2, gainLeft: 5, gainRight: 6, ledBrightness: 0 } }]);
  });
});

describe('an off-write seeds lastNonZeroBrightness from the observed brightness, not this plugin\'s own last write (N3 fix)', () => {
  it('external 30 -> HomeKit off -> on posts 30, not the plugin-write default of 100', async () => {
    const s = setup();
    // Simulates an externally-set brightness (e.g. free-sleep's own web UI) that this plugin
    // itself never wrote — `lastNonZeroBrightness` has never been touched by a write handler.
    s.snapshot.observeDeviceStatus({
      ...deviceStatusFixture,
      settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 30 },
    });
    let onSetOn!: CharacteristicSetHandler;
    const getSpy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (this: Characteristic) {
      return this;
    });
    const setSpy = vi.spyOn(Characteristic.prototype, 'onSet').mockImplementation(function (
      this: Characteristic,
      handler: CharacteristicSetHandler,
    ) {
      if (this.UUID === s.api.hap.Characteristic.On.UUID) onSetOn = handler;
      return this;
    });
    new LedService(s.ctx);
    getSpy.mockRestore();
    setSpy.mockRestore();

    // Off write: seeds lastNonZeroBrightness from the observed 30 before zeroing.
    const pOff = onSetOn(false, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await pOff;
    expect(s.fake.postDeviceStatusCalls[0]).toEqual({ settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 0 } });

    // On write with no accompanying Brightness: restores 30 (the Pod's actual prior level), not 100.
    const pOn = onSetOn(true, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await pOn;
    expect(s.fake.postDeviceStatusCalls[1]).toEqual({ settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 30 } });
  });
});

describe('refuses a write when no deviceStatus has ever been observed yet', () => {
  it('rejects with SERVICE_COMMUNICATION_FAILURE and sends no request', async () => {
    const s = setup(); // no observeDeviceStatus call at all
    const { onSet } = buildHandlersFor(s.api.hap.Characteristic.Brightness.UUID, () => new LedService(s.ctx));
    const hap = s.api.hap;
    let caught: unknown;
    try {
      await onSet(50, {} as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(hap.HapStatusError);
    expect((caught as InstanceType<typeof hap.HapStatusError>).hapStatus).toBe(
      hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    expect(s.fake.postDeviceStatusCalls).toHaveLength(0);
  });
});

describe('reads', () => {
  it('onGet for Brightness/On reflect the currently-observed settings.ledBrightness', () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({
      ...deviceStatusFixture,
      settings: { v: 1, gainLeft: 1, gainRight: 1, ledBrightness: 33 },
    });
    let onGetOn!: CharacteristicGetHandler;
    let onGetBrightness!: CharacteristicGetHandler;
    const spy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (
      this: Characteristic,
      handler: CharacteristicGetHandler,
    ) {
      if (this.UUID === s.api.hap.Characteristic.On.UUID) onGetOn = handler;
      if (this.UUID === s.api.hap.Characteristic.Brightness.UUID) onGetBrightness = handler;
      return this;
    });
    new LedService(s.ctx);
    spy.mockRestore();

    expect(onGetBrightness({} as never, undefined)).toBe(33);
    expect(onGetOn({} as never, undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// ConfiguredName seeding (release-polish tasks.md 2.7)
// ---------------------------------------------------------------------------------------

describe('ConfiguredName seeding (2.7)', () => {
  it('seeds ConfiguredName to "LED" on first construction', () => {
    const s = setup();
    new LedService(s.ctx);
    const service = s.accessory.getServiceById(s.api.hap.Service.Lightbulb, LED_SUBTYPE)!;
    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe(CONFIGURED_NAME.led);
  });

  it('leaves an existing ConfiguredName (e.g. a controller rename) untouched on reconstruction', () => {
    const s = setup();
    new LedService(s.ctx);
    const service = s.accessory.getServiceById(s.api.hap.Service.Lightbulb, LED_SUBTYPE)!;
    service.getCharacteristic(Characteristic.ConfiguredName).updateValue('Bedroom LED');

    new LedService(s.ctx); // simulates a restart against the same accessory

    expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Bedroom LED');
  });

  it('adds ConfiguredName without emitting a characteristic-warning event', () => {
    const s = setup();
    const warnings = captureCharacteristicWarnings(s.accessory);
    new LedService(s.ctx);
    expect(warnings).toHaveLength(0);
  });
});
