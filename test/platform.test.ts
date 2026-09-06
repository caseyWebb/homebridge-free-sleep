import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

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
import { SettingsSchema, type Settings } from '../src/pod/types.js';
import {
  createFakeLogging,
  FakeHomebridgeApi,
  simulateRestart,
  type FakePlatformAccessory,
  type PlatformFactory,
} from './fakeHomebridgeApi.js';
import { loadFixture } from './loadFixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf-8')) as {
  version: string;
};

const fixtureSettings: Settings = SettingsSchema.parse(loadFixture('settings.json'));

function baseConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return { platform: PLATFORM_NAME, host: 'pod.local', ...overrides };
}

/** A PodClient stand-in that never settles — used with vitest fake timers only. */
function neverResolvingPodClient(): MinimalPodClient {
  return { getSettings: () => new Promise<Settings>(() => {}) };
}

function resolvingPodClient(settings: Settings = fixtureSettings): MinimalPodClient & { calls: number } {
  const client = {
    calls: 0,
    getSettings: () => {
      client.calls += 1;
      return Promise.resolve(settings);
    },
  };
  return client;
}

function rejectingPodClient(message = 'Pod unreachable'): MinimalPodClient {
  return { getSettings: () => Promise.reject(new Error(message)) };
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
  it('registers exactly three accessories, named Pod Left/Pod Right/Pod, each with only AccessoryInformation', async () => {
    const { api } = await simulateRestart(factoryWithPodClient(rejectingPodClient()), baseConfig(), []);

    expect(api.registeredAccessories).toHaveLength(3);
    const names = api.registeredAccessories.map((a) => a.displayName).sort();
    expect(names).toEqual(['Pod', 'Pod Left', 'Pod Right']);

    for (const accessory of api.registeredAccessories) {
      const nonInfoServices = accessory.services.filter(
        (s) => s.UUID !== api.hap.Service.AccessoryInformation.UUID,
      );
      expect(nonInfoServices).toHaveLength(0);
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
  it('with all accessories already cached, never calls the fake PodClient.getSettings', async () => {
    const seedApi = new FakeHomebridgeApi();
    const previous = (['left', 'right', 'hub'] as const).map((role) =>
      existingAccessory(seedApi, 'pod.local', role),
    );
    const client = resolvingPodClient();

    await simulateRestart(factoryWithPodClient(client), baseConfig(), previous);

    expect(client.calls).toBe(0);
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
