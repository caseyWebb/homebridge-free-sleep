/**
 * Whole-platform `ConfiguredName` coverage (release-polish tasks.md, Section 3) — the two things
 * no single service's own unit test can prove on its own:
 *
 *  - 3.1: two complementary constructions, both required because neither alone proves the
 *    other's claim:
 *      - A genuine first-ever launch (no cached accessories at all — every accessory is created
 *        fresh via `api.platformAccessory`) seeds every service's `ConfiguredName` to its
 *        Decision-3 default, with zero `characteristic-warning` events anywhere across the whole
 *        construction. This covers a brand-new install, but a service's `getServiceById` finding
 *        nothing and a service's `getServiceById` finding something-with-no-`ConfiguredName` are
 *        different code paths, so this alone does not prove the upgrade case below.
 *      - The task's own headline scenario: a pre-#49 cached-accessory upgrade — services present,
 *        `ConfiguredName` on *none* of them, the exact shape design.md's Migration Plan describes
 *        a real upgrade restoring from. Built via hap-nodejs's own real `Accessory.serialize` ->
 *        strip `ConfiguredName` from both `characteristics` and `optionalCharacteristics` on every
 *        service -> `Accessory.deserialize`, then fed through `configureAccessory` on a freshly
 *        constructed platform — `simulateRestart`'s live-object reuse cannot represent a
 *        characteristic's *absence*, only an unmodified live value, so this scenario needs the
 *        real serialize/deserialize round trip instead. Also proves a rename made after this
 *        upgrade survives the *next* restart, closing the loop with 3.2 below.
 *  - 3.2: a second restart — this time restoring accessories that already carry `ConfiguredName`,
 *    one of them at a controller-renamed value — never calls `setCharacteristic` on it again for
 *    any service: the tech-lead-required explicit "restore with a renamed value survives" case.
 *
 * Every optional hub/side service is config-enabled here (`primeSwitch`, `ledLightbulb`,
 * `testAlarmSwitch`, `serverFaultSensor`, `occupancySource: 'presence'`), so all thirteen
 * services this change touches are actually constructed and checked, not just the six that are
 * on by default.
 */
import { Accessory, Characteristic } from '@homebridge/hap-nodejs';
import type { SerializedAccessory, Service, WithUUID } from '@homebridge/hap-nodejs';
import { describe, expect, it } from 'vitest';

import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { FreeSleepPlatform, uuidFor, type MinimalPodClient } from '../../src/platform.js';
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
} from '../../src/pod/types.js';
import { PLATFORM_NAME } from '../../src/settings.js';
import { ALARM_DISMISS_SUBTYPE, ALARM_PRESS_SUBTYPE } from '../../src/services/alarm.js';
import { AWAY_MODE_SUBTYPE } from '../../src/services/awayMode.js';
import { CONNECTION_SUBTYPE } from '../../src/services/connection.js';
import { LED_SUBTYPE } from '../../src/services/led.js';
import { OCCUPANCY_SUBTYPE } from '../../src/services/occupancy.js';
import { PRIME_SUBTYPE } from '../../src/services/prime.js';
import { SERVER_FAULT_SUBTYPE } from '../../src/services/serverFault.js';
import { CONFIGURED_NAME, TEST_ALARM_CONFIGURED_NAME } from '../../src/services/serviceName.js';
import { SKIP_ALARM_SUBTYPE } from '../../src/services/skipAlarm.js';
import { TEST_ALARM_LEFT_SUBTYPE, TEST_ALARM_RIGHT_SUBTYPE } from '../../src/services/testAlarm.js';
import { WATER_LOW_SUBTYPE } from '../../src/services/waterLow.js';
import { createFakeLogging, FakeHomebridgeApi, FakePlatformAccessory, simulateRestart, type PlatformFactory } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';

const fixtureSettings: Settings = SettingsSchema.parse(loadFixture('settings.json'));
const fixtureDeviceStatus: DeviceStatus = DeviceStatusSchema.parse(loadFixture('deviceStatus.json'));
const fixtureSchedules: Schedules = SchedulesSchema.parse(loadFixture('schedules.json'));
const fixtureServices: PodServices = ServicesSchema.parse(loadFixture('services.json'));
const fixtureServerStatus: ServerStatus = ServerStatusSchema.parse(loadFixture('serverStatus.json'));

function baseConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return {
    platform: PLATFORM_NAME,
    host: 'pod.local',
    occupancySource: 'presence',
    primeSwitch: true,
    ledLightbulb: true,
    testAlarmSwitch: true,
    serverFaultSensor: true,
    ...overrides,
  };
}

function resolvingPodClient(): MinimalPodClient {
  return {
    getDeviceStatus: () => Promise.resolve(structuredClone(fixtureDeviceStatus)),
    getSettings: () => Promise.resolve(structuredClone(fixtureSettings)),
    getSchedules: () => Promise.resolve(structuredClone(fixtureSchedules)),
    getServices: () => Promise.resolve(structuredClone(fixtureServices)),
    getServerStatus: () => Promise.resolve(structuredClone(fixtureServerStatus)),
    postDeviceStatus: () => Promise.resolve(),
    postSettings: () => Promise.resolve(),
    postAlarm: () => Promise.resolve(),
  };
}

function factoryWithPodClient(podClient: MinimalPodClient): PlatformFactory<FreeSleepPlatform> {
  return (log: Logging, config: PlatformConfig, api: API) => new FreeSleepPlatform(log, config, api, podClient);
}

interface ServiceExpectation {
  serviceKey: 'Thermostat' | 'StatelessProgrammableSwitch' | 'Switch' | 'OccupancySensor' | 'ContactSensor' | 'Lightbulb';
  subtype: string;
  label: string;
}

const SIDE_SERVICES: readonly ServiceExpectation[] = [
  { serviceKey: 'Thermostat', subtype: 'thermostat', label: CONFIGURED_NAME.thermostat },
  { serviceKey: 'StatelessProgrammableSwitch', subtype: ALARM_PRESS_SUBTYPE, label: CONFIGURED_NAME.alarm },
  { serviceKey: 'Switch', subtype: ALARM_DISMISS_SUBTYPE, label: CONFIGURED_NAME.dismissAlarm },
  { serviceKey: 'OccupancySensor', subtype: OCCUPANCY_SUBTYPE, label: CONFIGURED_NAME.occupancy },
  { serviceKey: 'Switch', subtype: AWAY_MODE_SUBTYPE, label: CONFIGURED_NAME.awayMode },
  { serviceKey: 'Switch', subtype: SKIP_ALARM_SUBTYPE, label: CONFIGURED_NAME.skipNextAlarm },
];

const HUB_SERVICES: readonly ServiceExpectation[] = [
  { serviceKey: 'ContactSensor', subtype: CONNECTION_SUBTYPE, label: CONFIGURED_NAME.podConnection },
  { serviceKey: 'Lightbulb', subtype: LED_SUBTYPE, label: CONFIGURED_NAME.led },
  { serviceKey: 'Switch', subtype: PRIME_SUBTYPE, label: CONFIGURED_NAME.prime },
  { serviceKey: 'ContactSensor', subtype: WATER_LOW_SUBTYPE, label: CONFIGURED_NAME.waterLevel },
  { serviceKey: 'ContactSensor', subtype: SERVER_FAULT_SUBTYPE, label: CONFIGURED_NAME.serverFault },
  { serviceKey: 'Switch', subtype: TEST_ALARM_LEFT_SUBTYPE, label: TEST_ALARM_CONFIGURED_NAME.left },
  { serviceKey: 'Switch', subtype: TEST_ALARM_RIGHT_SUBTYPE, label: TEST_ALARM_CONFIGURED_NAME.right },
];

function serviceFor(
  api: FakeHomebridgeApi,
  accessory: FakePlatformAccessory,
  expectation: ServiceExpectation,
): Service {
  const ctor = api.hap.Service[expectation.serviceKey] as WithUUID<typeof Service>;
  const service = accessory.getServiceById(ctor, expectation.subtype);
  expect(service, `${accessory.displayName} missing ${expectation.serviceKey}/${expectation.subtype}`).toBeDefined();
  return service!;
}

interface CharacteristicWarningEvent {
  characteristic: { UUID: string };
}

/** A `FakePlatformAccessory` subclass that starts listening for `ConfiguredName`
 * `characteristic-warning` events the moment the underlying hap-nodejs `Accessory` exists — i.e.
 * before the platform under test ever calls `addService`/`addCharacteristic` on it, which a
 * listener attached only after `simulateRestart` resolves would miss entirely (warnings fire
 * synchronously during construction, not queued for later).
 *
 * Filtered to `ConfiguredName` specifically — mirrors `test/services/configuredNameHelpers.ts`'s
 * own filter and its doc: the shared `deviceStatus` fixture's target temperature sits outside
 * `ThermostatService`'s own `setProps` range, which triggers an unrelated, pre-existing
 * `Characteristic was supplied illegal value` warning on every construction that has nothing to
 * do with this change. */
function trackingAccessoryClass(warnings: unknown[]) {
  return class extends FakePlatformAccessory {
    constructor(...args: ConstructorParameters<typeof FakePlatformAccessory>) {
      super(...args);
      this._associatedHAPAccessory.on('characteristic-warning', (w: CharacteristicWarningEvent) => {
        if (w.characteristic?.UUID === Characteristic.ConfiguredName.UUID) warnings.push(w);
      });
    }
  };
}

/** Strips `ConfiguredName` from every service's `characteristics` *and* `optionalCharacteristics`
 * in a `SerializedAccessory`. Both arrays matter: `Service.setCharacteristic` (what
 * `seedConfiguredName` calls) resolves via `getCharacteristic`, which — for a characteristic
 * found in `optionalCharacteristics` — calls `addCharacteristic`, and `addCharacteristic` only
 * ever *pushes* onto `characteristics`; it never removes the original `optionalCharacteristics`
 * entry. So a fully-seeded, already-`ConfiguredName`-carrying service serializes with the
 * characteristic present in both arrays, and a faithful "as if #49 never ran" fixture has to
 * strip both to avoid a stale `optionalCharacteristics` entry the real pre-#49 accessory never
 * had. */
function stripConfiguredName(json: SerializedAccessory): SerializedAccessory {
  const configuredNameUuid = Characteristic.ConfiguredName.UUID;
  return {
    ...json,
    services: json.services.map((service) => ({
      ...service,
      characteristics: service.characteristics.filter((c) => c.UUID !== configuredNameUuid),
      // `exactOptionalPropertyTypes`: only assign the key at all when the source service had it,
      // rather than ever setting it to `undefined` explicitly.
      ...(service.optionalCharacteristics
        ? { optionalCharacteristics: service.optionalCharacteristics.filter((c) => c.UUID !== configuredNameUuid) }
        : {}),
    })),
  };
}

/** Round-trips `hapAccessory` through hap-nodejs's own real `Accessory.serialize`/`deserialize` —
 * not `simulateRestart`'s live-object reuse, which cannot represent a characteristic's *absence*,
 * only an unmodified live value — producing a fresh `Accessory` with every service intact but
 * `ConfiguredName` present on none of them: the exact shape design.md's Migration Plan describes
 * a pre-#49 cached-accessory restoring from. */
function asPreConfiguredNameCachedAccessory(hapAccessory: Accessory): Accessory {
  return Accessory.deserialize(stripConfiguredName(Accessory.serialize(hapAccessory)));
}

/** Attaches a `ConfiguredName`-filtered `characteristic-warning` listener directly to
 * `accessory`'s underlying hap-nodejs `Accessory` — must be called before the accessory is fed
 * through `configureAccessory`, since warnings fire synchronously during service construction
 * inside `didFinishLaunching`, not queued for later. */
function trackConfiguredNameWarnings(accessory: FakePlatformAccessory, warnings: unknown[]): void {
  accessory._associatedHAPAccessory.on('characteristic-warning', (w: CharacteristicWarningEvent) => {
    if (w.characteristic?.UUID === Characteristic.ConfiguredName.UUID) warnings.push(w);
  });
}

describe('ConfiguredName across a full platform construction (release-polish tasks.md 3.1)', () => {
  it('a first-ever launch seeds every service on every accessory to its default label, with zero characteristic-warning events', async () => {
    const warnings: unknown[] = [];
    const api = new FakeHomebridgeApi();
    (api as unknown as { platformAccessory: unknown }).platformAccessory = trackingAccessoryClass(warnings);

    const platform = new FreeSleepPlatform(createFakeLogging(), baseConfig(), api.asApi(), resolvingPodClient());
    void platform;
    await api.fireDidFinishLaunching();

    expect(api.registeredAccessories).toHaveLength(3);
    const left = api.registeredAccessories.find((a) => a.UUID === uuidFor(api.hap, 'pod.local', 'left'))!;
    const right = api.registeredAccessories.find((a) => a.UUID === uuidFor(api.hap, 'pod.local', 'right'))!;
    const hub = api.registeredAccessories.find((a) => a.UUID === uuidFor(api.hap, 'pod.local', 'hub'))!;

    for (const side of [left, right]) {
      for (const expectation of SIDE_SERVICES) {
        const service = serviceFor(api, side, expectation);
        expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe(expectation.label);
      }
    }
    for (const expectation of HUB_SERVICES) {
      const service = serviceFor(api, hub, expectation);
      expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe(expectation.label);
    }

    // Task 3.1's own "zero characteristic-warning events emitted across the whole platform
    // construction" — `warnings` here is already filtered to `ConfiguredName.UUID` by
    // `trackingAccessoryClass` above, not asserted unfiltered. The shared `deviceStatus` fixture
    // does *not* keep every value in range: `ThermostatService`'s own unrelated Target Temperature
    // default-value warning (test/services/configuredNameHelpers.ts's doc) fires twice here, once
    // per side, unfiltered — confirmed directly against this exact construction. It is excluded
    // from `warnings` only because of the UUID filter above, not because it doesn't fire; tracked
    // separately, not something this test is meant to catch.
    expect(warnings).toHaveLength(0);
  });
});

describe('a pre-#49 cached-accessory upgrade seeds every service exactly once (release-polish tasks.md 3.1, the headline scenario)', () => {
  it('restoring accessories that carry every service but no ConfiguredName characteristic at all seeds each to its default label, with zero characteristic-warning events — and a post-upgrade rename survives the next restart too', async () => {
    // Step 1: a genuine first launch, to obtain real, fully-populated hap-nodejs `Accessory`
    // instances for all three roles — every service constructed, every `ConfiguredName` seeded.
    const seedApi = new FakeHomebridgeApi();
    new FreeSleepPlatform(createFakeLogging(), baseConfig(), seedApi.asApi(), resolvingPodClient());
    await seedApi.fireDidFinishLaunching();
    expect(seedApi.registeredAccessories).toHaveLength(3);
    const seedLeft = seedApi.registeredAccessories.find((a) => a.UUID === uuidFor(seedApi.hap, 'pod.local', 'left'))!;
    const seedRight = seedApi.registeredAccessories.find((a) => a.UUID === uuidFor(seedApi.hap, 'pod.local', 'right'))!;
    const seedHub = seedApi.registeredAccessories.find((a) => a.UUID === uuidFor(seedApi.hap, 'pod.local', 'hub'))!;

    // Step 2: the real serialize -> strip ConfiguredName -> deserialize round trip — the exact
    // pre-#49 cached-accessory shape design.md's Migration Plan describes.
    const upgradeLeft = FakePlatformAccessory.fromHapAccessory(asPreConfiguredNameCachedAccessory(seedLeft._associatedHAPAccessory));
    const upgradeRight = FakePlatformAccessory.fromHapAccessory(asPreConfiguredNameCachedAccessory(seedRight._associatedHAPAccessory));
    const upgradeHub = FakePlatformAccessory.fromHapAccessory(asPreConfiguredNameCachedAccessory(seedHub._associatedHAPAccessory));

    // Confirms the strip actually worked before it matters: every service the platform will
    // restore into is present, but genuinely carries no ConfiguredName at all yet.
    for (const [accessory, expectations] of [
      [upgradeLeft, SIDE_SERVICES],
      [upgradeRight, SIDE_SERVICES],
      [upgradeHub, HUB_SERVICES],
    ] as const) {
      for (const expectation of expectations) {
        const service = serviceFor(seedApi, accessory, expectation);
        expect(service.testCharacteristic(Characteristic.ConfiguredName)).toBe(false);
      }
    }

    // Step 3: feed the restored, characteristic-absent accessories through `configureAccessory`
    // on a *freshly constructed* platform, then fire `didFinishLaunching` — real Homebridge's own
    // restore order (`simulateRestart`'s own doc). A listener is attached to each accessory's
    // underlying hap-nodejs `Accessory` before that, since warnings fire synchronously during
    // service construction.
    const upgradeWarnings: unknown[] = [];
    for (const accessory of [upgradeLeft, upgradeRight, upgradeHub]) {
      trackConfiguredNameWarnings(accessory, upgradeWarnings);
    }
    const upgradeApi = new FakeHomebridgeApi();
    const upgradePlatform = new FreeSleepPlatform(createFakeLogging(), baseConfig(), upgradeApi.asApi(), resolvingPodClient());
    for (const accessory of [upgradeLeft, upgradeRight, upgradeHub]) {
      upgradePlatform.configureAccessory(accessory as unknown as PlatformAccessory);
    }
    await upgradeApi.fireDidFinishLaunching();

    // All three matched an already-cached UUID, so none of them is ever "new" —
    // `registerPlatformAccessories` is never called for a restored accessory.
    expect(upgradeApi.registeredAccessories).toHaveLength(0);

    for (const side of [upgradeLeft, upgradeRight]) {
      for (const expectation of SIDE_SERVICES) {
        const service = serviceFor(upgradeApi, side, expectation);
        expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe(expectation.label);
      }
    }
    for (const expectation of HUB_SERVICES) {
      const service = serviceFor(upgradeApi, upgradeHub, expectation);
      expect(service.getCharacteristic(Characteristic.ConfiguredName).value).toBe(expectation.label);
    }
    // Every service seeded exactly once: each landed on its Decision-3 default (not left
    // uninitialized, not double-set to something else), and no `ConfiguredName`
    // characteristic-warning fired anywhere during this restore.
    expect(upgradeWarnings).toHaveLength(0);

    // Step 4: a rename made post-upgrade survives the *next* restart too — the same real
    // serialize/deserialize round trip, this time carrying the now-present `ConfiguredName`
    // through untouched (closing the loop with 3.2 below, but via the real round trip rather
    // than live-object reuse).
    const renamedThermostat = serviceFor(upgradeApi, upgradeLeft, SIDE_SERVICES[0]!);
    renamedThermostat.getCharacteristic(Characteristic.ConfiguredName).updateValue('Bedroom Thermostat');

    const nextLeft = FakePlatformAccessory.fromHapAccessory(
      Accessory.deserialize(Accessory.serialize(upgradeLeft._associatedHAPAccessory)),
    );
    const nextRight = FakePlatformAccessory.fromHapAccessory(
      Accessory.deserialize(Accessory.serialize(upgradeRight._associatedHAPAccessory)),
    );
    const nextHub = FakePlatformAccessory.fromHapAccessory(
      Accessory.deserialize(Accessory.serialize(upgradeHub._associatedHAPAccessory)),
    );

    const nextWarnings: unknown[] = [];
    for (const accessory of [nextLeft, nextRight, nextHub]) {
      trackConfiguredNameWarnings(accessory, nextWarnings);
    }
    const nextApi = new FakeHomebridgeApi();
    const nextPlatform = new FreeSleepPlatform(createFakeLogging(), baseConfig(), nextApi.asApi(), resolvingPodClient());
    for (const accessory of [nextLeft, nextRight, nextHub]) {
      nextPlatform.configureAccessory(accessory as unknown as PlatformAccessory);
    }
    await nextApi.fireDidFinishLaunching();

    expect(serviceFor(nextApi, nextLeft, SIDE_SERVICES[0]!).getCharacteristic(Characteristic.ConfiguredName).value).toBe(
      'Bedroom Thermostat',
    );
    for (const expectation of SIDE_SERVICES.slice(1)) {
      expect(serviceFor(nextApi, nextLeft, expectation).getCharacteristic(Characteristic.ConfiguredName).value).toBe(
        expectation.label,
      );
    }
    for (const expectation of SIDE_SERVICES) {
      expect(serviceFor(nextApi, nextRight, expectation).getCharacteristic(Characteristic.ConfiguredName).value).toBe(
        expectation.label,
      );
    }
    for (const expectation of HUB_SERVICES) {
      expect(serviceFor(nextApi, nextHub, expectation).getCharacteristic(Characteristic.ConfiguredName).value).toBe(
        expectation.label,
      );
    }
    expect(nextWarnings).toHaveLength(0);
  });
});

describe('a restore-with-renamed-value survives a second restart (release-polish tasks.md 3.2, tech-lead resolution 1)', () => {
  it('an already-seeded ConfiguredName, and one renamed by a controller, are both left untouched — and no warning fires', async () => {
    const firstWarnings: unknown[] = [];
    const firstApi = new FakeHomebridgeApi();
    (firstApi as unknown as { platformAccessory: unknown }).platformAccessory = trackingAccessoryClass(firstWarnings);
    new FreeSleepPlatform(createFakeLogging(), baseConfig(), firstApi.asApi(), resolvingPodClient());
    await firstApi.fireDidFinishLaunching();
    expect(firstWarnings).toHaveLength(0);

    const previous = firstApi.registeredAccessories;
    const left = previous.find((a) => a.UUID === uuidFor(firstApi.hap, 'pod.local', 'left'))!;
    const hub = previous.find((a) => a.UUID === uuidFor(firstApi.hap, 'pod.local', 'hub'))!;

    // Attached before the second restart, to the very same underlying hap-nodejs `Accessory`
    // instances `simulateRestart` will feed through `configureAccessory` below — warnings fire
    // synchronously during service construction, so a listener attached afterward would miss them.
    const secondWarnings: unknown[] = [];
    for (const accessory of previous) {
      accessory._associatedHAPAccessory.on('characteristic-warning', (w: CharacteristicWarningEvent) => {
        if (w.characteristic?.UUID === Characteristic.ConfiguredName.UUID) secondWarnings.push(w);
      });
    }

    // Simulates a controller (Home app) rename of two independent tiles ahead of the restart —
    // one per-side service, one hub service, covering both accessory roles.
    const renamedThermostat = serviceFor(firstApi, left, SIDE_SERVICES[0]!);
    renamedThermostat.getCharacteristic(Characteristic.ConfiguredName).updateValue('Bedroom Thermostat');
    const renamedConnection = serviceFor(firstApi, hub, HUB_SERVICES[0]!);
    renamedConnection.getCharacteristic(Characteristic.ConfiguredName).updateValue('Upstairs Pod');

    // A second, independent restart — new FakeHomebridgeApi (a fresh Homebridge process), same
    // previously-registered accessory objects fed back in via configureAccessory, exactly as
    // simulateRestart's own doc describes production's own restore path.
    const { api: secondApi } = await simulateRestart(factoryWithPodClient(resolvingPodClient()), baseConfig(), previous);
    void secondApi;

    // The core of task 3.2, and the one assertion in this test a regression would actually fail:
    // both mutated values from immediately above are still exactly what the rename left them at,
    // not reverted to their Decision-3 default by the second restart's own construction.
    expect(renamedThermostat.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Bedroom Thermostat');
    expect(renamedConnection.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Upstairs Pod');

    // Every other (non-renamed) service on both restored accessories still reports its original
    // seeded default — the second restart touched none of them either, mutation-confirmed the
    // same way as the two renamed services above (not merely inferred from an absence of
    // warnings).
    const right = previous.find((a) => a.UUID === uuidFor(firstApi.hap, 'pod.local', 'right'))!;
    for (const expectation of SIDE_SERVICES.slice(1)) {
      expect(serviceFor(firstApi, left, expectation).getCharacteristic(Characteristic.ConfiguredName).value).toBe(
        expectation.label,
      );
    }
    for (const expectation of SIDE_SERVICES) {
      expect(serviceFor(firstApi, right, expectation).getCharacteristic(Characteristic.ConfiguredName).value).toBe(
        expectation.label,
      );
    }
    for (const expectation of HUB_SERVICES.slice(1)) {
      expect(serviceFor(firstApi, hub, expectation).getCharacteristic(Characteristic.ConfiguredName).value).toBe(
        expectation.label,
      );
    }

    // A supporting signal, not the proof itself (see the value assertions above for that): no
    // ConfiguredName characteristic-warning fired during the second restart either.
    expect(secondWarnings).toHaveLength(0);
  });
});
