/**
 * Full-stack away-mode-guard tests (tasks.md group 4, adapted): `FreeSleepPlatform` ->
 * `ThermostatService` -> `WriteQueue` (consulting its injected `AwayModeGuard` at dispatch,
 * tech-lead resolution 2) -> `PodClient` -> `test/mockPod.ts`, driven through HAP's real
 * `handleSetRequest` (matching `test/integration/session.test.ts`'s own convention) so the
 * mock Pod is the oracle for the both-sides mirroring semantics the away-mode-guard spec
 * describes.
 *
 * Adaptation note (tech-lead resolution 2): tasks.md 4.1 originally named the call chain as
 * "... -> ThermostatService -> AwayModeGuard -> WriteQueue -> ...", i.e. a separate hop through
 * a guard wrapper. There is no such hop any more — `ThermostatService` calls
 * `ctx.writeQueue.submitSide` exactly as it always did, and `WriteQueue` itself consults the
 * guard internally at dispatch. This file exercises that collapsed chain end to end.
 *
 * Time is driven through `ManualTimers`, never `vi.useFakeTimers()` — see
 * `test/manualTimers.ts`'s own module doc for why (a real `node:http` mock Pod is involved).
 */
import { describe, expect, it } from 'vitest';

import type { PlatformConfig } from 'homebridge';

import { PodClient } from '../src/pod/client.js';
import { FreeSleepPlatform } from '../src/platform.js';
import { SettingsSchema } from '../src/pod/types.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { createFakeLogging, FakeHomebridgeApi, type FakePlatformAccessory } from './fakeHomebridgeApi.js';
import { loadFixture } from './loadFixture.js';
import { createManualTimers, type ManualTimers } from './manualTimers.js';
import { startMockPod, type MockPod, type StartMockPodOptions } from './mockPod.js';

const fixtureSettings = SettingsSchema.parse(loadFixture('settings.json'));
const LEFT_NAME = fixtureSettings.left.name;
const RIGHT_NAME = fixtureSettings.right.name;

function clientFor(pod: MockPod): PodClient {
  const { hostname, port } = new URL(pod.url);
  return new PodClient({ host: hostname, port: Number(port) });
}

function baseConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return { platform: PLATFORM_NAME, host: 'pod.local', ...overrides };
}

interface Session {
  pod: MockPod;
  api: FakeHomebridgeApi;
  timers: ManualTimers;
}

async function bootSession(
  podOptions: StartMockPodOptions = {},
  configOverrides: Record<string, unknown> = {},
): Promise<Session> {
  const pod = await startMockPod(podOptions);
  const timers = createManualTimers();
  const client = clientFor(pod);
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  new FreeSleepPlatform(log, baseConfig(configOverrides), api.asApi(), client, timers);
  await api.fireDidFinishLaunching();
  return { pod, api, timers };
}

function accessoryByName(api: FakeHomebridgeApi, name: string): FakePlatformAccessory {
  const accessory = api.registeredAccessories.find((a) => a.displayName === name);
  if (!accessory) throw new Error(`no registered accessory named ${name}`);
  return accessory;
}

function postDeviceStatusRequests(pod: MockPod): Array<Record<string, unknown>> {
  return pod.requests
    .filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus')
    .map((r) => r.body as Record<string, unknown>);
}

// ---------------------------------------------------------------------------------------
// 4.1 — a blocked write never reaches the Pod
// ---------------------------------------------------------------------------------------

describe("'block' policy: a write attempted while the other side is away (4.1)", () => {
  it('is rejected before dispatch, the Pod receives nothing for it, and the away side is unaffected', async () => {
    const { pod, api, timers } = await bootSession(
      { state: { settings: { left: { awayMode: true } } } },
      { awayModeWritePolicy: 'block' },
    );
    try {
      const right = accessoryByName(api, RIGHT_NAME);
      const hap = api.hap;
      const service = right.getServiceById(hap.Service.Thermostat, 'thermostat')!;
      const targetTemp = service.getCharacteristic(hap.Characteristic.TargetTemperature);

      const beforeRequests = pod.requests.length;
      // Not awaited immediately: the write settles only once the debounce timer fires and the
      // guard's dispatch-time decision runs, and `ManualTimers` never advances on its own — see
      // `test/manualTimers.ts`'s module doc and `test/integration/session.test.ts`'s own
      // slider-drag test for the same kick-off-then-advance-then-await shape.
      const pending = targetTemp.handleSetRequest(((75 - 32) * 5) / 9);
      const assertion = expect(pending).rejects.toBe(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      await timers.advance(1000);
      await assertion;

      // No new request of any kind reached the Pod for this write.
      expect(pod.requests.length).toBe(beforeRequests);
      expect(postDeviceStatusRequests(pod)).toHaveLength(0);
      expect(pod.state.deviceStatus.left.targetTemperatureF).not.toBe(75);
      expect(pod.state.deviceStatus.right.targetTemperatureF).not.toBe(75);
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 4.2 — a mirrored write updates both sides' cached view
// ---------------------------------------------------------------------------------------

describe("'mirror' policy (the default): a write attempted while the other side is away (4.2)", () => {
  it("reaches the Pod for the addressed side, and the other side's own thermostat reflects the change without a separate poll", async () => {
    const { pod, api, timers } = await bootSession({ state: { settings: { left: { awayMode: true } } } });
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const right = accessoryByName(api, RIGHT_NAME);
      const hap = api.hap;
      const rightTargetTemp = right
        .getServiceById(hap.Service.Thermostat, 'thermostat')!
        .getCharacteristic(hap.Characteristic.TargetTemperature);
      const leftTargetTemp = left
        .getServiceById(hap.Service.Thermostat, 'thermostat')!
        .getCharacteristic(hap.Characteristic.TargetTemperature);

      const targetF = 79;
      const pending = rightTargetTemp.handleSetRequest(((targetF - 32) * 5) / 9);
      await timers.advance(1000); // past the 400ms debounce, and past the mirror's own real POST
      await pending;

      // The Pod's own controlBothSides mirroring, plus this plugin's own guard-driven mirror,
      // both applied the same physical effect — the mock's own state is the joint oracle.
      expect(pod.state.deviceStatus.left.targetTemperatureF).toBe(targetF);
      expect(pod.state.deviceStatus.right.targetTemperatureF).toBe(targetF);

      // Without a separate poll or read, the left thermostat's own cached view already reports
      // the mirrored value (away-mode-guard spec, "without waiting for a poll").
      expect(await leftTargetTemp.handleGetRequest()).toBeCloseTo(((targetF - 32) * 5) / 9, 1);
      expect(await rightTargetTemp.handleGetRequest()).toBeCloseTo(((targetF - 32) * 5) / 9, 1);
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 4.3 — either side being away is sufficient, symmetrically
// ---------------------------------------------------------------------------------------

describe('either side being away triggers the policy identically (4.3)', () => {
  it('right-away + left-write is blocked exactly like left-away + right-write', async () => {
    const { pod, api, timers } = await bootSession(
      { state: { settings: { right: { awayMode: true } } } },
      { awayModeWritePolicy: 'block' },
    );
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const hap = api.hap;
      const targetTemp = left
        .getServiceById(hap.Service.Thermostat, 'thermostat')!
        .getCharacteristic(hap.Characteristic.TargetTemperature);

      const pending = targetTemp.handleSetRequest(((71 - 32) * 5) / 9);
      const assertion = expect(pending).rejects.toBe(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      await timers.advance(1000);
      await assertion;
      expect(postDeviceStatusRequests(pod)).toHaveLength(0);
    } finally {
      await pod.close();
    }
  });

  it('both sides away blocks a write to either side too', async () => {
    const { pod, api, timers } = await bootSession(
      { state: { settings: { left: { awayMode: true }, right: { awayMode: true } } } },
      { awayModeWritePolicy: 'block' },
    );
    try {
      const right = accessoryByName(api, RIGHT_NAME);
      const hap = api.hap;
      const targetTemp = right
        .getServiceById(hap.Service.Thermostat, 'thermostat')!
        .getCharacteristic(hap.Characteristic.TargetTemperature);

      const pending = targetTemp.handleSetRequest(((71 - 32) * 5) / 9);
      const assertion = expect(pending).rejects.toBe(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      await timers.advance(1000);
      await assertion;
      expect(postDeviceStatusRequests(pod)).toHaveLength(0);
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 4.5 — the zero-cost common path, at the full-stack level
// ---------------------------------------------------------------------------------------

describe('neither side away leaves a write untouched, end to end (4.5)', () => {
  it('a single setpoint write produces exactly one POST /api/deviceStatus, with no extra away-mode traffic', async () => {
    const { pod, api, timers } = await bootSession();
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const hap = api.hap;
      const targetTemp = left
        .getServiceById(hap.Service.Thermostat, 'thermostat')!
        .getCharacteristic(hap.Characteristic.TargetTemperature);

      const before = postDeviceStatusRequests(pod).length;
      const pending = targetTemp.handleSetRequest(((73 - 32) * 5) / 9);
      await timers.advance(1000);
      await pending;

      expect(postDeviceStatusRequests(pod).length - before).toBe(1);
    } finally {
      await pod.close();
    }
  });
});
