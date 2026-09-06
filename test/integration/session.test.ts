/**
 * The M2 exit gate (proposal.md, "An in-process integration test"; specs/platform/spec.md, "A
 * simulated Home-app session against a mock Pod stays within its request budget"): boots the
 * whole platform — configuration, accessories, services, poller and write queue — against the
 * stateful mock Pod through the fake Homebridge API, with real HTTP and a virtual clock
 * (design.md, "The integration test: real HTTP, virtual clock").
 *
 * Time is driven through `ManualTimers`, never `vi.useFakeTimers()` — the mock Pod is a real
 * `node:http` server reached over real sockets, and freezing the global timer set would freeze
 * undici's own internals along with the poller's (`test/manualTimers.ts`'s module doc).
 */
import { describe, expect, it } from 'vitest';

import type { PlatformConfig } from 'homebridge';

import { PodClient } from '../../src/pod/client.js';
import { FreeSleepPlatform } from '../../src/platform.js';
import { PLATFORM_NAME } from '../../src/settings.js';
import {
  createFakeLogging,
  FakeHomebridgeApi,
  FakePlatformAccessory,
} from '../fakeHomebridgeApi.js';
import { createManualTimers, type ManualTimers } from '../manualTimers.js';
import { startMockPod, type MockPod } from '../mockPod.js';

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
  platform: FreeSleepPlatform;
}

async function bootSession(overrides: Record<string, unknown> = {}): Promise<Session> {
  const pod = await startMockPod();
  const timers = createManualTimers();
  const client = clientFor(pod);
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const platform = new FreeSleepPlatform(log, baseConfig(overrides), api.asApi(), client, timers);
  await api.fireDidFinishLaunching();
  return { pod, api, timers, platform };
}

function accessoryByName(api: FakeHomebridgeApi, name: string): FakePlatformAccessory {
  const accessory = api.registeredAccessories.find((a) => a.displayName === name);
  if (!accessory) throw new Error(`no registered accessory named ${name}`);
  return accessory;
}

/** Reads every characteristic of every service (skipping `AccessoryInformation`, which is not
 * this change's concern) on every published accessory, through HAP's own real, asynchronous
 * `handleGetRequest` — the same path a real HomeKit controller's read burst takes. Fails the
 * test immediately if any read rejects. */
async function readEveryCharacteristic(api: FakeHomebridgeApi): Promise<void> {
  const infoUuid = api.hap.Service.AccessoryInformation.UUID;
  for (const accessory of api.registeredAccessories) {
    for (const service of accessory.services) {
      if (service.UUID === infoUuid) continue;
      for (const characteristic of service.characteristics) {
        await characteristic.handleGetRequest();
      }
    }
  }
}

function postDeviceStatusRequests(pod: MockPod): Array<Record<string, unknown>> {
  return pod.requests
    .filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus')
    .map((r) => r.body as Record<string, unknown>);
}

// ---------------------------------------------------------------------------------------
// 8.2 — the harness itself
// ---------------------------------------------------------------------------------------

describe('session harness (8.2)', () => {
  it('publishes three accessories with their expected services, and the mock recorded exactly the bootstrap requests', async () => {
    const { pod, api } = await bootSession();
    try {
      expect(api.registeredAccessories).toHaveLength(3);
      const names = api.registeredAccessories.map((a) => a.displayName).sort();
      expect(names).toEqual(['Left side', 'Pod', 'Right side']);

      const left = accessoryByName(api, 'Left side');
      const right = accessoryByName(api, 'Right side');
      const hub = accessoryByName(api, 'Pod');
      expect(left.services.some((s) => s.UUID === api.hap.Service.Thermostat.UUID)).toBe(true);
      expect(right.services.some((s) => s.UUID === api.hap.Service.Thermostat.UUID)).toBe(true);
      expect(hub.services.some((s) => s.UUID === api.hap.Service.ContactSensor.UUID)).toBe(true);

      // Bootstrap polls all four endpoint classes exactly once each; nothing else has happened
      // yet.
      const paths = pod.requests.map((r) => `${r.method} ${r.path}`).sort();
      expect(paths).toEqual([
        'GET /api/deviceStatus',
        'GET /api/schedules',
        'GET /api/services',
        'GET /api/settings',
      ]);
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 8.3 — the read-burst guardrail
// ---------------------------------------------------------------------------------------

describe('read-burst guardrail (8.3)', () => {
  it('reading every characteristic at t=0 and again at t=60s costs nothing beyond the bootstrap', async () => {
    const { pod, api, timers } = await bootSession();
    try {
      const beforeFirstBurst = pod.requests.length;
      await readEveryCharacteristic(api);
      expect(pod.requests.length).toBe(beforeFirstBurst);

      await timers.advance(60_000);

      const beforeSecondBurst = pod.requests.length;
      await readEveryCharacteristic(api);
      expect(pod.requests.length).toBe(beforeSecondBurst);
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 8.4 — the slider-drag guardrail
// ---------------------------------------------------------------------------------------

describe('slider-drag guardrail (8.4)', () => {
  it('six TargetTemperature writes 50ms apart produce exactly one POST carrying the last degree, and all six resolve', async () => {
    const { pod, api, timers } = await bootSession();
    try {
      const left = accessoryByName(api, 'Left side');
      const hap = api.hap;
      const service = left.getServiceById(hap.Service.Thermostat, 'thermostat')!;
      const targetTemp = service.getCharacteristic(hap.Characteristic.TargetTemperature);

      const degreesF = [66, 68, 70, 72, 74, 76];
      const cToF = (c: number): number => (c * 9) / 5 + 32;
      const fToC = (f: number): number => ((f - 32) * 5) / 9;

      const pending: Array<Promise<unknown>> = [];
      for (const f of degreesF) {
        pending.push(targetTemp.handleSetRequest(fToC(f)));
        await timers.advance(50);
      }
      await timers.advance(1000); // past the 400ms debounce

      await Promise.all(pending);

      const posts = postDeviceStatusRequests(pod);
      expect(posts).toHaveLength(1);
      const body = posts[0]!.left as Record<string, unknown>;
      expect(body.targetTemperatureF).toBe(76);
      void cToF;
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 8.5 — the outage guardrail
// ---------------------------------------------------------------------------------------

describe('outage guardrail (8.5)', () => {
  it('an outage spanning several poll intervals flips the connection sensor exactly twice, with every read serving a value throughout', async () => {
    // A small, bounded backoff cap keeps poll cadence predictable (5s, then 10s thereafter),
    // so a 10-request fault budget reliably spans several failed polls before the mock's own
    // "after N faulty responses, normal behaviour resumes" semantics (test/mockPod.ts) let
    // recovery happen — each failed poll costs PodClient's own real (un-fakeable) retry, so
    // several of them comfortably exceed vitest's default 5s test timeout.
    const { pod, api, timers } = await bootSession({
      pollIntervals: { pollIntervalMs: 5000, maxBackoffMs: 10_000 },
    });
    try {
      const hub = accessoryByName(api, 'Pod');
      const hap = api.hap;
      const connectionService = hub.getServiceById(hap.Service.ContactSensor, 'connection')!;
      const contactState = connectionService.getCharacteristic(hap.Characteristic.ContactSensorState);

      const observedStates: number[] = [contactState.value as number];
      const originalUpdateValue = contactState.updateValue.bind(contactState);
      contactState.updateValue = ((value: unknown) => {
        observedStates.push(value as number);
        return originalUpdateValue(value as never);
      }) as typeof contactState.updateValue;

      expect(contactState.value).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

      // Destroy the connection for enough requests to span several 5s poll intervals: each
      // failed poll costs PodClient one retry (two requests), so 10 spans ~5 failed polls.
      pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 10 });
      await timers.advance(40_000);

      expect(contactState.value).toBe(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

      // Every read during the outage must still serve a last-known value, never throw.
      await expect(readEveryCharacteristic(api)).resolves.toBeUndefined();

      const left = accessoryByName(api, 'Left side');
      const targetTemp = left.getServiceById(hap.Service.Thermostat, 'thermostat')!.getCharacteristic(hap.Characteristic.TargetTemperature);
      expect(await targetTemp.handleGetRequest()).not.toBeNull();

      // Let it recover — the fault budget is exhausted well within this window.
      await timers.advance(40_000);
      expect(contactState.value).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);

      // Exactly two transitions across the whole outage: DETECTED (initial, not counted as a
      // push) -> NOT_DETECTED -> DETECTED.
      expect(observedStates).toEqual([
        hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
        hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
      ]);
    } finally {
      await pod.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// 8.6 — offline-then-escalate
// ---------------------------------------------------------------------------------------

describe('offline-then-escalate (8.6)', () => {
  it('reads throw past noResponseAfterMs, and the very next read after recovery succeeds', async () => {
    const { pod, api, timers } = await bootSession({
      pollIntervals: { pollIntervalMs: 5000, maxBackoffMs: 10_000 },
      noResponseAfterMs: 30_000,
    });
    try {
      const left = accessoryByName(api, 'Left side');
      const hap = api.hap;
      const targetTemp = left
        .getServiceById(hap.Service.Thermostat, 'thermostat')!
        .getCharacteristic(hap.Characteristic.TargetTemperature);

      // 10 requests spans 5 failed polls (2 requests each, given the retry) before the mock's
      // own "after N faulty responses, normal behaviour resumes" semantics let the 6th succeed —
      // comfortably past noResponseAfterMs (30s) at the first checkpoint below, and comfortably
      // recovered by the second.
      pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 10 });
      // Past noResponseAfterMs (30s), continuously unreachable.
      await timers.advance(45_000);

      // `handleGetRequest` unwraps a thrown `HapStatusError` to its raw `.hapStatus` number
      // before rejecting (hap-nodejs's own `Characteristic.handleGetRequest`) — not the error
      // object itself.
      await expect(targetTemp.handleGetRequest()).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

      // Let the mock recover — the very next poll should succeed and clear the escalation.
      await timers.advance(10_000);

      const value = await targetTemp.handleGetRequest();
      expect(value).not.toBeNull();
    } finally {
      await pod.close();
    }
  }, 30_000);
});
