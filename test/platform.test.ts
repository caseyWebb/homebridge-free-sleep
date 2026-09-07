import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { Categories } from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import {
  categoryFor,
  FreeSleepPlatform,
  serialNumberFor,
  seed,
  SETTINGS_READ_TIMEOUT_MS,
  uuidFor,
  type MinimalPodClient,
  type Role,
} from '../src/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';
import {
  DeviceStatusSchema,
  SchedulesSchema,
  ServerStatusSchema,
  ServicesSchema,
  SettingsSchema,
  type DeviceStatus,
  type Schedules,
  type ServerStatus,
  type Services as PodServices,
  type Settings,
} from '../src/pod/types.js';
import {
  createFakeLogging,
  FakeHomebridgeApi,
  FakePlatformAccessory,
  simulateRestart,
  type PlatformFactory,
} from './fakeHomebridgeApi.js';
import { loadFixture } from './loadFixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

const fixtureSettings: Settings = SettingsSchema.parse(loadFixture('settings.json'));
const fixtureDeviceStatus: DeviceStatus = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const fixtureSchedules: Schedules = SchedulesSchema.parse(loadFixture('schedules.json'));
const fixtureServices: PodServices = ServicesSchema.parse(loadFixture('services.json'));
const fixtureServerStatus: ServerStatus = ServerStatusSchema.parse(loadFixture('serverStatus.json'));

function baseConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return { platform: PLATFORM_NAME, host: 'pod.local', ...overrides };
}

/**
 * A `PodClient` stand-in every method of which never settles — used only with vitest fake
 * timers, so both the settings-name-seeding budget and the poller's `bootstrapTimeoutMs`
 * (which shares the same, vi-patched, default `TimerApi`) resolve under `vi.advanceTimersByTimeAsync`
 * rather than hanging real time.
 */
function neverResolvingPodClient(): MinimalPodClient {
  return {
    getDeviceStatus: () => new Promise<DeviceStatus>(() => {}),
    getSettings: () => new Promise<Settings>(() => {}),
    getSchedules: () => new Promise<Schedules>(() => {}),
    getServices: () => new Promise<PodServices>(() => {}),
    getServerStatus: () => new Promise<ServerStatus>(() => {}),
    postDeviceStatus: () => new Promise<void>(() => {}),
    postSettings: () => new Promise<void>(() => {}),
    postAlarm: () => new Promise<void>(() => {}),
  };
}

function resolvingPodClient(settings: Settings = fixtureSettings): MinimalPodClient & { calls: number } {
  const client = {
    calls: 0,
    getDeviceStatus: () => Promise.resolve(structuredClone(fixtureDeviceStatus)),
    getSettings: () => {
      client.calls += 1;
      return Promise.resolve(settings);
    },
    getSchedules: () => Promise.resolve(structuredClone(fixtureSchedules)),
    getServices: () => Promise.resolve(structuredClone(fixtureServices)),
    getServerStatus: () => Promise.resolve(structuredClone(fixtureServerStatus)),
    postDeviceStatus: () => Promise.resolve(),
    postSettings: () => Promise.resolve(),
    postAlarm: () => Promise.resolve(),
  };
  return client;
}

/** Every method rejects, quickly — the poller's bootstrap settles fast rather than hanging out
 * `bootstrapTimeoutMs` in tests that don't drive fake timers. */
function rejectingPodClient(message = 'Pod unreachable'): MinimalPodClient {
  const reject = () => Promise.reject(new Error(message));
  return {
    getDeviceStatus: reject,
    getSettings: reject,
    getSchedules: reject,
    getServices: reject,
    getServerStatus: reject,
    postDeviceStatus: reject,
    postSettings: reject,
    postAlarm: reject,
  };
}

/** Builds a `FreeSleepPlatform` factory closing over an injected fake `MinimalPodClient`. */
function factoryWithPodClient(podClient?: MinimalPodClient): PlatformFactory<FreeSleepPlatform> {
  return (log: Logging, config: PlatformConfig, api: API) => new FreeSleepPlatform(log, config, api, podClient);
}

function roleOf(displayName: string): Role {
  if (displayName === 'Pod') return 'hub';
  return displayName === 'Pod Left' ? 'left' : 'right';
}

function existingAccessory(api: FakeHomebridgeApi, host: string, role: Role): FakePlatformAccessory {
  const name = role === 'hub' ? 'Pod' : role === 'left' ? 'Pod Left' : 'Pod Right';
  return new api.platformAccessory(name, uuidFor(api.hap, host, role), categoryFor(api.hap, role));
}

/** `createFakeLogging` stashes every logged line on a non-`Logging`-typed `.lines` property. */
function logLines(log: Logging): Array<{ level: string; message: string }> {
  return (log as unknown as { lines: Array<{ level: string; message: string }> }).lines;
}

// ---------------------------------------------------------------------------------------
// 4. Accessory identity
// ---------------------------------------------------------------------------------------

describe('accessory identity', () => {
  it('the same host+role always yields the same UUID and SerialNumber', () => {
    const api = new FakeHomebridgeApi();
    expect(uuidFor(api.hap, 'pod.local', 'left')).toBe(uuidFor(api.hap, 'pod.local', 'left'));
    expect(serialNumberFor('pod.local', 'left')).toBe(serialNumberFor('pod.local', 'left'));
  });

  it('different roles for the same host yield different UUIDs', () => {
    const api = new FakeHomebridgeApi();
    const left = uuidFor(api.hap, 'pod.local', 'left');
    const right = uuidFor(api.hap, 'pod.local', 'right');
    const hub = uuidFor(api.hap, 'pod.local', 'hub');
    expect(new Set([left, right, hub]).size).toBe(3);
  });

  it('different hosts for the same role yield different UUIDs and SerialNumbers', () => {
    const api = new FakeHomebridgeApi();
    expect(uuidFor(api.hap, 'pod-a.local', 'left')).not.toBe(uuidFor(api.hap, 'pod-b.local', 'left'));
    expect(serialNumberFor('pod-a.local', 'left')).not.toBe(serialNumberFor('pod-b.local', 'left'));
  });

  it('seed is prefixed with PLUGIN_NAME, not PLATFORM_NAME', () => {
    expect(seed('pod.local', 'left')).toBe(`${PLUGIN_NAME}:pod.local:left`);
  });

  it('serialNumber is host:role, human readable', () => {
    expect(serialNumberFor('192.168.1.50', 'right')).toBe('192.168.1.50:right');
  });
});

describe('AccessoryInformation and Categories', () => {
  it('sets Manufacturer/Model/SerialNumber/FirmwareRevision on every newly-created accessory', async () => {
    const { api } = await simulateRestart(factoryWithPodClient(rejectingPodClient()), baseConfig(), []);
    const hap = api.hap;

    expect(api.registeredAccessories).toHaveLength(3);
    for (const accessory of api.registeredAccessories) {
      const role = roleOf(accessory.displayName);
      const info = accessory.getService(hap.Service.AccessoryInformation);
      expect(info).toBeDefined();
      expect(info?.getCharacteristic(hap.Characteristic.Manufacturer).value).toBe('Eight Sleep');
      expect(info?.getCharacteristic(hap.Characteristic.SerialNumber).value).toBe(`pod.local:${role}`);
      expect(info?.getCharacteristic(hap.Characteristic.FirmwareRevision).value).toBe(packageJson.version);
      expect(info?.getCharacteristic(hap.Characteristic.Model).value).toBe(role === 'hub' ? 'Pod Hub' : 'Pod');
    }
  });

  it('sets Categories.THERMOSTAT for side accessories and Categories.OTHER for the hub', async () => {
    const { api } = await simulateRestart(factoryWithPodClient(rejectingPodClient()), baseConfig(), []);
    const hap = api.hap;

    const left = api.registeredAccessories.find((a) => a.displayName === 'Pod Left');
    const right = api.registeredAccessories.find((a) => a.displayName === 'Pod Right');
    const hub = api.registeredAccessories.find((a) => a.displayName === 'Pod');

    expect(left?.category).toBe(hap.Categories.THERMOSTAT);
    expect(right?.category).toBe(hap.Categories.THERMOSTAT);
    expect(hub?.category).toBe(hap.Categories.OTHER);
  });
});

// ---------------------------------------------------------------------------------------
// 5. Platform lifecycle
// ---------------------------------------------------------------------------------------

describe('bail-without-host', () => {
  it('constructing without host registers zero listeners and calls no register/unregister spy', async () => {
    const api = new FakeHomebridgeApi();
    const log = createFakeLogging();
    const cached = existingAccessory(api, 'pod.local', 'left');

    const platform = new FreeSleepPlatform(log, { platform: PLATFORM_NAME }, api.asApi());
    platform.configureAccessory(cached as unknown as PlatformAccessory);

    expect(api.didFinishLaunchingListenerCount).toBe(0);

    await api.fireDidFinishLaunching();

    expect(api.registerPlatformAccessoriesCalls).toHaveLength(0);
    expect(api.unregisterPlatformAccessoriesCalls).toHaveLength(0);
    expect(api.updatePlatformAccessoriesCalls).toHaveLength(0);
  });
});

describe('configureAccessory', () => {
  it('makes a cached accessory retrievable by the internal lookup before didFinishLaunching fires', () => {
    const api = new FakeHomebridgeApi();
    const log = createFakeLogging();
    const platform = new FreeSleepPlatform(log, baseConfig(), api.asApi());
    const accessory = existingAccessory(api, 'pod.local', 'left');

    platform.configureAccessory(accessory as unknown as PlatformAccessory);

    const internal = platform as unknown as { cachedByUuid: Map<string, unknown> };
    expect(internal.cachedByUuid.get(accessory.UUID)).toBe(accessory);
  });
});

describe('fresh install, sides: both', () => {
  it('registers exactly three accessories, named Pod Left/Pod Right/Pod, each with AccessoryInformation plus its role-enabled service(s)', async () => {
    const { api } = await simulateRestart(factoryWithPodClient(rejectingPodClient()), baseConfig(), []);

    expect(api.registeredAccessories).toHaveLength(3);
    const names = api.registeredAccessories.map((a) => a.displayName).sort();
    expect(names).toEqual(['Pod', 'Pod Left', 'Pod Right']);

    for (const accessory of api.registeredAccessories) {
      const nonInfoServices = accessory.services.filter(
        (s) => s.UUID !== api.hap.Service.AccessoryInformation.UUID,
      );
      if (accessory.displayName === 'Pod') {
        // hub-accessory: the hub always carries the connection sensor and the water-low sensor
        // (default `waterLowSensorType: 'contact'`) — both `ContactSensor`, distinguished by
        // subtype — with the other four hub services disabled by default.
        expect(nonInfoServices).toHaveLength(2);
        for (const service of nonInfoServices) {
          expect(service.UUID).toBe(api.hap.Service.ContactSensor.UUID);
        }
        expect(new Set(nonInfoServices.map((s) => s.subtype))).toEqual(new Set(['connection', 'waterLow']));
      } else {
        expect(nonInfoServices).toHaveLength(1);
        expect(nonInfoServices[0]?.UUID).toBe(api.hap.Service.Thermostat.UUID);
      }
    }
  });
});

describe('restart without duplication', () => {
  it('with all three accessories already cached, registers and unregisters nothing', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );
    const previousUuids = new Set(previous.map((a) => a.UUID));

    const { api, platform } = await simulateRestart(
      factoryWithPodClient(resolvingPodClient()),
      baseConfig(),
      previous,
    );

    expect(api.registerPlatformAccessoriesCalls).toHaveLength(0);
    expect(api.unregisterPlatformAccessoriesCalls).toHaveLength(0);

    const internal = platform as unknown as { cachedByUuid: Map<string, unknown> };
    expect(new Set(internal.cachedByUuid.keys())).toEqual(previousUuids);
  });
});

describe('prune-on-restore', () => {
  it('removes a synthetic extra service while leaving AccessoryInformation and other services untouched', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );
    const leftAccessory = previous.find((a) => a.displayName === 'Pod Left')!;

    const extraService = new seedApi.hap.Service.ContactSensor('Synthetic Extra', 'synthetic-subtype');
    leftAccessory.addService(extraService);
    expect(
      leftAccessory.services.some((s) => s.UUID === extraService.UUID && s.subtype === 'synthetic-subtype'),
    ).toBe(true);

    const { api } = await simulateRestart(factoryWithPodClient(resolvingPodClient()), baseConfig(), previous);
    void api;

    expect(
      leftAccessory.services.some((s) => s.UUID === extraService.UUID && s.subtype === 'synthetic-subtype'),
    ).toBe(false);
    expect(leftAccessory.services.some((s) => s.UUID === seedApi.hap.Service.AccessoryInformation.UUID)).toBe(
      true,
    );
  });
});

describe('sides filter', () => {
  it("sides: 'left' on a fresh install registers only Pod Left + Pod", async () => {
    const { api } = await simulateRestart(
      factoryWithPodClient(rejectingPodClient()),
      baseConfig({ sides: 'left' }),
      [],
    );

    const names = api.registeredAccessories.map((a) => a.displayName).sort();
    expect(names).toEqual(['Pod', 'Pod Left']);
  });

  it("sides: 'right' on a fresh install registers only Pod Right + Pod", async () => {
    const { api } = await simulateRestart(
      factoryWithPodClient(rejectingPodClient()),
      baseConfig({ sides: 'right' }),
      [],
    );

    const names = api.registeredAccessories.map((a) => a.displayName).sort();
    expect(names).toEqual(['Pod', 'Pod Right']);
  });

  it('narrowing both -> left unregisters exactly Pod Right, and stays quiet on a further restart', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );
    const rightAccessory = previous.find((a) => a.displayName === 'Pod Right')!;

    const first = await simulateRestart(
      factoryWithPodClient(resolvingPodClient()),
      baseConfig({ sides: 'left' }),
      previous,
    );

    expect(first.api.unregisteredAccessories).toHaveLength(1);
    expect(first.api.unregisteredAccessories[0]).toBe(rightAccessory);
    expect(first.api.registerPlatformAccessoriesCalls).toHaveLength(0);

    // A further restart, still at sides: 'left', with only the remaining two cached —
    // registers and unregisters nothing further.
    const remaining = previous.filter((a) => a !== rightAccessory);
    const second = await simulateRestart(
      factoryWithPodClient(resolvingPodClient()),
      baseConfig({ sides: 'left' }),
      remaining,
    );

    expect(second.api.registerPlatformAccessoriesCalls).toHaveLength(0);
    expect(second.api.unregisterPlatformAccessoriesCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// 6. Name seeding
// ---------------------------------------------------------------------------------------

describe('needsSettings guard', () => {
  it('with all accessories already cached, never performs an additional name-seeding getSettings call', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );
    const client = resolvingPodClient();

    await simulateRestart(factoryWithPodClient(client), baseConfig(), previous);

    // The poller's own `settings` endpoint class still polls once during bootstrap
    // (independent of name seeding) — this asserts there is no *second*, name-seeding-specific
    // call on top of that single bootstrap poll.
    expect(client.calls).toBe(1);
  });
});

describe('name seeding — Pod reachable', () => {
  it("seeds a new side accessory's displayName from settings[side].name", async () => {
    const { api } = await simulateRestart(factoryWithPodClient(resolvingPodClient()), baseConfig(), []);

    const leftByUuid = api.registeredAccessories.find(
      (a) => a.UUID === uuidFor(api.hap, 'pod.local', 'left'),
    );
    const rightByUuid = api.registeredAccessories.find(
      (a) => a.UUID === uuidFor(api.hap, 'pod.local', 'right'),
    );

    expect(leftByUuid?.displayName).toBe(fixtureSettings.left.name);
    expect(rightByUuid?.displayName).toBe(fixtureSettings.right.name);
  });
});

describe('name seeding — Pod unreachable', () => {
  it('rejected settings read: new accessories fall back to static names, discovery still completes', async () => {
    const { api } = await simulateRestart(factoryWithPodClient(rejectingPodClient()), baseConfig(), []);

    const leftByUuid = api.registeredAccessories.find(
      (a) => a.UUID === uuidFor(api.hap, 'pod.local', 'left'),
    );
    const rightByUuid = api.registeredAccessories.find(
      (a) => a.UUID === uuidFor(api.hap, 'pod.local', 'right'),
    );

    expect(leftByUuid?.displayName).toBe('Pod Left');
    expect(rightByUuid?.displayName).toBe('Pod Right');
  });

  it('never-resolving settings read: falls back to static names and does not hang, under fake timers', async () => {
    vi.useFakeTimers();
    try {
      const resultPromise = simulateRestart(
        factoryWithPodClient(neverResolvingPodClient()),
        baseConfig(),
        [],
      );

      await vi.advanceTimersByTimeAsync(SETTINGS_READ_TIMEOUT_MS + 1000);
      const { api } = await resultPromise;

      const leftByUuid = api.registeredAccessories.find(
        (a) => a.UUID === uuidFor(api.hap, 'pod.local', 'left'),
      );
      const rightByUuid = api.registeredAccessories.find(
        (a) => a.UUID === uuidFor(api.hap, 'pod.local', 'right'),
      );

      expect(leftByUuid?.displayName).toBe('Pod Left');
      expect(rightByUuid?.displayName).toBe('Pod Right');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('never-rename-on-restore', () => {
  it("an already-cached accessory's displayName is untouched even when a settings read (for another accessory) disagrees", async () => {
    const seedApi = new FakeHomebridgeApi();
    const cachedLeft = existingAccessory(seedApi, 'pod.local', 'left');
    cachedLeft.updateDisplayName('My Custom Left Name');

    expect(cachedLeft.displayName).not.toBe(fixtureSettings.left.name);

    // `right` is not cached, so a settings read fires — deliberately returning a `left.name`
    // that disagrees with the cached accessory's current display name.
    await simulateRestart(factoryWithPodClient(resolvingPodClient()), baseConfig(), [cachedLeft]);

    expect(cachedLeft.displayName).toBe('My Custom Left Name');
  });
});

// ---------------------------------------------------------------------------------------
// F1 — a malformed name from GET /api/settings must not crash accessory creation
// ---------------------------------------------------------------------------------------

describe('name seeding — malformed name from the Pod (F1)', () => {
  it('an empty-string name falls back to the static name, and all three accessories still register', async () => {
    const settings: Settings = {
      ...fixtureSettings,
      left: { ...fixtureSettings.left, name: '' },
    };

    const { api } = await simulateRestart(
      factoryWithPodClient(resolvingPodClient(settings)),
      baseConfig(),
      [],
    );

    expect(api.registeredAccessories).toHaveLength(3);
    const left = api.registeredAccessories.find((a) => a.UUID === uuidFor(api.hap, 'pod.local', 'left'));
    const right = api.registeredAccessories.find((a) => a.UUID === uuidFor(api.hap, 'pod.local', 'right'));
    expect(left?.displayName).toBe('Pod Left');
    // The unaffected side still gets its real seeded name — only the malformed one falls back.
    expect(right?.displayName).toBe(fixtureSettings.right.name);
  });

  it('a whitespace-only name falls back to the static name, and all three accessories still register', async () => {
    const settings: Settings = {
      ...fixtureSettings,
      right: { ...fixtureSettings.right, name: '   ' },
    };

    const { api } = await simulateRestart(
      factoryWithPodClient(resolvingPodClient(settings)),
      baseConfig(),
      [],
    );

    expect(api.registeredAccessories).toHaveLength(3);
    const right = api.registeredAccessories.find((a) => a.UUID === uuidFor(api.hap, 'pod.local', 'right'));
    expect(right?.displayName).toBe('Pod Right');
  });
});

describe('per-accessory creation failure does not discard the batch (F1)', () => {
  it('one accessory constructor throwing still lets the other two register, and logs which role failed', async () => {
    const api = new FakeHomebridgeApi();
    const log = createFakeLogging();

    // A synthetic constructor failure, independent of the nameFor/trim fix above — this
    // exercises the per-accessory try/catch itself, not just the specific empty-name cause of
    // it, so a future different cause of a bad accessory is guarded too.
    class ThrowingForRight extends FakePlatformAccessory {
      constructor(displayName: string, uuid: string, category?: Categories) {
        if (displayName === 'Pod Right') {
          throw new Error('synthetic accessory-construction failure');
        }
        super(displayName, uuid, category);
      }
    }
    (api as unknown as { platformAccessory: unknown }).platformAccessory = ThrowingForRight;

    new FreeSleepPlatform(log, baseConfig(), api.asApi(), rejectingPodClient());
    await api.fireDidFinishLaunching();

    const names = api.registeredAccessories.map((a) => a.displayName).sort();
    expect(names).toEqual(['Pod', 'Pod Left']);
    expect(
      logLines(log).some(
        (l) => l.level === 'error' && l.message.includes('right') && l.message.includes('failed'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// F2/F3 — a restored accessory's FirmwareRevision is re-applied, not left at Homebridge's
// own '0' placeholder
// ---------------------------------------------------------------------------------------

describe('FirmwareRevision is re-applied on restore (F2)', () => {
  it("every restored accessory's FirmwareRevision reads the package version, not Homebridge's placeholder '0'", async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );

    // Relies on simulateRestart's own F3 fix stamping '0' on each of these immediately before
    // configureAccessory, exactly as real Homebridge's bridgeService.js does — without that
    // fix, this test would pass trivially (nothing would ever have been '0' to begin with).
    const { platform } = await simulateRestart(
      factoryWithPodClient(rejectingPodClient()),
      baseConfig(),
      previous,
    );
    void platform;

    for (const accessory of previous) {
      const info = accessory.getService(seedApi.hap.Service.AccessoryInformation);
      expect(info?.getCharacteristic(seedApi.hap.Characteristic.FirmwareRevision).value).toBe(
        packageJson.version,
      );
    }
  });
});

describe('simulateRestart stamps the Homebridge FirmwareRevision placeholder (F3)', () => {
  it("stamps '0' on every previously-cached accessory before configureAccessory is invoked", async () => {
    const seedApi = new FakeHomebridgeApi();
    const accessory = existingAccessory(seedApi, 'pod.local', 'left');
    let observedDuringConfigureAccessory: unknown;

    class ObservingPlatform {
      constructor(_log: Logging, _config: PlatformConfig, api: API) {
        api.on('didFinishLaunching', () => {});
      }

      configureAccessory(a: PlatformAccessory): void {
        observedDuringConfigureAccessory = a
          .getService(seedApi.hap.Service.AccessoryInformation)
          ?.getCharacteristic(seedApi.hap.Characteristic.FirmwareRevision).value;
      }
    }

    await simulateRestart(
      (log, config, api) => new ObservingPlatform(log, config, api),
      baseConfig(),
      [accessory],
    );

    expect(observedDuringConfigureAccessory).toBe('0');
  });
});

// ---------------------------------------------------------------------------------------
// F4 — a prune that actually removes a service is persisted; a no-op prune is not
// ---------------------------------------------------------------------------------------

describe('prune persistence (F4)', () => {
  it('persists a restored accessory via updatePlatformAccessories when pruneServices actually removes a service', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );
    const leftAccessory = previous.find((a) => a.displayName === 'Pod Left')!;
    leftAccessory.addService(new seedApi.hap.Service.ContactSensor('Synthetic Extra', 'synthetic-subtype'));

    const { api } = await simulateRestart(factoryWithPodClient(resolvingPodClient()), baseConfig(), previous);

    expect(api.updatePlatformAccessoriesCalls.length).toBeGreaterThan(0);
    expect(api.updatePlatformAccessoriesCalls.flat()).toContain(leftAccessory);
  });

  it('never calls updatePlatformAccessories when nothing was pruned, to avoid gratuitous disk writes', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );

    const { api } = await simulateRestart(factoryWithPodClient(resolvingPodClient()), baseConfig(), previous);

    expect(api.updatePlatformAccessoriesCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// F7 — changing the configured host changes HomeKit identity outright
// ---------------------------------------------------------------------------------------

describe('changing the configured host changes identity (F7)', () => {
  it('booting with host A then restarting with host B unregisters all three old accessories and registers three new ones, without crashing', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod-a.local', role),
    );

    const { api } = await simulateRestart(
      factoryWithPodClient(rejectingPodClient()),
      baseConfig({ host: 'pod-b.local' }),
      previous,
    );

    expect(api.unregisteredAccessories).toHaveLength(3);
    expect(new Set(api.unregisteredAccessories)).toEqual(new Set(previous));

    expect(api.registeredAccessories).toHaveLength(3);
    const names = api.registeredAccessories.map((a) => a.displayName).sort();
    expect(names).toEqual(['Pod', 'Pod Left', 'Pod Right']);
    for (const accessory of api.registeredAccessories) {
      expect(accessory.UUID).not.toBe(
        [...previous].find((p) => p.displayName === accessory.displayName)?.UUID,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------
// N9 — a timed-out settings read actually aborts the underlying client call
// ---------------------------------------------------------------------------------------

describe('settings-read timeout aborts the underlying call (N9)', () => {
  it('passes an AbortSignal to getSettings() that is aborted once the startup budget is exceeded', async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const client: MinimalPodClient = {
        ...neverResolvingPodClient(),
        getSettings: (signal) => {
          receivedSignal = signal;
          return new Promise<Settings>(() => {});
        },
      };

      const resultPromise = simulateRestart(factoryWithPodClient(client), baseConfig(), []);
      await vi.advanceTimersByTimeAsync(SETTINGS_READ_TIMEOUT_MS + 1000);
      await resultPromise;

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------
// N10 — an unrecognized top-level config key is warned about, by name
// ---------------------------------------------------------------------------------------

describe('unrecognized config keys are warned about (N10)', () => {
  it("logs a warning naming a typo'd top-level config key", () => {
    const api = new FakeHomebridgeApi();
    const log = createFakeLogging();

    new FreeSleepPlatform(log, { ...baseConfig(), hots: 'oops' } as PlatformConfig, api.asApi());

    expect(logLines(log).some((l) => l.level === 'warn' && l.message.includes('hots'))).toBe(true);
  });

  it('logs no warning when every top-level key is recognized', () => {
    const api = new FakeHomebridgeApi();
    const log = createFakeLogging();

    new FreeSleepPlatform(log, baseConfig(), api.asApi());

    expect(logLines(log).some((l) => l.level === 'warn')).toBe(false);
  });
});
