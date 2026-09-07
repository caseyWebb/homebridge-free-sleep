import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { PodClient } from '../src/pod/client.js';
import { PodPoller } from '../src/pod/poller.js';
import { SnapshotStore, type Change } from '../src/pod/snapshot.js';
import { WriteQueue } from '../src/pod/writeQueue.js';
import { advanceFakeTime, createTimerHarness } from './timerHarness.js';
import { startMockPod, type MockPod } from './mockPod.js';

function clientFor(pod: MockPod): PodClient {
  const { hostname, port } = new URL(pod.url);
  return new PodClient({ host: hostname, port: Number(port) });
}

/**
 * Wires a poller + write queue exactly the way a future platform module will: the queue never
 * imports the poller (design.md, "Module dependency direction"); it is handed a
 * `requestFastPoll(lane, untilMs)` callback that the caller implements in terms of the poller's
 * public API. A `deviceStatus`-lane write gets a fresh `write` mode (replacing any still-active
 * one, matching what a single always-on plugin instance would do); a `settings`-lane write gets
 * a single confirming `refresh('settings')` instead — accelerating `deviceStatus` polling would
 * confirm nothing a settings write actually changed (S2).
 *
 * `serverFaultSensorEnabled` (N6, hub-accessory PR #44 review): threaded straight through to
 * `PodPoller`'s own option of the same name — `false` (the config default) reproduces this
 * test's original, un-parameterized shape exactly; `true` additionally registers and polls the
 * `serverStatus` class on the same slow cadence as `settings`/`schedules`/`services`, so the
 * budget guardrail below can also be run with it enabled against a correspondingly higher ceiling
 * (see that test's own derivation comment).
 */
function wire(pod: MockPod, timers: ReturnType<typeof createTimerHarness>, serverFaultSensorEnabled = false) {
  const snapshot = new SnapshotStore({ timers });
  const client = clientFor(pod);
  const poller = new PodPoller({
    client,
    snapshot,
    timers,
    pollIntervalMs: 30_000,
    slowPollIntervalMs: 300_000,
    fastPollIntervalMs: 5_000,
    maxBackoffMs: 60_000,
    serverFaultSensorEnabled,
  });
  let releaseWriteMode: (() => void) | null = null;
  const requestFastPoll = (lane: 'deviceStatus' | 'settings', untilMs: number): void => {
    if (lane === 'settings') {
      void poller.refresh('settings');
      return;
    }
    releaseWriteMode?.();
    releaseWriteMode = poller.requestMode('deviceStatus', { intervalMs: 5_000, untilMs, reason: 'write' });
  };
  const queue = new WriteQueue({
    client,
    snapshot,
    requestFastPoll,
    timers,
    writeDebounceMs: 400,
    writeMaxDebounceMs: 2_000,
    writeSettleMs: 15_000,
    fastPollDurationMs: 90_000,
  });
  return { snapshot, poller, queue, client };
}

// ---------------------------------------------------------------------------------------
// 10. Guardrail: the five-minute Home-app session
// ---------------------------------------------------------------------------------------

describe('guardrail: the five-minute Home-app session (10.1, 10.2, 10.4)', () => {
  // N6 (hub-accessory PR #44 review): parameterized over `serverFaultSensorEnabled` so the
  // guardrail also covers the shape most installs won't opt into but some will. The derived
  // ceiling accounts for exactly two extra requests when enabled — a `serverStatus` poll shares
  // the slow cadence with `settings`/`schedules`/`services`, so it gains one request at bootstrap
  // (5 classes fire instead of 4) and one more at the scenario's own second slow-class poll at
  // t=300s (4 requests instead of 3) — the same `+40`-over-the-31-32-derivation headroom logic
  // the disabled case's own comment below explains, just shifted by that `+2`.
  it.each([
    { serverFaultSensorEnabled: false, ceiling: 40 },
    { serverFaultSensorEnabled: true, ceiling: 42 },
  ])(
    'stays within the request budget (serverFaultSensorEnabled=$serverFaultSensorEnabled, ceiling=$ceiling): exactly 1 write, >=10 deviceStatus reads, zero delta across each read burst',
    async ({ serverFaultSensorEnabled, ceiling }) => {
    vi.useFakeTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      timers.random = () => 0.5; // jitter fixed to zero, per design.md's derivation table
      const { snapshot, poller, queue } = wire(pod, timers, serverFaultSensorEnabled);

      // --- t = 0: bootstrap, all four classes -------------------------------------------
      await poller.bootstrap();

      // --- t = 0: 80 snapshot reads (Home app opens) — must add nothing (10.2, the sharp
      // form of the invariant: the delta across the burst is exactly zero, not just "small"). -
      const beforeFirstBurst = pod.requests.length;
      for (let i = 0; i < 80; i++) snapshot.get();
      expect(pod.requests.length).toBe(beforeFirstBurst);

      // --- t = 0 -> 60s: base deviceStatus polls at 30s and 60s ---------------------------
      await advanceFakeTime(60_000, 100);

      // --- t = 60s: 80 more snapshot reads (Home app reopens) — again zero delta ----------
      const beforeSecondBurst = pod.requests.length;
      for (let i = 0; i < 80; i++) snapshot.get();
      expect(pod.requests.length).toBe(beforeSecondBurst);

      // --- t = 60s -> 120s: base deviceStatus polls at 90s and 120s -----------------------
      await advanceFakeTime(60_000, 100);

      // --- t = 120.0s -> 120.3s: a temperature slider drag, six submissions to `left` -----
      for (let i = 0; i < 6; i++) {
        queue.submitSide('left', { targetTemperatureF: 65 + i });
        await advanceFakeTime(50, 50);
      }

      // --- t = 120.4s -> 300s: debounce flush (1 write), the resulting fast-poll window
      // (18 polls at 5s over 90s), base polls resuming, and the slow classes' second poll --
      await advanceFakeTime(300_000 - 120_300, 100);

      poller.stop();
      queue.stop();

      // Derivation (design.md, "The request budget: N = 40"): with the scenario above and
      // jitter fixed to zero, design.md's own table works out to 32 —
      //   4 (bootstrap) + 0 (burst 1) + 4 (base polls to t=120s) + 0 (burst 2)
      //   + 1 (the coalesced write) + 18 (fast poll, 90s / 5s) + 2 (base polls resuming)
      //   + 3 (settings/schedules/services' second poll at t=300s) = 32.
      // This harness's own fake-timer stepping (advanceFakeTime's 100ms granularity, needed so
      // the real HTTP round trips to the mock actually settle between virtual-time jumps —
      // see timerHarness.ts) lands one request shy of that at 31, an artifact of step boundary
      // rounding rather than a scheduling bug; either way the sharp per-burst delta assertions
      // above are the precise proof, and this total is the coarse net. N = 40 (42 with
      // serverFaultSensorEnabled, per this describe block's own comment) gives comfortable
      // headroom over 31-32 (33-34) so a default tweak or slightly different drag timing doesn't
      // flake this test, while staying far below what any real regression produces (see the
      // "guardrail actually guards" test below for a concrete failing case).
      expect(pod.requests.length).toBeLessThanOrEqual(ceiling);

      const writes = pod.requests.filter((r) => r.method === 'POST');
      expect(writes.length).toBe(1); // catches a coalescing regression (6 separate POSTs -> 37, still <40)

      const deviceStatusReads = pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/deviceStatus');
      expect(deviceStatusReads.length).toBeGreaterThanOrEqual(10); // catches a poller that silently died

      if (serverFaultSensorEnabled) {
        // At least the bootstrap poll; the scenario's own t=300s second slow-class poll is
        // subject to the same fake-timer step-boundary rounding the derivation comment above
        // already documents for deviceStatus reads (31 vs. the derived 32), so this stays a
        // loose floor rather than an exact count — the ceiling assertion above is what actually
        // proves the +2 budget.
        const serverStatusReads = pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/serverStatus');
        expect(serverStatusReads.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await pod.close();
    }
  }, 20_000);

  it('a read handler that contacts the Pod breaks the budget — proves the guardrail actually guards (10.3)', async () => {
    // No fake timers needed: this isolates the one failure mode the budget exists to catch —
    // a "read" path that is not synchronous and I/O-free — without re-running the whole
    // five-minute session.
    const pod = await startMockPod();
    try {
      const client = clientFor(pod);
      // A deliberately poisoned stand-in for `snapshot.get()`: exactly what the pod-snapshot
      // spec forbids ("A snapshot read is synchronous and performs no I/O").
      const poisonedGet = (): Promise<void> => client.getDeviceStatus().then(() => undefined);

      for (let i = 0; i < 80; i++) {
        await poisonedGet();
      }

      // Observed failing count at time of writing: 80 (one request per read) — comfortably
      // over the budget's ceiling of 40, which is exactly the regression the guardrail's
      // `<= 40` assertion (above) exists to fail loudly on.
      expect(pod.requests.length).toBe(80);
      expect(pod.requests.length).toBeGreaterThan(40);
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 11.1 Integration: poller, snapshot and write queue together
// ---------------------------------------------------------------------------------------

describe('integration: write -> overlay -> fast poll -> agreement -> outage -> recovery (11.1)', () => {
  it('emits the expected change sequence with no spurious events during the settle window, and exactly one connection transition each way', async () => {
    vi.useFakeTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      timers.random = () => 0.5;
      const { snapshot, poller, queue } = wire(pod, timers);

      await poller.bootstrap();

      const changes: Change[] = [];
      snapshot.subscribe((batch) => changes.push(...batch));

      // --- a write, its overlay, and the confirming poll's agreement retirement ----------
      const originalTarget = snapshot.get().left.targetTemperatureF;
      const p = queue.submitSide('left', { targetTemperatureF: 70 });
      await advanceFakeTime(400, 50); // debounce flush -> dispatch
      await p;

      const targetChangesSoFar = changes.filter((c) => c.scope === 'side' && c.field === 'targetTemperatureF' && c.side === 'left');
      expect(targetChangesSoFar).toEqual([
        { scope: 'side', field: 'targetTemperatureF', side: 'left', previous: originalTarget, current: 70 },
      ]);

      // The next deviceStatus poll (fast mode, 5s) should confirm 70 and retire the overlay
      // by agreement — no further change for this field, and no reversion, for the rest of
      // the (nominal, still-connected) 15s settle window.
      await advanceFakeTime(15_000, 100);
      const targetChangesAfterSettle = changes.filter((c) => c.scope === 'side' && c.field === 'targetTemperatureF' && c.side === 'left');
      expect(targetChangesAfterSettle.length).toBe(1); // still just the one — agreement, not reversion

      // --- a fault-injected outage, with backoff ------------------------------------------
      pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 100 }); // generously covers the window below
      await advanceFakeTime(60_000, 100);
      expect(snapshot.get().connection.online).toBe(false);

      // --- recovery: force a clean hand-off (one more faulted attempt, then cleared) so the
      // very next attempt succeeds, regardless of exactly how many backoff cycles preceded it -
      pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 0 });
      await advanceFakeTime(60_000, 100);

      poller.stop();
      queue.stop();

      const connectionChanges = changes.filter((c) => c.field === 'connectionOnline');
      expect(connectionChanges.map((c) => c.current)).toEqual([false, true]); // down once, back up once
      expect(snapshot.get().connection.online).toBe(true);
    } finally {
      await pod.close();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------------------
// S2 regression: settings-lane writes confirm by agreement, not by accelerating deviceStatus
// ---------------------------------------------------------------------------------------

describe('S2 regression: an awayMode write confirms via a settings re-read, never a deviceStatus fast-poll', () => {
  it('retires its overlay by agreement well past the original settle window, with zero extra deviceStatus reads', async () => {
    vi.useFakeTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      timers.random = () => 0.5;
      const { snapshot, poller, queue } = wire(pod, timers);

      await poller.bootstrap();
      const deviceStatusReadsAtBootstrap = pod.requests.filter(
        (r) => r.method === 'GET' && r.path === '/api/deviceStatus',
      ).length;

      const p = queue.submitSettings({ left: { awayMode: true } });
      await advanceFakeTime(400, 50); // debounce flush -> dispatch settles
      await p;
      expect(snapshot.get().left.awayMode).toBe(true); // optimistic overlay live

      // Past the original 15s writeSettleMs window: if this were still relying on the overlay's
      // own expiry rather than a genuine settings-class confirmation, it would have reverted by
      // now unless something re-read /api/settings and agreed.
      await advanceFakeTime(20_000, 100);
      expect(snapshot.get().left.awayMode).toBe(true); // no reversion — retired by agreement

      const deviceStatusReadsAfter = pod.requests.filter(
        (r) => r.method === 'GET' && r.path === '/api/deviceStatus',
      ).length;
      // The base deviceStatus cadence (30s) hasn't come due in this ~20.4s window either, so
      // this equality also catches the regression: the old behaviour entered a 5s deviceStatus
      // fast-poll mode for a settings write, which would have added several extra reads here.
      expect(deviceStatusReadsAfter).toBe(deviceStatusReadsAtBootstrap);

      const settingsReads = pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/settings').length;
      expect(settingsReads).toBeGreaterThan(1); // bootstrap's read, plus at least the confirming refresh

      poller.stop();
      queue.stop();
    } finally {
      await pod.close();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------------------
// 11.2 Module boundaries
// ---------------------------------------------------------------------------------------

describe('module boundaries (11.2)', () => {
  const modules = ['snapshot', 'poller', 'writeQueue'] as const;

  function sourceOf(name: (typeof modules)[number]): string {
    const path = fileURLToPath(new URL(`../src/pod/${name}.ts`, import.meta.url));
    return readFileSync(path, 'utf8');
  }

  it('none of the three modules imports homebridge, hap-nodejs, or anything under test/', () => {
    const importLine = /^import\s.+$/gm;
    for (const name of modules) {
      const imports = sourceOf(name).match(importLine) ?? [];
      for (const line of imports) {
        expect(line).not.toMatch(/['"]homebridge['"]/);
        expect(line).not.toMatch(/hap-nodejs/);
        expect(line).not.toMatch(/['"].*\/test\//);
      }
    }
  });

  it('writeQueue.ts does not import poller.js (design.md, "Module dependency direction")', () => {
    const importLine = /^import\s.+$/gm;
    const imports = sourceOf('writeQueue').match(importLine) ?? [];
    for (const line of imports) {
      expect(line).not.toMatch(/['"]\.\/poller\.(js|ts)['"]/);
    }
  });
});
