import { Characteristic } from '@homebridge/hap-nodejs';
import type { CharacteristicGetHandler, CharacteristicSetHandler } from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FreeSleepConfigSchema, type FreeSleepConfig } from '../../src/config.js';
import type { MinimalPodClient } from '../../src/platform.js';
import { AwayModeGuard } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import { DeviceStatusSchema, SchedulesSchema, ServicesSchema, SettingsSchema } from '../../src/pod/types.js';
import { WriteQueue, type FastPollLane } from '../../src/pod/writeQueue.js';
import { PRIME_SUBTYPE, PrimeService } from '../../src/services/prime.js';
import type { ServiceContext } from '../../src/services/types.js';
import { createFakePodClient, type FakePodClient } from '../fakePodClient.js';
import { FakeHomebridgeApi, FakePlatformAccessory, createFakeLogging } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const deviceStatusFixture = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const settingsFixture = SettingsSchema.parse(loadFixture('settings.json'));
const schedulesFixture = SchedulesSchema.parse(loadFixture('schedules.json'));
const servicesFixture = ServicesSchema.parse(loadFixture('services.json'));

function baseConfig(overrides: Record<string, unknown> = {}): FreeSleepConfig {
  return FreeSleepConfigSchema.parse({ host: 'pod.local', primeSwitch: true, ...overrides });
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
  const fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }> = [];
  const awayModeGuard = new AwayModeGuard({ snapshot, policy: 'mirror' });
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
    config: baseConfig(),
    podClient: fake.client as unknown as MinimalPodClient,
  };
  return { api, accessory, snapshot, timers, fake, ctx };
}

interface Handlers {
  onGet: CharacteristicGetHandler;
  onSet: CharacteristicSetHandler;
}

function buildHandlers(build: () => void): Handlers {
  let onGet!: CharacteristicGetHandler;
  let onSet!: CharacteristicSetHandler;
  const getSpy = vi.spyOn(Characteristic.prototype, 'onGet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicGetHandler,
  ) {
    onGet = handler;
    return this;
  });
  const setSpy = vi.spyOn(Characteristic.prototype, 'onSet').mockImplementation(function (
    this: Characteristic,
    handler: CharacteristicSetHandler,
  ) {
    onSet = handler;
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

describe('construction (8.2)', () => {
  it('adds exactly one Switch named "Pod Prime" with subtype prime', () => {
    const s = setup();
    new PrimeService(s.ctx);
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.subtype).toBe(PRIME_SUBTYPE);
    expect(switches[0]?.displayName).toBe('Pod Prime');
  });

  it('restores by getServiceById rather than adding a second switch', () => {
    const s = setup();
    new PrimeService(s.ctx);
    new PrimeService(s.ctx);
    const switches = s.accessory.services.filter((sv) => sv.UUID === s.api.hap.Service.Switch.UUID);
    expect(switches).toHaveLength(1);
  });
});

describe('the switch tracks the Pod\'s own priming state', () => {
  it('onGet reflects isPriming, defaulting to false when never observed', () => {
    const s = setup();
    const { onGet } = buildHandlers(() => new PrimeService(s.ctx));
    expect(onGet({} as never, undefined)).toBe(false);

    s.snapshot.observeDeviceStatus({ ...deviceStatusFixture, isPriming: true });
    expect(onGet({} as never, undefined)).toBe(true);

    s.snapshot.observeDeviceStatus({ ...deviceStatusFixture, isPriming: false });
    expect(onGet({} as never, undefined)).toBe(false);
  });

  it('refresh() pushes the current isPriming value to the characteristic', () => {
    const s = setup();
    const service = new PrimeService(s.ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, PRIME_SUBTYPE)!;
    s.snapshot.observeDeviceStatus({ ...deviceStatusFixture, isPriming: true });
    service.refresh();
    expect(hapService.getCharacteristic(s.api.hap.Characteristic.On).value).toBe(true);
  });
});

describe('turning the switch on triggers a prime request', () => {
  it('onSet(true) submits {isPriming: true} on the device lane', async () => {
    const s = setup();
    const { onSet } = buildHandlers(() => new PrimeService(s.ctx));
    const pending = onSet(true, {} as never) as Promise<void>;
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(s.fake.postDeviceStatusCalls).toEqual([{ isPriming: true }]);
  });
});

describe('turning the switch off is refused (design.md Decision 3)', () => {
  it('sends no request and rejects with a status distinct from a communication failure', async () => {
    const s = setup();
    const { onSet } = buildHandlers(() => new PrimeService(s.ctx));
    const hap = s.api.hap;

    let caught: unknown;
    try {
      await onSet(false, {} as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(hap.HapStatusError);
    expect((caught as InstanceType<typeof hap.HapStatusError>).hapStatus).toBe(
      hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
    );
    expect((caught as InstanceType<typeof hap.HapStatusError>).hapStatus).not.toBe(
      hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(s.fake.postDeviceStatusCalls).toHaveLength(0);
  });

  it('schedules a corrective refresh ~500ms after a refused write, with no further characteristic write from any controller', async () => {
    const s = setup();
    s.snapshot.observeDeviceStatus({ ...deviceStatusFixture, isPriming: true });
    const service = new PrimeService(s.ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, PRIME_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);
    const refreshSpy = vi.spyOn(service, 'refresh');

    // `handleSetRequest` is HAP's own real entry point — the same one a controller's write goes
    // through — and already carries the `onSet` handler wired during construction above. HAP
    // itself never mutates `.value` on a rejected write (`Characteristic.handleSetRequest` only
    // assigns `this.value` on the success path) — the corrective timer's job is to re-affirm the
    // Pod's actual last-observed state via its own explicit push, not to undo a local mutation
    // that never happened here.
    const pending = onChar.handleSetRequest(false);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).rejects.toBe(s.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(refreshSpy).not.toHaveBeenCalled(); // not yet — only after the ~500ms delay

    await vi.advanceTimersByTimeAsync(500);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(onChar.value).toBe(true); // the Pod's actual last-observed priming state
  });
});

describe('stop() clears the pending revert timer', () => {
  it('leaves no pending timer after a refused write followed by stop()', async () => {
    const s = setup();
    const service = new PrimeService(s.ctx);
    const hapService = s.accessory.getServiceById(s.api.hap.Service.Switch, PRIME_SUBTYPE)!;
    const onChar = hapService.getCharacteristic(s.api.hap.Characteristic.On);

    const before = s.timers.pendingCount();
    const pending = onChar.handleSetRequest(false);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.timers.pendingCount()).toBeGreaterThan(before);

    service.stop();
    expect(s.timers.pendingCount()).toBe(before);
  });
});
