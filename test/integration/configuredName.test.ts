/**
 * Whole-platform `ConfiguredName` coverage (release-polish tasks.md, Section 3) — the two things
 * no single service's own unit test can prove on its own:
 *
 *  - 3.1: constructing the full platform against a pre-#49 cached-accessory set (services
 *    present, no `ConfiguredName` on any of them — the exact shape a real upgrade restores from,
 *    design.md's Migration Plan) seeds every service's `ConfiguredName` to its Decision-3 default,
 *    with zero `characteristic-warning` events anywhere across the whole construction.
 *  - 3.2: a second restart — this time restoring accessories that already carry `ConfiguredName`,
 *    one of them at a controller-renamed value — never calls `setCharacteristic` on it again for
 *    any service: the tech-lead-required explicit "restore with a renamed value survives" case.
 *
 * Every optional hub/side service is config-enabled here (`primeSwitch`, `ledLightbulb`,
 * `testAlarmSwitch`, `serverFaultSensor`, `occupancySource: 'presence'`), so all thirteen
 * services this change touches are actually constructed and checked, not just the six that are
 * on by default.
 */
import { Characteristic } from '@homebridge/hap-nodejs';
import type { Service, WithUUID } from '@homebridge/hap-nodejs';
import { describe, expect, it } from 'vitest';

import type { API, Logging, PlatformConfig } from 'homebridge';

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
    // construction" — includes ThermostatService's own unrelated Target Temperature warning
    // (see test/services/configuredNameHelpers.ts's doc) were it to fire here too, since the
    // fixture used across this whole suite keeps every value in range; asserted unfiltered.
    expect(warnings).toHaveLength(0);
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

    expect(renamedThermostat.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Bedroom Thermostat');
    expect(renamedConnection.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Upstairs Pod');

    // Every other (non-renamed) service on both restored accessories still reports its original
    // seeded default — the second restart touched none of them either.
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

    // The core of task 3.2: none of this — restoring, re-checking every already-present
    // ConfiguredName, including the two renamed ones — ever calls setCharacteristic on it again.
    expect(secondWarnings).toHaveLength(0);
  });
});
