/**
 * `KeepAlive` (`src/pod/keepAlive.ts`) — issue #12, `pod-keep-alive` spec.
 *
 * Every test here drives a real `WriteQueue` against a `FakePodClient` (writeQueue.test.ts's own
 * convention for pure-logic tests) so a re-arm's actual dispatched body is verified end-to-end,
 * not merely that `submitSide` was called with the right arguments. Fake timers throughout —
 * `KeepAlive` and `WriteQueue` share one `TimerHarness`, so a single `vi.advanceTimersByTimeAsync`
 * call both fires a due check tick and lets that tick's own `submitSide` debounce (400ms,
 * comfortably inside every check interval used below) flush and dispatch within the same call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PodClient } from '../src/pod/client.js';
import { KeepAlive } from '../src/pod/keepAlive.js';
import { SnapshotStore } from '../src/pod/snapshot.js';
import type { DeviceStatus, Schedules, Services, Settings } from '../src/pod/types.js';
import { WriteQueue } from '../src/pod/writeQueue.js';
import { createFakePodClient, type FakePodClient } from './fakePodClient.js';
import { loadFixture } from './loadFixture.js';
import { startMockPod } from './mockPod.js';
import { advanceFakeTime, createTimerHarness, type TimerHarness } from './timerHarness.js';

const deviceStatusFixture = loadFixture('deviceStatus.json') as DeviceStatus;
const settingsFixture = loadFixture('settings.json') as Settings;
const schedulesFixture = loadFixture('schedules.json') as Schedules;
const servicesFixture = loadFixture('services.json') as Services;

interface Setup {
  timers: TimerHarness;
  snapshot: SnapshotStore;
  fake: FakePodClient;
  writeQueue: WriteQueue;
  keepAlive: KeepAlive;
}

interface SetupOptions {
  deviceStatus?: DeviceStatus;
  keepAliveMs?: number;
  keepAliveThresholdMs?: number;
  enabled?: boolean;
}

function setup(options: SetupOptions = {}): Setup {
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  const deviceStatus = options.deviceStatus ?? structuredClone(deviceStatusFixture);
  snapshot.observeDeviceStatus(structuredClone(deviceStatus));
  snapshot.observeSettings(structuredClone(settingsFixture));
  const fake = createFakePodClient({
    deviceStatus,
    settings: settingsFixture,
    schedules: schedulesFixture,
    services: servicesFixture,
  });
  const writeQueue = new WriteQueue({
    client: fake.client,
    snapshot,
    requestFastPoll: () => {},
    timers,
  });
  const keepAlive = new KeepAlive({
    snapshot,
    writeQueue,
    timers,
    keepAliveMs: options.keepAliveMs ?? 600_000,
    keepAliveThresholdMs: options.keepAliveThresholdMs ?? 120_000,
    enabled: options.enabled ?? true,
  });
  return { timers, snapshot, fake, writeQueue, keepAlive };
}

/** A device status with `side` on and a given remaining-seconds value, the other side untouched
 * (off, per the fixture). */
function deviceStatusWith(side: 'left' | 'right', secondsRemaining: number, isOn = true): DeviceStatus {
  const status = structuredClone(deviceStatusFixture);
  status[side] = { ...status[side], isOn, secondsRemaining };
  return status;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 2.2 — cadence arithmetic
// ---------------------------------------------------------------------------------------

describe('KeepAlive: derived check interval (tasks.md 2.2)', () => {
  it.each([
    [1_800_000, 900_000], // default threshold: half is exactly the ceiling
    [1000, 60_000], // half (500) below the floor -> clamped up to 60_000
    [200_000, 100_000], // half (100_000) squarely inside the [60_000, 900_000] range
    [3_000_000, 900_000], // half (1_500_000) above the ceiling -> clamped down to 900_000
    [120_000, 60_000], // half (60_000) exactly at the floor
  ])('threshold %i ms -> check interval %i ms', (keepAliveThresholdMs, expected) => {
    const { keepAlive } = setup({ keepAliveThresholdMs, keepAliveMs: keepAliveThresholdMs * 10, enabled: false });
    expect(keepAlive.checkIntervalMs).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------
// 4.2 / 4.3 — re-arm decision
// ---------------------------------------------------------------------------------------

describe('KeepAlive: a side nearing expiry while on is re-armed (tasks.md 4.2)', () => {
  it('produces exactly one submitSide re-arm once the check timer fires', async () => {
    const { timers, fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 60), // 60s remaining, well under the 120_000ms threshold
    });
    await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs);
    await vi.advanceTimersByTimeAsync(400); // let the re-arm's own debounce flush and dispatch

    expect(fake.postDeviceStatusCalls).toEqual([{ left: { secondsRemaining: 600 } }]); // 600_000ms / 1000
    keepAlive.stop();
    void timers;
  });
});

describe('KeepAlive: a side comfortably above the threshold is left alone (tasks.md 4.3)', () => {
  it('produces no write across several tick advances', async () => {
    const { fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 1000), // 1_000_000ms remaining, above the 120_000ms threshold
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs);
    }
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    keepAlive.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 4.4 — a side that is off is never written to (including the daily-reboot case)
// ---------------------------------------------------------------------------------------

describe('KeepAlive: a side that is off is never written to (tasks.md 4.4)', () => {
  it('an off side with a low secondsRemaining is never re-armed', async () => {
    const { fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 60, false),
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs);
    }
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    keepAlive.stop();
  });

  it('a reboot (secondsRemaining resets to 0, isOn observed false) is not mistaken for a side needing a keep-alive', async () => {
    const { snapshot, fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 60), // starts on, below threshold
    });
    // The Pod reboots before the first check tick: the next poll observes every side reset.
    const rebooted = deviceStatusWith('left', 0, false);
    snapshot.observeDeviceStatus(rebooted);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs);
    }
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    keepAlive.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 4.5 — redundant re-arm suppression and later re-arm once due
// ---------------------------------------------------------------------------------------

describe('KeepAlive: a redundant re-arm is suppressed until it would matter again (tasks.md 4.5)', () => {
  it('no second write until the cooldown elapses, then a second re-arm fires', async () => {
    // keepAliveMs=600_000, keepAliveThresholdMs=120_000 -> checkIntervalMs=60_000,
    // cooldown = keepAliveMs - keepAliveThresholdMs = 480_000 (8 check intervals).
    const { fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 60), // below threshold
    });

    // First tick: fires the re-arm.
    await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs);
    await vi.advanceTimersByTimeAsync(400); // flush the debounce
    expect(fake.postDeviceStatusCalls).toHaveLength(1);

    // The mock never decays secondsRemaining on its own (test/mockPod.ts's no-decay behavior,
    // design.md's Context) — the snapshot's cached secondsRemaining is still the stale, low
    // pre-re-arm value here, since nothing re-observed deviceStatus. Several more ticks, well
    // short of the 480_000ms cooldown, must still submit nothing further.
    await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs * 3);
    expect(fake.postDeviceStatusCalls).toHaveLength(1); // still just the first re-arm

    // Past the cooldown (480_000ms from the first re-arm's own dispatch), with a generous
    // margin so this assertion does not depend on exactly which tick crosses the boundary.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.postDeviceStatusCalls).toHaveLength(2);
    expect(fake.postDeviceStatusCalls[1]).toEqual({ left: { secondsRemaining: 600 } });
    keepAlive.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 4.6 — disabled configuration is fully inert
// ---------------------------------------------------------------------------------------

describe('KeepAlive: disabling keep-alive stops all checks and writes (tasks.md 4.6)', () => {
  it('a disabled instance schedules no timer and never writes, even for a side already past threshold', async () => {
    const { timers, fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 60),
      enabled: false,
    });
    expect(timers.pendingCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    expect(timers.pendingCount()).toBe(0);
    keepAlive.stop(); // idempotent even though nothing was ever started
  });
});

// ---------------------------------------------------------------------------------------
// 4.7 — stop() cancels the schedule, before and after ticks have run
// ---------------------------------------------------------------------------------------

describe('KeepAlive: stopping the system cancels its schedule (tasks.md 4.7)', () => {
  it('stop() before the first tick leaves no timer and no write ever happens', async () => {
    const { timers, fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 60),
    });
    expect(timers.pendingCount()).toBeGreaterThan(0);
    keepAlive.stop();
    expect(timers.pendingCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
  });

  it('stop() after several ticks leaves no timer and no further write happens', async () => {
    const { timers, fake, keepAlive } = setup({
      deviceStatus: deviceStatusWith('right', 1000), // above threshold: ticks run but never write
    });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs);
    }
    expect(fake.postDeviceStatusCalls).toHaveLength(0);

    keepAlive.stop();
    expect(timers.pendingCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    expect(timers.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// 6.1 — keep-alive re-arms carry the 'keepAlive' origin
// ---------------------------------------------------------------------------------------

describe('KeepAlive: re-arm writes carry the keepAlive origin (tasks.md 6.1)', () => {
  it('calls writeQueue.submitSide with origin "keepAlive"', async () => {
    const { writeQueue, keepAlive } = setup({
      deviceStatus: deviceStatusWith('left', 60),
    });
    const spy = vi.spyOn(writeQueue, 'submitSide');
    await vi.advanceTimersByTimeAsync(keepAlive.checkIntervalMs);
    await vi.advanceTimersByTimeAsync(400);
    expect(spy).toHaveBeenCalledWith('left', { secondsRemaining: 600 }, 'keepAlive');
    keepAlive.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 4.8 — mock-Pod-as-oracle: KeepAlive driven through a real WriteQueue against the real mock
// ---------------------------------------------------------------------------------------

describe('KeepAlive: mock-Pod-as-oracle integration (tasks.md 4.8)', () => {
  it("a tick against a real WriteQueue and mock Pod sets the mock's secondsRemaining to keepAliveMs / 1000", async () => {
    // Fake timers drive KeepAlive's/WriteQueue's own scheduling (checkIntervalMs's 60_000ms
    // floor would otherwise make this a genuinely 60s-plus real-time test); `advanceFakeTime`
    // still yields real ticks between virtual-time steps so the real HTTP round trip to the
    // mock Pod actually completes (test/timerHarness.ts's own doc; test/platform.wiring.test.ts's
    // 7.1 test uses the same combination).
    vi.useFakeTimers();
    const pod = await startMockPod({ state: { deviceStatus: { left: { secondsRemaining: 60 } } } }); // on, below threshold
    try {
      const timers = createTimerHarness();
      const { hostname, port } = new URL(pod.url);
      const client = new PodClient({ host: hostname, port: Number(port) });
      const snapshot = new SnapshotStore({ timers });
      snapshot.observeDeviceStatus(await client.getDeviceStatus());
      const writeQueue = new WriteQueue({ client, snapshot, requestFastPoll: () => {}, timers });
      const keepAliveMs = 600_000;
      const keepAlive = new KeepAlive({
        snapshot,
        writeQueue,
        timers,
        keepAliveMs,
        keepAliveThresholdMs: 120_000,
        enabled: true,
      });

      await advanceFakeTime(keepAlive.checkIntervalMs + 500, 100); // one check tick, plus its own debounce

      expect(pod.state.deviceStatus.left.secondsRemaining).toBe(keepAliveMs / 1000);
      keepAlive.stop();
      writeQueue.stop();
    } finally {
      vi.useRealTimers();
      await pod.close();
    }
  });
});
