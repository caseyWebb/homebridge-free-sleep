import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { DynamicPlatformPlugin, Logging, PlatformConfig } from 'homebridge';

import { FakeHomebridgeApi, simulateRestart } from './fakeHomebridgeApi.js';

const require = createRequire(import.meta.url);

// N13 in the platform-foundation code review: this file's own doc comment explains *why*
// `@homebridge/hap-nodejs` is pinned to exactly the version `homebridge` itself depends on —
// with two different builds installed, every characteristic read/write across the `API['hap']`
// boundary stops typechecking. This test turns "someone bumps `homebridge` and CI goes red with
// a wall of unrelated-looking type errors" into one clear, named failure instead.
describe('@homebridge/hap-nodejs version pin', () => {
  it("this repo's resolved @homebridge/hap-nodejs version matches the version homebridge itself depends on", () => {
    // `homebridge`'s `package.json` declares an `exports` map that does not publish
    // `./package.json` as a subpath, so `require('homebridge/package.json')` is rejected by
    // Node's exports enforcement — resolve its main entry instead and read the package.json
    // sitting next to it on disk.
    const homebridgeEntry = require.resolve('homebridge');
    const homebridgePackageJsonPath = path.join(path.dirname(homebridgeEntry), '..', 'package.json');
    const homebridgePackageJson = JSON.parse(readFileSync(homebridgePackageJsonPath, 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const hapNodeJsPackageJson = require('@homebridge/hap-nodejs/package.json') as { version: string };

    expect(hapNodeJsPackageJson.version).toBe(homebridgePackageJson.dependencies['@homebridge/hap-nodejs']);
  });
});

/** A trivial `DynamicPlatformPlugin` used only to exercise the harness itself. */
class NoopPlatform implements DynamicPlatformPlugin {
  configureAccessory(): void {}
}

describe('FakeHomebridgeApi', () => {
  it('constructing it and firing a recorded didFinishLaunching listener executes without error', async () => {
    const api = new FakeHomebridgeApi();
    let fired = false;
    api.on('didFinishLaunching', () => {
      fired = true;
    });
    // Awaited (N12 in the platform-foundation code review): `fireDidFinishLaunching` is async,
    // and an un-awaited call here would let an async listener's rejection surface as an
    // unhandled rejection instead of failing this test.
    await expect(api.fireDidFinishLaunching()).resolves.toBeUndefined();
    expect(fired).toBe(true);
  });
});

describe('simulateRestart', () => {
  it('with an empty previous-accessories list, a platform that registers on launch ends with new accessories', async () => {
    class RegisteringPlatform implements DynamicPlatformPlugin {
      constructor(
        _log: Logging,
        _config: PlatformConfig,
        private readonly api: import('homebridge').API,
      ) {
        this.api.on('didFinishLaunching', () => {
          this.api.registerPlatformAccessories('plugin', 'Platform', [
            new this.api.platformAccessory('New Accessory', this.api.hap.uuid.generate('new')),
          ]);
        });
      }

      configureAccessory(): void {}
    }

    const { api } = await simulateRestart(
      (log, config, api) => new RegisteringPlatform(log, config, api),
      { platform: 'Platform' },
      [],
    );

    expect(api.registeredAccessories).toHaveLength(1);
  });

  it('restarted with a full set of previously-created accessories, registers nothing new', async () => {
    class NeverRegisteringPlatform extends NoopPlatform {
      constructor(
        _log: Logging,
        _config: PlatformConfig,
        private readonly api: import('homebridge').API,
      ) {
        super();
        this.api.on('didFinishLaunching', () => {
          // Intentionally registers nothing.
        });
      }
    }

    const seedApi = new FakeHomebridgeApi();
    const previous = [new seedApi.platformAccessory('Existing', seedApi.hap.uuid.generate('existing'))];

    const { api } = await simulateRestart(
      (log, config, api) => new NeverRegisteringPlatform(log, config, api),
      { platform: 'Platform' },
      previous,
    );

    expect(api.registeredAccessories).toHaveLength(0);
  });
});

describe('fake PodClient modes', () => {
  it('a resolved promise resolves within the test', async () => {
    const client = { getSettings: () => Promise.resolve({ ok: true }) };
    await expect(client.getSettings()).resolves.toEqual({ ok: true });
  });

  it('a rejected promise rejects within the test', async () => {
    const client = { getSettings: () => Promise.reject(new Error('unreachable')) };
    await expect(client.getSettings()).rejects.toThrow('unreachable');
  });

  it('a never-resolving promise never settles within a bounded, fake-timer-advanced window', async () => {
    vi.useFakeTimers();
    try {
      const client = { getSettings: () => new Promise(() => {}) };
      let settled = false;
      client.getSettings().then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
