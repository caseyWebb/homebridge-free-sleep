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
import { describe, expect, it, vi } from 'vitest';

import type { PlatformConfig } from 'homebridge';

import { PodClient } from '../../src/pod/client.js';
import { FreeSleepPlatform } from '../../src/platform.js';
import { F_MAX, F_MIN, cToF, fToC } from '../../src/pod/temperature.js';
import { SettingsSchema } from '../../src/pod/types.js';
import { OCCUPANCY_SUBTYPE } from '../../src/services/occupancy.js';
import { PLATFORM_NAME } from '../../src/settings.js';
import {
  createFakeLogging,
  FakeHomebridgeApi,
  FakePlatformAccessory,
} from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createManualTimers, type ManualTimers } from '../manualTimers.js';
import { startMockPod, type MockPod } from '../mockPod.js';

/** Side accessory display names come from the mock's own `settings.json` fixture (via
 * `nameFor`'s settings-name-seeding), not a fallback — read them from the same fixture rather
 * than hardcoding a snapshot of its current values, which the `real-fixtures` change already
 * showed can legitimately change. */
const fixtureSettings = SettingsSchema.parse(loadFixture('settings.json'));
const LEFT_NAME = fixtureSettings.left.name;
const RIGHT_NAME = fixtureSettings.right.name;
const HUB_NAME = 'Pod';

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
      expect(names).toEqual([LEFT_NAME, HUB_NAME, RIGHT_NAME].sort());

      const left = accessoryByName(api, LEFT_NAME);
      const right = accessoryByName(api, RIGHT_NAME);
      const hub = accessoryByName(api, HUB_NAME);
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
      const left = accessoryByName(api, LEFT_NAME);
      const hap = api.hap;
      const service = left.getServiceById(hap.Service.Thermostat, 'thermostat')!;
      const targetTemp = service.getCharacteristic(hap.Characteristic.TargetTemperature);

      const degreesF = [66, 68, 70, 72, 74, 76];
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
      expect(body).not.toHaveProperty('isOn');
    } finally {
      await pod.close();
    }
  });

  // -------------------------------------------------------------------------------------
  // #14 — the full-range drag, racing a stale mid-drag observation
  // -------------------------------------------------------------------------------------

  it(
    'a 56-degree full-range drag, racing a stale mid-drag poll observation across a write-queue batch boundary, never snaps the published value backward',
    async () => {
      // `pollIntervalMs` cannot go below its 5000ms floor (config.ts's schema, matching
      // `poller.ts`'s own clamp) — this is also the smallest `writeMaxDebounceMs` cycle length
      // that still lets the drag span multiple batches without an unreasonably long test.
      // `ManualTimers.random()` is a fixed 0.5 (test/manualTimers.ts), so the poller's ±10%
      // jitter term is exactly zero — every poll fires at a deterministic virtual instant, which
      // is what makes injecting the stale reading at a precise moment below possible at all.
      const { pod, api, timers } = await bootSession({
        pollIntervals: { pollIntervalMs: 5000, writeMaxDebounceMs: 2000 },
      });
      try {
        const left = accessoryByName(api, LEFT_NAME);
        const hap = api.hap;
        const service = left.getServiceById(hap.Service.Thermostat, 'thermostat')!;
        const targetTemp = service.getCharacteristic(hap.Characteristic.TargetTemperature);
        const spy = vi.spyOn(targetTemp, 'updateValue');

        const degreesF: number[] = [];
        for (let f = F_MIN; f <= F_MAX; f++) degreesF.push(f);
        expect(degreesF).toHaveLength(56);

        const SPACING_MS = 100;
        const POLL_INTERVAL_MS = 5000;
        // The bootstrap poll fires at virtual t=0 (before any `advance()` call), so — with zero
        // jitter — the next scheduled `deviceStatus` poll fires at exactly t=5000, regardless of
        // how many intervening write dispatches call `requestMode` in the meantime (they all
        // recompute the same absolute fire time, since `pollIntervalMs` and the write path's
        // `fastPollIntervalMs` are both the 5000ms default). At 100ms spacing and a 2000ms
        // `writeMaxDebounceMs`, this lands exactly on the boundary between the drag's second and
        // third write-queue batches (batch 1 flushes at t=2000, batch 2 at t=4000) — every batch
        // up to that point has dispatched and settled (`test/manualTimers.ts`'s `advance()`
        // always drains to quiescence before returning), so the injected reading below cannot be
        // immediately overwritten by an in-flight dispatch of the plugin's own writes.
        const PAUSE_AFTER_WRITES = 40;
        // Outside 55-110 °F — distinct from every whole degree this drag itself ever writes,
        // simulating an external, disagreeing observation (e.g. the Pod's own touchscreen, or a
        // firmware anomaly) racing the drag.
        const STALE_F = 40;

        const pending: Array<Promise<unknown>> = [];
        for (let i = 0; i < degreesF.length; i++) {
          pending.push(targetTemp.handleSetRequest(fToC(degreesF[i]!)));
          await timers.advance(SPACING_MS);
          if (i + 1 === PAUSE_AFTER_WRITES) {
            expect(timers.now()).toBe(PAUSE_AFTER_WRITES * SPACING_MS);
            // Direct mutation of the mock's own state, bypassing its write-path validation
            // entirely (module doc: "no plugin policy... applies every write it is given") —
            // this is not a write this plugin performed, it is what a poll will observe next.
            pod.state.deviceStatus.left.targetTemperatureF = STALE_F;
            // Advance exactly to the deterministic poll instant computed above — nothing else is
            // due in this window (no batch is currently pending; the next write is submitted
            // only after this call returns), so this advance triggers exactly one event: the
            // stale-reading poll.
            await timers.advance(POLL_INTERVAL_MS - timers.now());
          }
        }
        // Flush and settle the drag's final batch (its own debounce/max-wait window).
        await timers.advance(2000);
        await Promise.all(pending);

        const posts = postDeviceStatusRequests(pod);
        // More than one POST — the drag spans more than one write-queue batch, unlike 8.4's
        // single-batch case.
        expect(posts.length).toBeGreaterThan(1);
        const lastBody = posts[posts.length - 1]!.left as Record<string, unknown>;
        expect(lastBody.targetTemperatureF).toBe(F_MAX);

        const finalValue = (await targetTemp.handleGetRequest()) as number;
        expect(finalValue).toBeCloseTo(fToC(F_MAX), 5);

        // Sanity: the stale-reading poll actually happened (bootstrap's GET, plus this one).
        const deviceStatusGets = pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/deviceStatus');
        expect(deviceStatusGets.length).toBeGreaterThanOrEqual(2);

        // The core guarantee: whatever the characteristic was pushed over the whole drag, it
        // never regressed, and it never carried the injected stale reading — the write queue's
        // optimistic overlay masks every disagreeing observation for its entire lifetime
        // (design.md's "#14" decision), so in practice this list is empty (every push the drag's
        // own writes would otherwise trigger is suppressed by the shadow claim, same as 8.4/5.1-
        // 5.2), but the assertion holds either way.
        const pushedDegreesF = spy.mock.calls.map(([value]) => Math.round(cToF(value as number)));
        expect(pushedDegreesF).not.toContain(STALE_F);
        for (let k = 1; k < pushedDegreesF.length; k++) {
          expect(pushedDegreesF[k]!).toBeGreaterThanOrEqual(pushedDegreesF[k - 1]!);
        }
      } finally {
        await pod.close();
      }
    },
    30_000,
  );
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
      const hub = accessoryByName(api, HUB_NAME);
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

      const left = accessoryByName(api, LEFT_NAME);
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
      const left = accessoryByName(api, LEFT_NAME);
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

// ---------------------------------------------------------------------------------------
// Occupancy change (#19): tasks.md 10.2 — one end-to-end scenario per source
// ---------------------------------------------------------------------------------------

describe('occupancy sensor end-to-end (tasks.md 10.2)', () => {
  it(
    "presence source: a transition posted into the mock's state flips OccupancyDetected within one presence-poll interval, and StatusActive only becomes true after it, never before",
    async () => {
      // `services.json`'s biometrics.enabled is already true, so this needs no override —
      // matching the seeded fixture is enough to let the presence class's `enabled` predicate
      // pass once `services` has been observed (already true by the bootstrap's own concurrent
      // poll of that class).
      const { pod, api, timers } = await bootSession({ occupancySource: 'presence' });
      try {
        const left = accessoryByName(api, LEFT_NAME);
        const hap = api.hap;
        const occupancyService = left.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)!;
        const occupancyDetected = occupancyService.getCharacteristic(hap.Characteristic.OccupancyDetected);
        const statusActive = occupancyService.getCharacteristic(hap.Characteristic.StatusActive);

        // One presence-poll interval (fixed 30s) past bootstrap: the fixture's own seeded
        // `present: false` is observed as this launch's baseline — not yet a proven transition.
        await timers.advance(30_000);
        expect(await occupancyDetected.handleGetRequest()).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
        expect(await statusActive.handleGetRequest()).toBe(false);

        // A real transition, posted directly into the mock's state (mirrors the stale-reading
        // injection technique above: this is what a poll will observe next, not a write this
        // plugin performed).
        pod.state.presence.left = { present: true, lastUpdatedAt: new Date(timers.now() + 1).toISOString() };
        await timers.advance(30_000);

        expect(await occupancyDetected.handleGetRequest()).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
        expect(await statusActive.handleGetRequest()).toBe(true);
      } finally {
        await pod.close();
      }
    },
    15_000,
  );

  it(
    'vitals source: a fresh row flips occupancy within one vitals-poll interval, and StatusActive becomes true on the very first row',
    async () => {
      const { pod, api, timers } = await bootSession({ occupancySource: 'vitals' });
      try {
        const left = accessoryByName(api, LEFT_NAME);
        const hap = api.hap;
        const occupancyService = left.getServiceById(hap.Service.OccupancySensor, OCCUPANCY_SUBTYPE)!;
        const occupancyDetected = occupancyService.getCharacteristic(hap.Characteristic.OccupancyDetected);
        const statusActive = occupancyService.getCharacteristic(hap.Characteristic.StatusActive);

        // S3 dropped `endTime` from the vitals query — the Pod itself now bounds the window's
        // upper edge at its own "now" — so the fixture's seeded rows (real 2026 timestamps) can
        // no longer be relied on to fall outside the window purely because they're newer than
        // this test's virtual clock (which starts at the Unix epoch): with no upper bound sent,
        // a `startTime`-only filter would consider those far-future-relative-to-epoch rows
        // "recent". Clear seeded vitals explicitly so the baseline is genuinely empty.
        pod.state.vitals = [];

        // One vitals-poll interval (fixed 60s) past bootstrap: no rows yet — not yet proven,
        // matching that the *vitals* rule's own asymmetry ("no requirement to observe a
        // change") is not an exemption from ever needing a real row at all.
        await timers.advance(60_000);
        expect(await occupancyDetected.handleGetRequest()).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
        expect(await statusActive.handleGetRequest()).toBe(false);

        // A fresh row, timestamped against this test's own virtual clock so it falls inside the
        // next poll's recent window, posted directly into the mock's state.
        pod.state.vitals = [
          { id: 99, side: 'left', timestamp: new Date(timers.now()).toISOString(), heart_rate: 65, hrv: 40, breathing_rate: 14 },
        ];
        await timers.advance(60_000);

        expect(await occupancyDetected.handleGetRequest()).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
        // Proven on the very first row — no "wait for a change across two readings" requirement,
        // unlike the presence source above (design.md's asymmetry).
        expect(await statusActive.handleGetRequest()).toBe(true);
      } finally {
        await pod.close();
      }
    },
    15_000,
  );
});
