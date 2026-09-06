/**
 * A fake Homebridge `API` for driving `FreeSleepPlatform` end-to-end in `vitest`, using the
 * **real** `@homebridge/hap-nodejs` underneath (design.md, "Testability without a paired Home
 * app"). `@homebridge/hap-nodejs` is a devDependency only — never imported by `src/` at
 * runtime; this file is test-only.
 *
 * `package.json` pins this repo's own `@homebridge/hap-nodejs` devDependency to exactly the
 * version `homebridge` itself depends on (`2.2.2`), deliberately — with two different
 * versions both installed, this file's own `Service`/`Characteristic` instances and
 * `homebridge`'s `HAP` type (`API['hap']`) are structurally distinct builds of the same
 * classes, and every characteristic read/write in this suite fails to typecheck across that
 * boundary. Pinned to one shared copy, there is nothing to reconcile.
 *
 * - `hap`: the real `HAP` namespace (`uuid`, `Categories`, `Service`, `Characteristic`), so
 *   `uuid.generate` and real `Service`/`Characteristic` behavior (including `setProps`
 *   validation) are exercised, not reimplemented.
 * - `platformAccessory`: `FakePlatformAccessory` below, a thin wrapper around a real
 *   hap-nodejs `Accessory` — mirroring what the `homebridge` package's own `PlatformAccessory`
 *   does internally (`node_modules/homebridge/dist/platformAccessory.js`) — so `.getService`,
 *   `.getServiceById`, `.addService`, `.removeService`, and `.context` all behave like
 *   production. Reimplemented rather than imported directly because the `homebridge` package's
 *   `exports` map only publishes its top-level entry point, which re-exports `PlatformAccessory`
 *   as a **type only** (`export type` in `dist/index.d.ts`); the runtime class itself has no
 *   reachable subpath from outside the package.
 * - `on(event, cb)`: records listeners rather than an `EventEmitter`, so
 *   `fireDidFinishLaunching` can await whatever a listener returns — real Homebridge never
 *   awaits its `'didFinishLaunching'` listeners (they are typed `() => void`), but letting the
 *   fake await a listener's returned promise is what lets a test observe the *outcome* of
 *   `FreeSleepPlatform`'s async `discoverAccessories()` without a side-channel.
 * - `registerPlatformAccessories` / `updatePlatformAccessories` /
 *   `unregisterPlatformAccessories`: push into inspectable arrays instead of touching disk.
 *
 * The whole fake object is hand off to plugin code via `asApi()`, an `as unknown as API` cast
 * at the one boundary that needs it — deliberately, since matching the real `API` interface's
 * full structural shape (Matter, external accessories, `versionGreaterOrEqual`, ...) buys
 * nothing `FreeSleepPlatform` uses.
 */

import { EventEmitter } from 'node:events';

import hapNodeJs, { Accessory } from '@homebridge/hap-nodejs';
import type { Categories, Service, WithUUID } from '@homebridge/hap-nodejs';
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  UnknownContext,
} from 'homebridge';

/**
 * Structurally mirrors `homebridge`'s own `PlatformAccessory` (see file doc above) closely
 * enough for everything `FreeSleepPlatform` and this test suite do with an accessory.
 */
export class FakePlatformAccessory<T extends UnknownContext = UnknownContext> extends EventEmitter {
  readonly _associatedHAPAccessory: Accessory;
  displayName: string;
  readonly UUID: string;
  category: Categories;
  services: Service[];
  context: T = {} as T;

  constructor(displayName: string, uuid: string, category?: Categories) {
    super();
    this._associatedHAPAccessory = new Accessory(displayName, uuid);
    if (category !== undefined) {
      this._associatedHAPAccessory.category = category;
    }
    this.displayName = this._associatedHAPAccessory.displayName;
    this.UUID = this._associatedHAPAccessory.UUID;
    this.category = this._associatedHAPAccessory.category;
    this.services = this._associatedHAPAccessory.services;
  }

  updateDisplayName(name: string): void {
    this.displayName = name;
    this._associatedHAPAccessory.displayName = name;
  }

  addService(service: Service): Service {
    return this._associatedHAPAccessory.addService(service);
  }

  removeService(service: Service): void {
    this._associatedHAPAccessory.removeService(service);
  }

  getService<S extends WithUUID<typeof Service>>(name: string | S): Service | undefined {
    return this._associatedHAPAccessory.getService(name);
  }

  getServiceById<S extends WithUUID<typeof Service>>(uuid: string | S, subType: string): Service | undefined {
    return this._associatedHAPAccessory.getServiceById(uuid, subType);
  }
}

type DidFinishLaunchingListener = () => void | Promise<void>;

export class FakeHomebridgeApi {
  readonly hap = hapNodeJs;
  readonly platformAccessory = FakePlatformAccessory;

  readonly registerPlatformAccessoriesCalls: FakePlatformAccessory[][] = [];
  readonly updatePlatformAccessoriesCalls: FakePlatformAccessory[][] = [];
  readonly unregisterPlatformAccessoriesCalls: FakePlatformAccessory[][] = [];

  private readonly didFinishLaunchingListeners: DidFinishLaunchingListener[] = [];

  on(event: 'didFinishLaunching' | 'shutdown', listener: DidFinishLaunchingListener): this {
    if (event === 'didFinishLaunching') {
      this.didFinishLaunchingListeners.push(listener);
    }
    return this;
  }

  get didFinishLaunchingListenerCount(): number {
    return this.didFinishLaunchingListeners.length;
  }

  /** Fires every recorded `'didFinishLaunching'` listener and awaits any promise it returns. */
  async fireDidFinishLaunching(): Promise<void> {
    const results = this.didFinishLaunchingListeners.map((listener) => listener());
    await Promise.all(results);
  }

  registerPlatformAccessories(
    _pluginIdentifier: string,
    _platformName: string,
    accessories: FakePlatformAccessory[],
  ): void {
    this.registerPlatformAccessoriesCalls.push(accessories);
  }

  updatePlatformAccessories(accessories: FakePlatformAccessory[]): void {
    this.updatePlatformAccessoriesCalls.push(accessories);
  }

  unregisterPlatformAccessories(
    _pluginIdentifier: string,
    _platformName: string,
    accessories: FakePlatformAccessory[],
  ): void {
    this.unregisterPlatformAccessoriesCalls.push(accessories);
  }

  /** Every accessory ever passed to `registerPlatformAccessories`, across all calls, flattened. */
  get registeredAccessories(): FakePlatformAccessory[] {
    return this.registerPlatformAccessoriesCalls.flat();
  }

  /** Every accessory ever passed to `unregisterPlatformAccessories`, across all calls, flattened. */
  get unregisteredAccessories(): FakePlatformAccessory[] {
    return this.unregisterPlatformAccessoriesCalls.flat();
  }

  asApi(): API {
    return this as unknown as API;
  }
}

export function createFakeLogging(): Logging {
  const lines: Array<{ level: string; message: string }> = [];
  const record =
    (level: string) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  const fn = ((message: string) => {
    lines.push({ level: 'info', message });
  }) as unknown as Logging;
  fn.prefix = 'FreeSleep';
  fn.info = record('info');
  fn.success = record('success');
  fn.warn = record('warn');
  fn.error = record('error');
  fn.debug = record('debug');
  fn.log = (level: string, message: string): void => {
    lines.push({ level, message });
  };
  (fn as unknown as { lines: typeof lines }).lines = lines;
  return fn;
}

export type PlatformFactory<P extends DynamicPlatformPlugin> = (
  log: Logging,
  config: PlatformConfig,
  api: API,
) => P;

export interface SimulateRestartResult<P extends DynamicPlatformPlugin> {
  api: FakeHomebridgeApi;
  log: Logging;
  platform: P;
}

/**
 * Constructs a fresh platform, feeds each of `previousAccessories` through
 * `configureAccessory` (as real Homebridge does before `didFinishLaunching`), then fires
 * `didFinishLaunching` and awaits its completion (design.md, "Testability without a paired
 * Home app").
 */
export async function simulateRestart<P extends DynamicPlatformPlugin>(
  platformFactory: PlatformFactory<P>,
  config: PlatformConfig,
  previousAccessories: FakePlatformAccessory[] = [],
): Promise<SimulateRestartResult<P>> {
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const platform = platformFactory(log, config, api.asApi());

  for (const accessory of previousAccessories) {
    platform.configureAccessory(accessory as unknown as PlatformAccessory);
  }

  await api.fireDidFinishLaunching();

  return { api, log, platform };
}
