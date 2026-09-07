import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AwayModeBlockedError, AwayModeGuard, type AwayModeWritePolicy } from '../src/pod/awayModeGuard.js';
import { PodClient } from '../src/pod/client.js';
import { SnapshotStore, type Change } from '../src/pod/snapshot.js';
import { WriteQueue, WriteQueueStoppedError, type FastPollLane, type SidePatch, type WriteQueueOptions } from '../src/pod/writeQueue.js';
import type { DeviceStatus, DeviceStatusPatch, Schedules, Services, Settings } from '../src/pod/types.js';
import { createFakePodClient, type FakePodClient } from './fakePodClient.js';
import { createTimerHarness, realDelay, type TimerHarness } from './timerHarness.js';
import { startMockPod, type MockPod } from './mockPod.js';
import { loadFixture } from './loadFixture.js';

const deviceStatusFixture = loadFixture('deviceStatus.json') as DeviceStatus;
const settingsFixture = loadFixture('settings.json') as Settings;
const schedulesFixture = loadFixture('schedules.json') as Schedules;
const servicesFixture = loadFixture('services.json') as Services;

function clientFor(pod: MockPod, timeoutMs?: number): PodClient {
  const { hostname, port } = new URL(pod.url);
  return new PodClient({ host: hostname, port: Number(port), ...(timeoutMs ? { timeoutMs } : {}) });
}

interface Setup {
  timers: TimerHarness;
  snapshot: SnapshotStore;
  fake: FakePodClient;
  fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }>;
  queue: WriteQueue;
}

function setup(
  options: Partial<Omit<WriteQueueOptions, 'client' | 'snapshot' | 'requestFastPoll' | 'timers'>> & {
    /** Shorthand for `awayModeGuard`, since building one needs a reference to the `snapshot`
     * this function constructs internally — not available to a caller passing `options` in. */
    awayModePolicy?: AwayModeWritePolicy;
  } = {},
  seed: { deviceStatus?: DeviceStatus } = {},
): Setup {
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  // `seed.deviceStatus` lets an individual test pin an exact starting device-status shape
  // (e.g. a specific side's isOn) instead of coupling to whatever the real fixture happens to
  // contain — see the B1 regression test below.
  const deviceStatus = seed.deviceStatus ?? deviceStatusFixture;
  snapshot.observeDeviceStatus(structuredClone(deviceStatus));
  snapshot.observeSettings(structuredClone(settingsFixture));
  const fake = createFakePodClient({
    deviceStatus,
    settings: settingsFixture,
    schedules: schedulesFixture,
    services: servicesFixture,
  });
  const fastPollRequests: Array<{ lane: FastPollLane; untilMs: number }> = [];
  const { awayModePolicy, ...queueOptions } = options;
  const queue = new WriteQueue({
    client: fake.client,
    snapshot,
    requestFastPoll: (lane, untilMs) => fastPollRequests.push({ lane, untilMs }),
    timers,
    ...(awayModePolicy ? { awayModeGuard: new AwayModeGuard({ snapshot, policy: awayModePolicy }) } : {}),
    ...queueOptions,
  });
  return { timers, snapshot, fake, fastPollRequests, queue };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 7. Debounce, coalescing, dispatch
// ---------------------------------------------------------------------------------------

describe('write queue: lanes and per-submission promises (7.1)', () => {
  it("a submission's promise settles when its dispatch settles; two merged submissions settle together", async () => {
    const { queue, fake } = setup();
    const p1 = queue.submitSide('left', { targetTemperatureF: 70 });
    const p2 = queue.submitSide('left', { isOn: true });
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([p1, p2]);
    expect(fake.postDeviceStatusCalls.length).toBe(1);
    queue.stop();
  });

  it('the device and settings lanes also dispatch and settle', async () => {
    const { queue, fake } = setup();
    const pDevice = queue.submitDeviceSettings({ ledBrightness: 40 });
    const pSettings = queue.submitSettings({ primePodDaily: { enabled: false } });
    // The device lane's own debounce (default 500ms, hub-accessory design.md's Decision 4) is
    // stricter than the shared 400ms default every other lane still uses.
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([pDevice, pSettings]);
    // S4 fix (PR #44 review): a partial device-settings submission is backfilled at dispatch time
    // from the currently-observed `deviceStatus.settings` (`deviceStatusFixture`'s own
    // `{v:1, gainLeft:400, gainRight:400}`) — see the dedicated "S4" describe block below for the
    // fresh-vs-stale-gain regression this backfill exists to fix.
    expect(fake.postDeviceStatusCalls).toEqual([{ settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 40 } }]);
    expect(fake.postSettingsCalls).toEqual([{ primePodDaily: { enabled: false } }]);
    queue.stop();
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: device-lane widening (tasks.md 2.1, 2.2, 2.3)
// ---------------------------------------------------------------------------------------

describe('write queue: device-lane widening carries isPriming alongside settings fields (2.1)', () => {
  it('a device-lane submission carrying only isPriming dispatches {isPriming: true} with no settings key', async () => {
    const { queue, fake } = setup();
    const p = queue.submitDeviceSettings({ isPriming: true });
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([{ isPriming: true }]);
    queue.stop();
  });

  it('a device-lane submission carrying only ledBrightness dispatches {settings: {...backfilled, ledBrightness: N}} with no isPriming key', async () => {
    const { queue, fake } = setup();
    const p = queue.submitDeviceSettings({ ledBrightness: 55 });
    await vi.advanceTimersByTimeAsync(500);
    await p;
    // S4 fix: backfilled from the observed deviceStatus (`v`/`gainLeft`/`gainRight`), not a bare
    // partial — see design.md's Decision 5 and the dedicated "S4" describe block below.
    expect(fake.postDeviceStatusCalls).toEqual([{ settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 55 } }]);
    queue.stop();
  });
});

describe('write queue: a priming trigger and a device-settings write merge on the same lane (2.2)', () => {
  it('both fields submitted within the debounce window dispatch as one request carrying both', async () => {
    const { queue, fake } = setup();
    const p1 = queue.submitDeviceSettings({ isPriming: true });
    await vi.advanceTimersByTimeAsync(100);
    const p2 = queue.submitDeviceSettings({ ledBrightness: 70 });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([p1, p2]);
    expect(fake.postDeviceStatusCalls).toEqual([
      { isPriming: true, settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 70 } },
    ]);
    queue.stop();
  });
});

describe('write queue: the device-lane debounce is independently configurable (2.3)', () => {
  it('a device-lane write submitted twice 450ms apart (below the 500ms device default, above the 400ms shared default) is still merged into one dispatch', async () => {
    const { queue, fake } = setup();
    const p1 = queue.submitDeviceSettings({ ledBrightness: 10 });
    await vi.advanceTimersByTimeAsync(450);
    const p2 = queue.submitDeviceSettings({ ledBrightness: 20 });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([p1, p2]);
    expect(fake.postDeviceStatusCalls).toEqual([{ settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 20 } }]);
    queue.stop();
  });

  it('an equivalent side-lane write at the same 450ms spacing already flushes under the shared 400ms default — the two lanes demonstrably use different debounce windows', async () => {
    const { queue, fake } = setup();
    const p1 = queue.submitSide('left', { targetTemperatureF: 65 });
    await vi.advanceTimersByTimeAsync(450); // already past the shared 400ms default
    await p1;
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { targetTemperatureF: 65 } }]);
    const p2 = queue.submitSide('left', { targetTemperatureF: 70 });
    await vi.advanceTimersByTimeAsync(400);
    await p2;
    expect(fake.postDeviceStatusCalls).toEqual([
      { left: { targetTemperatureF: 65 } },
      { left: { targetTemperatureF: 70 } },
    ]);
    queue.stop();
  });

  it('a configured deviceWriteDebounceMs above 500 is honored', async () => {
    const { queue, fake } = setup({ deviceWriteDebounceMs: 800 });
    const p = queue.submitDeviceSettings({ ledBrightness: 30 });
    await vi.advanceTimersByTimeAsync(700);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([{ settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 30 } }]);
    queue.stop();
  });

  it('a configured deviceWriteDebounceMs below the 500ms floor is clamped to the floor', async () => {
    const { queue, fake } = setup({ deviceWriteDebounceMs: 100 });
    const p = queue.submitDeviceSettings({ ledBrightness: 30 });
    await vi.advanceTimersByTimeAsync(499);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([{ settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 30 } }]);
    queue.stop();
  });
});

describe('write queue: debounce and merge (7.2)', () => {
  it('#10 acceptance: a power write and a temperature write 10ms apart produce exactly one POST carrying both fields', async () => {
    const { queue, fake } = setup();
    const p1 = queue.submitSide('left', { isOn: true });
    await vi.advanceTimersByTimeAsync(10);
    const p2 = queue.submitSide('left', { targetTemperatureF: 70 });
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([p1, p2]);
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isOn: true, targetTemperatureF: 70 } }]);
    queue.stop();
  });
});

describe('write queue: last-write-wins and lane independence (7.3)', () => {
  it('three target temperatures within the window dispatch only the last', async () => {
    const { queue, fake } = setup();
    const p1 = queue.submitSide('left', { targetTemperatureF: 65 });
    const p2 = queue.submitSide('left', { targetTemperatureF: 68 });
    const p3 = queue.submitSide('left', { targetTemperatureF: 70 });
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([p1, p2, p3]);
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { targetTemperatureF: 70 } }]);
    queue.stop();
  });

  it('simultaneous left and right submissions each dispatch on their own, neither delaying the other', async () => {
    const { queue, fake } = setup();
    const pl = queue.submitSide('left', { targetTemperatureF: 65 });
    const pr = queue.submitSide('right', { targetTemperatureF: 68 });
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([pl, pr]);
    expect(fake.postDeviceStatusCalls.length).toBe(2);
    queue.stop();
  });
});

describe('write queue: writeMaxDebounceMs (7.4)', () => {
  it('a submission every 100ms for 10s dispatches at roughly the max-wait interval, each carrying the most recent value', async () => {
    const { queue, fake } = setup({ writeDebounceMs: 400, writeMaxDebounceMs: 2000 });
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(queue.submitSide('left', { targetTemperatureF: 64 + (i % 40) }));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2000); // flush the trailing partial batch
    await Promise.all(promises);
    // ~10000ms of continuous submissions at a 2000ms cap: roughly 5-6 dispatches, never one.
    expect(fake.postDeviceStatusCalls.length).toBeGreaterThanOrEqual(4);
    expect(fake.postDeviceStatusCalls.length).toBeLessThanOrEqual(7);
    for (const call of fake.postDeviceStatusCalls) {
      expect(call.left?.targetTemperatureF).toBeDefined();
    }
    queue.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 8. The duration-field reduction
// ---------------------------------------------------------------------------------------

describe('write queue: the isOn/secondsRemaining reduction (8.1)', () => {
  const cases: Array<[SidePatch, DeviceStatusPatch['left']]> = [
    [{ isOn: true, secondsRemaining: 600 }, { secondsRemaining: 600 }],
    [{ isOn: false, secondsRemaining: 600 }, { secondsRemaining: 600 }],
    [{ isOn: true, secondsRemaining: 0 }, { isOn: true }],
    [{ isOn: false, secondsRemaining: 0 }, { isOn: false }],
  ];

  for (const [patch, expected] of cases) {
    it(`dispatches exactly one field for ${JSON.stringify(patch)}`, async () => {
      const { queue, fake } = setup();
      const p = queue.submitSide('left', patch);
      await vi.advanceTimersByTimeAsync(400);
      await p;
      expect(fake.postDeviceStatusCalls).toEqual([{ left: expected }]);
      queue.stop();
    });
  }
});

describe('write queue: reduction matches the Pod\'s own outcome (8.2, mock as oracle)', () => {
  const cases: SidePatch[] = [
    { isOn: true, secondsRemaining: 600 },
    { isOn: false, secondsRemaining: 600 },
    { isOn: true, secondsRemaining: 0 },
    { isOn: false, secondsRemaining: 0 },
  ];

  for (const patch of cases) {
    it(`${JSON.stringify(patch)}: reduced dispatch equals the unreduced patch applied directly`, async () => {
      // Real timers only for every test in this file that drives more than one real request
      // through a real PodClient/mock-pod pair (this one, 8.3, 9.1, and 9.6's mirroring test):
      // vitest's fake timers and undici's own internal (also `setTimeout`-based) connection
      // bookkeeping fight each other once a *second* real request reuses a connection whose
      // keep-alive housekeeping was scheduled against the fake clock — the request hangs
      // forever with no error. Tests using `FakePodClient` (no real socket at all) are
      // unaffected and keep using fake timers via the file-level `beforeEach` above.
      vi.useRealTimers();
      const podReduced = await startMockPod();
      const podUnreduced = await startMockPod();
      try {
        const timers = createTimerHarness();
        const snapshot = new SnapshotStore({ timers });
        const queue = new WriteQueue({ client: clientFor(podReduced), snapshot, requestFastPoll: () => {}, timers });

        const p = queue.submitSide('left', patch);
        await realDelay(450);
        await p;

        await fetch(`${podUnreduced.url}/api/deviceStatus`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ left: patch }),
        });

        expect(podReduced.state.deviceStatus.left).toEqual(podUnreduced.state.deviceStatus.left);
        if (patch.isOn === false && patch.secondsRemaining === 0) {
          // The case "always drop isOn" gets wrong: the side must end up OFF.
          expect(podReduced.state.deviceStatus.left.secondsRemaining).toBe(0);
        }
        queue.stop();
      } finally {
        await podReduced.close();
        await podUnreduced.close();
      }
    });
  }
});

describe("write queue: the client's pre-flight rejection is never tripped (8.3)", () => {
  it('every ordering that can combine isOn and secondsRemaining in one window dispatches safely, including a keep-alive landing in a power-off window', async () => {
    // Real timers only — see the note on the 8.2 describe block above.
    vi.useRealTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const queue = new WriteQueue({ client: clientFor(pod), snapshot, requestFastPoll: () => {}, timers });

      const orderings: Array<() => Array<Promise<void>>> = [
        () => [queue.submitSide('left', { isOn: false }), queue.submitSide('left', { secondsRemaining: 600 })], // keep-alive lands in a power-off window
        () => [queue.submitSide('left', { secondsRemaining: 600 }), queue.submitSide('left', { isOn: false })],
        () => [queue.submitSide('left', { isOn: true }), queue.submitSide('left', { secondsRemaining: 0 })],
        () => [queue.submitSide('left', { secondsRemaining: 0 }), queue.submitSide('left', { isOn: true })],
      ];

      for (const makeSubmissions of orderings) {
        const promises = makeSubmissions();
        await realDelay(450);
        await Promise.all(promises); // must not reject with PodRequestError
      }

      const statusPosts = pod.requests.filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus');
      expect(statusPosts.length).toBe(orderings.length);
      for (const request of statusPosts) {
        const body = request.body as { left?: Record<string, unknown> };
        const left = body.left ?? {};
        expect('isOn' in left && 'secondsRemaining' in left).toBe(false);
      }
      queue.stop();
    } finally {
      await pod.close();
    }
  });
});

describe('write queue: single-field patches are untouched (8.4)', () => {
  it('a patch carrying only isOn, or only secondsRemaining, is dispatched byte-identically', async () => {
    const { queue, fake } = setup();
    const p1 = queue.submitSide('left', { isOn: true });
    await vi.advanceTimersByTimeAsync(400);
    await p1;
    expect(fake.postDeviceStatusCalls[0]).toEqual({ left: { isOn: true } });

    const p2 = queue.submitSide('right', { secondsRemaining: 300 });
    await vi.advanceTimersByTimeAsync(400);
    await p2;
    expect(fake.postDeviceStatusCalls[1]).toEqual({ right: { secondsRemaining: 300 } });
    queue.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 9. Mutex, overlay lifecycle, fast poll
// ---------------------------------------------------------------------------------------

describe('write queue: mutex (9.1)', () => {
  it('a status write and a settings write due at the same moment are recorded strictly sequentially, and a failing dispatch releases the mutex', async () => {
    // Real timers only — see the note on the 8.2 describe block above. This test also needs
    // the client's own real (un-fakeable) per-attempt timeout to actually elapse.
    vi.useRealTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const queue = new WriteQueue({ client: clientFor(pod, 100), snapshot, requestFastPoll: () => {}, timers });

      // 'hang' covers the client's own single retry too, so the status write genuinely fails.
      pod.fault('POST /api/deviceStatus', { kind: 'hang', times: 2 });
      const p1 = queue.submitSide('left', { targetTemperatureF: 70 });
      // settings-switches (tech-lead resolution 1): a patch touching `awayMode` specifically is
      // now drained inline *before* the side lane's own dispatch, deliberately breaking this
      // test's original "the mutex holds the settings write back" premise — see the dedicated
      // "drain-before-decide" describe block below for that mechanism's own tests. This patch is
      // deliberately `awayMode`-free so this test keeps proving its own, unrelated point (general
      // mutex sequencing across two arbitrary same-moment writes, and release-on-failure).
      const p2 = queue.submitSettings({ primePodDaily: { enabled: true } });
      await realDelay(450);

      await realDelay(20);
      // The hanging status write has not settled — the mock only records a 'hang'ed request
      // once its connection eventually closes — so the settings write, due at the same
      // moment, must not have reached the Pod yet either: the mutex is holding it back.
      expect(pod.requests.some((r) => r.path === '/api/settings')).toBe(false);

      let rejected: unknown;
      try {
        await p1;
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeTruthy();

      await p2; // now dispatched, since the failing write released the mutex
      expect(pod.requests.some((r) => r.path === '/api/settings')).toBe(true);
      queue.stop();
    } finally {
      await pod.close();
    }
  });
});

describe('write queue: runExclusive (9.2)', () => {
  it('a write becoming due during an exclusive section is dispatched only after the section completes', async () => {
    const { queue, fake } = setup();
    let resolveExclusive!: () => void;
    const exclusiveDone = new Promise<void>((resolve) => {
      resolveExclusive = resolve;
    });
    const order: string[] = [];
    const exclusivePromise = queue.runExclusive(async () => {
      order.push('exclusive-start');
      await exclusiveDone;
      order.push('exclusive-end');
    });

    const writeDone = queue.submitSide('left', { targetTemperatureF: 70 }).then(() => order.push('write-dispatched'));
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.postDeviceStatusCalls.length).toBe(0);
    expect(order).toEqual(['exclusive-start']);

    resolveExclusive();
    await exclusivePromise;
    await writeDone;
    expect(order).toEqual(['exclusive-start', 'exclusive-end', 'write-dispatched']);
    expect(fake.postDeviceStatusCalls.length).toBe(1);
    queue.stop();
  });

  it('a throwing exclusive section still releases the mutex', async () => {
    const { queue, fake } = setup();
    await expect(queue.runExclusive(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const p = queue.submitSide('left', { targetTemperatureF: 70 });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fake.postDeviceStatusCalls.length).toBe(1);
    queue.stop();
  });
});

describe('write queue: overlay installed at submission (9.3)', () => {
  it('snapshot.get() returns the new value immediately after submission, before any request is made', async () => {
    const { queue, fake, snapshot } = setup();
    const p = queue.submitSide('left', { targetTemperatureF: 75 });
    expect(snapshot.get().left.targetTemperatureF).toBe(75);
    expect(fake.postDeviceStatusCalls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    await p;
    queue.stop();
  });
});

describe('write queue: overlay rebased at settle, cleared on failure (9.4)', () => {
  it('a write held several seconds in the mutex still gets a full writeSettleMs window measured from settle', async () => {
    const { queue, snapshot } = setup({ writeSettleMs: 15_000 });
    let releaseHold!: () => void;
    const holdDone = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holdPromise = queue.runExclusive(() => holdDone);

    const p = queue.submitSide('left', { targetTemperatureF: 72 });
    await vi.advanceTimersByTimeAsync(400); // debounce flush -> enqueued behind the hold
    await vi.advanceTimersByTimeAsync(5000); // held in the mutex for 5s

    releaseHold();
    await holdPromise;
    await p; // dispatch proceeds and settles now

    await vi.advanceTimersByTimeAsync(14_999);
    expect(snapshot.get().left.targetTemperatureF).toBe(72); // still well inside the rebased window
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshot.get().left.targetTemperatureF).not.toBe(72); // expired, measured from settle not submission
    queue.stop();
  });

  it('a failed dispatch removes overlay entries immediately, reverting get() and emitting the reversion', async () => {
    const { queue, fake, snapshot } = setup();
    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('pod rejected') };
    const received: unknown[] = [];
    snapshot.subscribe((changes) => received.push(changes));

    const p = queue.submitSide('left', { targetTemperatureF: 80 });
    p.catch(() => undefined); // observed properly below; this just keeps Node's unhandled-rejection detector quiet in between
    expect(snapshot.get().left.targetTemperatureF).toBe(80);

    await vi.advanceTimersByTimeAsync(400);
    let rejected: unknown;
    try {
      await p;
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeTruthy();
    expect(snapshot.get().left.targetTemperatureF).not.toBe(80);
    expect(received.length).toBeGreaterThan(0);
    queue.stop();
  });
});

describe('write queue: fast poll on success only (9.5)', () => {
  it('a successful write requests the fast poll for the configured window', async () => {
    const { queue, fastPollRequests, timers } = setup({ fastPollDurationMs: 90_000 });
    const p = queue.submitSide('left', { targetTemperatureF: 66 });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fastPollRequests.length).toBe(1);
    expect(fastPollRequests[0]).toEqual({ lane: 'deviceStatus', untilMs: timers.now() + 90_000 });
    queue.stop();
  });

  it('a failed dispatch makes no fast-poll request', async () => {
    const { queue, fake, fastPollRequests } = setup();
    fake.postDeviceStatusOutcome = { kind: 'error', error: new Error('down') };
    const p = queue.submitSide('left', { targetTemperatureF: 66 });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);
    let rejected: unknown;
    try {
      await p;
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeTruthy();
    expect(fastPollRequests.length).toBe(0);
    queue.stop();
  });

  it('the confirming observation retires the overlay by agreement, with no reversion notification', async () => {
    const { queue, snapshot } = setup({ writeSettleMs: 15_000 });
    const p = queue.submitSide('left', { targetTemperatureF: 77 });
    await vi.advanceTimersByTimeAsync(400);
    await p;

    const received: unknown[] = [];
    snapshot.subscribe((changes) => received.push(changes));
    const confirmed = structuredClone(deviceStatusFixture);
    confirmed.left.targetTemperatureF = 77;
    snapshot.observeDeviceStatus(confirmed); // simulates the poller's confirming read landing

    expect(snapshot.get().left.targetTemperatureF).toBe(77);
    expect(received.length).toBe(0);

    await vi.advanceTimersByTimeAsync(20_000); // long past the original settle window
    expect(received.length).toBe(0); // agreed entries never revert
    queue.stop();
  });
});

describe('write queue: fast poll is lane-aware (S2 regression)', () => {
  it('a left/right side-lane write requests the deviceStatus lane', async () => {
    const { queue, fastPollRequests } = setup();
    const p = queue.submitSide('left', { targetTemperatureF: 66 });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fastPollRequests).toHaveLength(1);
    expect(fastPollRequests[0]!.lane).toBe('deviceStatus');
    queue.stop();
  });

  it('a device-lane write requests the deviceStatus lane', async () => {
    const { queue, fastPollRequests } = setup();
    const p = queue.submitDeviceSettings({ ledBrightness: 40 });
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(fastPollRequests).toHaveLength(1);
    expect(fastPollRequests[0]!.lane).toBe('deviceStatus');
    queue.stop();
  });

  it('a settings-lane write requests the settings lane, not deviceStatus', async () => {
    const { queue, fastPollRequests } = setup();
    const p = queue.submitSettings({ left: { awayMode: true } });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fastPollRequests).toHaveLength(1);
    expect(fastPollRequests[0]!.lane).toBe('settings');
    queue.stop();
  });
});

describe('write queue: per-batch overlay ownership (B1 regression)', () => {
  it('a later same-side write cycle that omits isOn does not clear a still-live isOn overlay installed by an earlier cycle, and each keeps its own settle window', async () => {
    // This test needs the raw (pre-overlay) left.isOn to start `true`, so that submitting
    // isOn:false installs an overlay that *disagrees* with raw and stays observably live,
    // rather than retiring by agreement the instant it's installed. Pinned explicitly via
    // `seed.deviceStatus` rather than coupled to whatever the fixture's left.isOn happens to
    // be (it's `false` in the real Pod 3 capture) — see B1 in the pod-client code review.
    const rawDeviceStatus: DeviceStatus = {
      ...deviceStatusFixture,
      left: { ...deviceStatusFixture.left, isOn: true },
    };
    const { queue, snapshot } = setup({ writeSettleMs: 15_000 }, { deviceStatus: rawDeviceStatus });
    const received: Change[] = [];
    snapshot.subscribe((changes) => received.push(...changes));

    // Cycle 1: isOn:false, fully flushed and settled.
    const p1 = queue.submitSide('left', { isOn: false });
    await vi.advanceTimersByTimeAsync(400);
    await p1;
    expect(snapshot.get().left.isOn).toBe(false);
    received.length = 0; // drop the legitimate isOn change from cycle 1 itself

    // 100ms later, per the reviewer's reproduction: a second, unrelated write to the same side.
    await vi.advanceTimersByTimeAsync(100);
    const p2 = queue.submitSide('left', { targetTemperatureF: 70 });
    await vi.advanceTimersByTimeAsync(400);
    await p2;

    // Both overlays are live simultaneously — the second cycle never touched isOn's overlay.
    expect(snapshot.get().left.isOn).toBe(false);
    expect(snapshot.get().left.targetTemperatureF).toBe(70);
    expect(received.some((c) => c.field === 'isOn')).toBe(false); // no spurious isOn event

    // Independent windows: cycle 1 settled at ~t=400 (expires ~15400), cycle 2 settled at
    // ~t=900 (expires ~15900). Advancing to just before cycle 1's own expiry must not affect
    // cycle 2's still-live overlay, and cycle 1 must expire on its own schedule regardless of
    // cycle 2 ever having touched the same side.
    await vi.advanceTimersByTimeAsync(14_499); // total 14999ms since cycle 2 settled => t~=15399
    expect(snapshot.get().left.isOn).toBe(false);
    expect(snapshot.get().left.targetTemperatureF).toBe(70);

    await vi.advanceTimersByTimeAsync(2); // past cycle 1's own expiry, still short of cycle 2's
    expect(snapshot.get().left.isOn).toBe(rawDeviceStatus.left.isOn); // reverted to raw (true)
    expect(snapshot.get().left.targetTemperatureF).toBe(70); // cycle 2 unaffected
    queue.stop();
  });
});

describe('write queue: a failed dispatch never clears a newer pending cycle\'s overlay (S1 regression)', () => {
  it('a targetTemperatureF write that fails while a newer one for the same side is still pending leaves the newer overlay live', async () => {
    // Real timers only — see the note on the 8.2 describe block above: this needs the mock's
    // real 'hang' fault and the client's own real timeout to actually elapse.
    vi.useRealTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const queue = new WriteQueue({ client: clientFor(pod, 100), snapshot, requestFastPoll: () => {}, timers });

      // 'hang' covers the client's own single retry too (see the 9.1 test above), so cycle A
      // genuinely fails rather than eventually succeeding late.
      pod.fault('POST /api/deviceStatus', { kind: 'hang', times: 2 });
      const pA = queue.submitSide('left', { targetTemperatureF: 70 });
      pA.catch(() => undefined);
      await realDelay(450); // cycle A's debounce flushes and its (hanging) dispatch begins

      // Cycle B starts fresh — cycle A already flushed (rt.pending is null) — while A is still
      // in flight.
      const pB = queue.submitSide('left', { targetTemperatureF: 75 });
      expect(snapshot.get().left.targetTemperatureF).toBe(75);

      let rejectedA: unknown;
      try {
        await pA;
      } catch (error) {
        rejectedA = error;
      }
      expect(rejectedA).toBeTruthy(); // cycle A's dispatch failed

      // Cycle B's overlay must have survived cycle A's failure-driven cleanup.
      expect(snapshot.get().left.targetTemperatureF).toBe(75);

      await realDelay(500); // cycle B's own debounce flushes and dispatches
      await pB;
      expect(snapshot.get().left.targetTemperatureF).toBe(75);
      queue.stop();
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 9.6 — away-mode guard, consulted at dispatch (away-mode-guard change)
//
// Adaptation note (tech-lead resolution 2): this section replaces the pre-existing "the queue
// holds no policy about away mode" behavior (formerly asserted here) — enforcement now lives
// inside `dispatch()` itself, consulted for every side-lane write regardless of origin, rather
// than in a front-door wrapper. `setup()`'s default (no `awayModePolicy` option) still exercises
// today's zero-cost path unchanged: `AwayModeGuard.decide()` returns `'plain'` whenever neither
// side is away, matching the "queue is a no-op guard" behavior every other describe block in
// this file already depends on implicitly.
// ---------------------------------------------------------------------------------------

describe('write queue: away-mode guard (9.6)', () => {
  it('with neither side away, a write is dispatched exactly as submitted — the guard adds no request', async () => {
    const { queue, fake } = setup();
    const p = queue.submitSide('right', { targetTemperatureF: 68 });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { targetTemperatureF: 68 } }]);
    queue.stop();
  });

  it("the default policy ('mirror') dispatches the addressed side and mirrors the same fields to the other side, updating its cached view without a poll", async () => {
    const { queue, fake, snapshot } = setup();
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });
    const p = queue.submitSide('right', { targetTemperatureF: 68 });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([
      { right: { targetTemperatureF: 68 } },
      { left: { targetTemperatureF: 68 } },
    ]);
    expect(snapshot.get().left.targetTemperatureF).toBe(68);
    queue.stop();
  });

  it("an explicit 'block' policy refuses the write before it reaches the Pod, and the cached view is unchanged", async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });
    const before = snapshot.get().right.targetTemperatureF;
    const p = queue.submitSide('right', { targetTemperatureF: 68 });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).rejects.toBeInstanceOf(AwayModeBlockedError);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    expect(snapshot.get().right.targetTemperatureF).toBe(before);
    queue.stop();
  });

  it('either side being away is sufficient to trigger the policy — right-away + left-write, and both-away, behave identically', async () => {
    const rightAwayOnly: Settings = {
      ...structuredClone(settingsFixture),
      right: { ...settingsFixture.right, awayMode: true },
    };
    const bothAway: Settings = {
      ...structuredClone(settingsFixture),
      left: { ...settingsFixture.left, awayMode: true },
      right: { ...settingsFixture.right, awayMode: true },
    };
    for (const awaySettings of [rightAwayOnly, bothAway]) {
      const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
      snapshot.observeSettings(awaySettings);
      const p = queue.submitSide('left', { targetTemperatureF: 68 });
      p.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(400);
      await expect(p).rejects.toBeInstanceOf(AwayModeBlockedError);
      expect(fake.postDeviceStatusCalls).toHaveLength(0);
      queue.stop();
    }
  });

  it('a concurrent away-mode toggle does not race the check: a settings write installs its overlay synchronously, before any later-submitted side write can dispatch', async () => {
    const { queue, fake } = setup({ awayModePolicy: 'block' });
    // Submitted back-to-back, in the same synchronous tick — `submitSettings`'s overlay install
    // happens synchronously at the call site (design.md's Context), so by the time the side
    // write's own debounce later flushes and dispatches, the guard's check always observes the
    // toggle, regardless of how close together the two calls were made.
    const toggle = queue.submitSettings({ left: { awayMode: true } });
    const write = queue.submitSide('right', { targetTemperatureF: 68 });
    write.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);
    await toggle;
    await expect(write).rejects.toBeInstanceOf(AwayModeBlockedError);
    expect(fake.postDeviceStatusCalls).toHaveLength(0);
    queue.stop();
  });

  it("a failed mirror POST keeps the mirrored side's overlay instead of clearing it, since the addressed write already succeeded and free-sleep's controlBothSides already applied it to both sides (F1 regression)", async () => {
    const { queue, fake, snapshot } = setup();
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    // The addressed (right) POST succeeds; every POST after it (the mirror, to left) fails —
    // reproducing the reviewer's probe: before the F1 fix this cleared the mirror's overlay,
    // leaving `snapshot.get().left.targetTemperatureF` at the stale raw fixture value (90)
    // instead of the value the addressed write actually caused free-sleep to apply there too.
    fake.client.postDeviceStatus = (async (patch) => {
      fake.postDeviceStatusCalls.push(patch);
      if (fake.postDeviceStatusCalls.length > 1) {
        throw new Error('mirror POST failed');
      }
    }) as typeof fake.client.postDeviceStatus;

    const p = queue.submitSide('right', { targetTemperatureF: 68 });
    await vi.advanceTimersByTimeAsync(400);
    await p;

    expect(fake.postDeviceStatusCalls).toEqual([
      { right: { targetTemperatureF: 68 } },
      { left: { targetTemperatureF: 68 } },
    ]);
    // Reviewer probe showed left=90 (stale raw cache) / right=68 before the fix; both must now
    // read 68 — the mirrored side's overlay is kept, not cleared, on a failed mirror POST.
    expect(snapshot.get().right.targetTemperatureF).toBe(68);
    expect(snapshot.get().left.targetTemperatureF).toBe(68);
    queue.stop();
  });

  it("with the real mock, the Pod's own away-mode mirroring and this queue's own mirrored write agree", async () => {
    // Real timers only — see the note on the 8.2 describe block above.
    vi.useRealTimers();
    const pod = await startMockPod({ state: { settings: { left: { awayMode: true } } } });
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const client = clientFor(pod);
      // The guard's decision reads the *cached* snapshot, not a live request (design.md's own
      // "no request dedicated solely to that check") — so, unlike the Pod's own `updateSide`
      // (which reads its live settings document on every write), this plugin's own mirroring
      // only fires once the poller (or, here, a direct observation standing in for it) has
      // actually told the snapshot that a side is away.
      snapshot.observeSettings(await client.getSettings());
      const queue = new WriteQueue({ client, snapshot, requestFastPoll: () => {}, timers });
      const p = queue.submitSide('right', { targetTemperatureF: 90 });
      await realDelay(600);
      await p;
      const status = await client.getDeviceStatus();
      expect(status.left.targetTemperatureF).toBe(90);
      expect(status.right.targetTemperatureF).toBe(90);
      const statusPosts = pod.requests.filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus');
      expect(statusPosts.length).toBe(2); // the addressed right write, plus this queue's own mirror to left
      queue.stop();
    } finally {
      await pod.close();
    }
  });

  it('an idle queue issues zero requests over an hour of fake time', async () => {
    const { fake, queue } = setup();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fake.postDeviceStatusCalls.length).toBe(0);
    expect(fake.postSettingsCalls.length).toBe(0);
    queue.stop();
  });
});

// ---------------------------------------------------------------------------------------
// alarm-events (#16, tech-lead resolution 1): an isAlarmVibrating-only patch bypasses the
// away-mode guard entirely — never blocked, never mirrored — matching upstream's own
// `updateSide`, which never consults `controlBothSides`/`updateLeft`/`updateRight` for this
// field at all (test/mockPod.ts's `updateSide`, mirroring `updateDeviceStatus.ts`).
// ---------------------------------------------------------------------------------------

describe("write queue: away-mode guard — alarm-only bypass (alarm-events, tech-lead resolution 1)", () => {
  it("dismiss under 'block' + away on -> the write lands, exactly one side", async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const p = queue.submitSide('right', { isAlarmVibrating: false });
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBeUndefined();

    expect(fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]);
    queue.stop();
  });

  it("dismiss under 'block' + both sides away -> still lands, exactly one side", async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({
      ...structuredClone(settingsFixture),
      left: { ...settingsFixture.left, awayMode: true },
      right: { ...settingsFixture.right, awayMode: true },
    });

    const p = queue.submitSide('left', { isAlarmVibrating: false });
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBeUndefined();

    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isAlarmVibrating: false } }]);
    queue.stop();
  });

  it("dismiss under 'mirror' + away on -> lands addressed only, never mirrored to the other side", async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'mirror' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const p = queue.submitSide('right', { isAlarmVibrating: false });
    await vi.advanceTimersByTimeAsync(400);
    await p;

    // Exactly one POST — the addressed side only. A mirrored policy would otherwise have
    // produced a second POST to `left` (matching this file's own "the default policy ('mirror')
    // dispatches the addressed side and mirrors..." test above, for a non-alarm field).
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]);
    queue.stop();
  });

  it('with neither side away, the bypass is unobservable — dispatches exactly as submitted, same as the no-away-mode baseline', async () => {
    const { queue, fake } = setup({ awayModePolicy: 'block' });
    const p = queue.submitSide('left', { isAlarmVibrating: false });
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBeUndefined();
    expect(fake.postDeviceStatusCalls).toEqual([{ left: { isAlarmVibrating: false } }]);
    queue.stop();
  });

  // N8 (alarm-events PR #45 review, tech-lead ruling): a dismiss coalesced with any other field
  // is peeled into its own dispatch cycle *before* `awayModeGuard.decide()` ever runs — the
  // alarm field always lands on the addressed side, while the remainder gets ordinary guard
  // treatment (blocked, or mirrored) as if the two fields had never coalesced. These two tests
  // used to assert the opposite (a coalesced patch inherited the remainder's guard outcome
  // wholesale) — that was the bug N8 fixes; see the "N8: a coalesced dismiss..." describe block
  // below for the reviewer's own four repro orderings.
  it('a patch carrying isAlarmVibrating alongside another field: the alarm field still lands, blocked under \'block\' + away', async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const p = queue.submitSide('right', { isAlarmVibrating: false, targetTemperatureF: 70 });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).rejects.toBeInstanceOf(AwayModeBlockedError);
    // The alarm-only peel landed (addressed side, alarm field only); the guarded remainder
    // (targetTemperatureF) never reached the Pod at all — no guard evasion for the non-alarm field.
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]);
    queue.stop();
  });

  it('a patch carrying isAlarmVibrating alongside another field: the alarm field lands addressed-only, the remainder mirrors normally, under \'mirror\' + away', async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'mirror' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const p = queue.submitSide('right', { isAlarmVibrating: false, targetTemperatureF: 70 });
    await vi.advanceTimersByTimeAsync(400);
    await p;

    expect(fake.postDeviceStatusCalls).toEqual([
      // The peeled alarm-only cycle, dispatched (and awaited) before the remainder's own guard
      // decision is even made.
      { right: { isAlarmVibrating: false } },
      // The remainder's own addressed dispatch — guard decides 'mirror' (unaffected by the
      // alarm field's own exemption, since it is no longer part of this patch at all).
      { right: { targetTemperatureF: 70 } },
      // S6: the mirror itself never carries isAlarmVibrating, whether or not one was ever
      // coalesced into the original patch.
      { left: { targetTemperatureF: 70 } },
    ]);
    queue.stop();
  });

  it('every other side write\'s away-mode behavior is unchanged by this bypass — a plain temperature write is still mirrored', async () => {
    const { queue, fake, snapshot } = setup();
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });
    const p = queue.submitSide('right', { targetTemperatureF: 68 });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([
      { right: { targetTemperatureF: 68 } },
      { left: { targetTemperatureF: 68 } },
    ]);
    queue.stop();
  });
});

// N8 (alarm-events PR #45 review, tech-lead ruling): the reviewer's own four orderings in which a
// dismiss can coalesce with a guarded field in the same debounce window — every one must land the
// alarm write on exactly the addressed side while the guarded remainder is blocked normally, with
// no guard evasion for the non-alarm field(s).
describe("write queue: N8 — a coalesced dismiss is peeled into its own dispatch cycle, ahead of the guard", () => {
  it('dismiss submitted before isOn: the alarm write lands, isOn is blocked', async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const dismissP = queue.submitSide('right', { isAlarmVibrating: false });
    dismissP.catch(() => undefined);
    const isOnP = queue.submitSide('right', { isOn: true });
    isOnP.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);

    await expect(isOnP).rejects.toBeInstanceOf(AwayModeBlockedError);
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]); // isOn never evaded the guard
    queue.stop();
  });

  it('isOn submitted before dismiss: the alarm write still lands, isOn is still blocked', async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const isOnP = queue.submitSide('right', { isOn: true });
    isOnP.catch(() => undefined);
    const dismissP = queue.submitSide('right', { isAlarmVibrating: false });
    dismissP.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);

    await expect(isOnP).rejects.toBeInstanceOf(AwayModeBlockedError);
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]);
    queue.stop();
  });

  it('dismiss coalesced with a keep-alive secondsRemaining re-arm: the alarm write lands, secondsRemaining is blocked', async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const dismissP = queue.submitSide('right', { isAlarmVibrating: false });
    dismissP.catch(() => undefined);
    const keepAliveP = queue.submitSide('right', { secondsRemaining: 500 }, 'keepAlive');
    keepAliveP.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);

    await expect(keepAliveP).rejects.toBeInstanceOf(AwayModeBlockedError);
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]);
    queue.stop();
  });

  it('all three coalesced (dismiss, user isOn, keep-alive secondsRemaining): the alarm write still lands alone, addressed side only', async () => {
    const { queue, fake, snapshot } = setup({ awayModePolicy: 'block' });
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });

    const dismissP = queue.submitSide('right', { isAlarmVibrating: false });
    dismissP.catch(() => undefined);
    const isOnP = queue.submitSide('right', { isOn: true });
    isOnP.catch(() => undefined);
    const keepAliveP = queue.submitSide('right', { secondsRemaining: 500 }, 'keepAlive');
    keepAliveP.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400);

    // User-intent priority (module doc) drops the keep-alive `secondsRemaining` before the
    // duration reduction even runs, leaving `{isAlarmVibrating, isOn}` as the merged patch —
    // peeling still isolates the alarm field from whichever field(s) survive that reduction.
    await expect(isOnP).rejects.toBeInstanceOf(AwayModeBlockedError);
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { isAlarmVibrating: false } }]); // no evasion for isOn or secondsRemaining
    queue.stop();
  });
});

describe('write queue: stop() (9.7)', () => {
  it('pending writes settle with a shutdown failure, the Pod receives nothing, owned overlays are removed, and no timer is left', async () => {
    const { queue, fake, snapshot, timers } = setup();
    const p = queue.submitSide('left', { targetTemperatureF: 82 });
    expect(snapshot.get().left.targetTemperatureF).toBe(82);

    queue.stop();
    await expect(p).rejects.toBeInstanceOf(WriteQueueStoppedError);
    expect(fake.postDeviceStatusCalls.length).toBe(0);
    expect(snapshot.get().left.targetTemperatureF).not.toBe(82);
    expect(timers.pendingCount()).toBe(0);
  });

  // CI regression (alarm-events PR #45 review, found via a platform-level B2 test): a write
  // cycle's overlay is only tracked in `liveOverlayBatches` — and therefore only cleared by the
  // loop above — while that cycle is still *in flight*. `settleWrite`'s own tail removes a cycle
  // from `liveOverlayBatches` the instant it settles, success or failure, since from this queue's
  // own perspective it is done with it; a *successfully settled* write's overlay is still live in
  // `SnapshotStore` with its own pending `writeSettleMs` expiry timer, which nothing previously
  // cleared if `stop()` ran before that timer's natural expiry (or before a later poll confirmed
  // `raw` agreement). Every other `stop()`/shutdown test in this file exercises a write that never
  // settles (still pending, still queued) or one that fails (whose overlay clears immediately) —
  // this is the first to settle a write successfully and then stop() before its own settle window
  // elapses, which is exactly the gap `SnapshotStore.clearAllOverlaysForShutdown()` (called from
  // this method) now closes.
  it('a write that already settled successfully before stop() still has its own overlay timer cleared', async () => {
    const { queue, snapshot, timers } = setup();
    const p = queue.submitSide('left', { targetTemperatureF: 82 });
    await vi.advanceTimersByTimeAsync(400); // debounce -> dispatch -> success
    await p;

    expect(snapshot.get().left.targetTemperatureF).toBe(82); // overlay still live, settled successfully
    expect(timers.pendingCount()).toBeGreaterThan(0); // its own writeSettleMs expiry timer is pending

    queue.stop();
    expect(timers.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// 10 — user-intent priority (keep-alive change, tasks.md 4.9 and 6.1, tech-lead resolution 5)
//
// `submitSide`'s third argument (`origin`, default `'user'`) lets a caller mark itself as
// `'keepAlive'`. When a debounce-window merge combines a user-origin `isOn` with a
// keep-alive-origin `secondsRemaining`, `applyOriginPriority` drops the keep-alive field before
// `reduceDurationFields` runs at all — so the user's explicit power toggle is what dispatches,
// never overridden by a same-window re-arm. The first test below is the pre-fix baseline,
// replayed unchanged: two *same*-origin (`'user'`) submissions still get the ordinary four-case
// reduction with no origin-priority involved at all, proving the fix is scoped to the specific
// cross-origin combination and does not alter `pod-write-queue`'s existing, reviewed rule.
// ---------------------------------------------------------------------------------------

describe('write queue: user-intent priority (10, keep-alive tech-lead resolution 5)', () => {
  it("baseline (unchanged): two same-origin ('user') submissions in one window still resolve by the four-case reduction — secondsRemaining wins, exactly as 8.3's ordering already covers", async () => {
    // Real timers only — see the note on the 8.2 describe block above.
    vi.useRealTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const queue = new WriteQueue({ client: clientFor(pod), snapshot, requestFastPoll: () => {}, timers });

      const p1 = queue.submitSide('left', { isOn: false }); // default origin: 'user'
      const p2 = queue.submitSide('left', { secondsRemaining: 600 }); // default origin: 'user'
      await realDelay(450);
      await Promise.all([p1, p2]);

      expect(pod.state.deviceStatus.left.secondsRemaining).toBe(600); // unchanged baseline outcome
      queue.stop();
    } finally {
      await pod.close();
    }
  });

  it("an explicit user off submitted in the same debounce window as a keep-alive re-arm always turns the side off, with no optimistic-tile reversion (pod-keep-alive spec)", async () => {
    // Real timers only — see the note on the 8.2 describe block above.
    vi.useRealTimers();
    const pod = await startMockPod({ state: { deviceStatus: { left: { secondsRemaining: 43200 } } } });
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const client = clientFor(pod);
      // Seeded so raw left.isOn starts true — the scenario the design.md Risk analysis traced:
      // without the fix, a reversion would be observable as the optimistic "off" overlay never
      // taking hold (or being cleared), falling back to this still-true raw value.
      snapshot.observeDeviceStatus(await client.getDeviceStatus());
      const queue = new WriteQueue({ client, snapshot, requestFastPoll: () => {}, timers });

      const rearm = queue.submitSide('left', { secondsRemaining: 600 }, 'keepAlive');
      const userOff = queue.submitSide('left', { isOn: false }); // default origin: 'user'
      // Synchronous, before either submission's debounce has even started to elapse: the
      // optimistic "off" tile is already in effect and never reverts to the stale raw `true`.
      expect(snapshot.get().left.isOn).toBe(false);

      await realDelay(450);
      await Promise.all([rearm, userOff]);

      expect(pod.state.deviceStatus.left.secondsRemaining).toBe(0); // side ends OFF, not re-armed
      expect(snapshot.get().left.isOn).toBe(false); // still no reversion, post-dispatch
      queue.stop();
    } finally {
      await pod.close();
    }
  });

  it('a keep-alive re-arm alone, with no competing user write in the same window, still refreshes the duration', async () => {
    // Real timers only — see the note on the 8.2 describe block above.
    vi.useRealTimers();
    const pod = await startMockPod();
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const queue = new WriteQueue({ client: clientFor(pod), snapshot, requestFastPoll: () => {}, timers });

      const p = queue.submitSide('left', { secondsRemaining: 600 }, 'keepAlive');
      await realDelay(450);
      await p;

      expect(pod.state.deviceStatus.left.secondsRemaining).toBe(600);
      queue.stop();
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// S4 (hub-accessory PR #44 review): a bounded pre-dispatch refresh keeps the device-lane's
// read-modify-write from clobbering an externally-changed gain with a stale cached one.
// ---------------------------------------------------------------------------------------

describe('write queue: a pre-dispatch refresh keeps device-lane gains fresh (S4 fix)', () => {
  it('awaits refreshDeviceStatus before dispatching, and the dispatched settings carry the freshly observed gain, not the value cached at submission time', async () => {
    const timers = createTimerHarness();
    const snapshot = new SnapshotStore({ timers });
    // Submission-time cache: gainLeft is 400.
    snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    const fake = createFakePodClient({
      deviceStatus: deviceStatusFixture,
      settings: settingsFixture,
      schedules: schedulesFixture,
      services: servicesFixture,
    });
    let refreshCalls = 0;
    const queue = new WriteQueue({
      client: fake.client,
      snapshot,
      requestFastPoll: () => {},
      timers,
      refreshDeviceStatus: () => {
        refreshCalls += 1;
        // Simulates the poller's own bounded GET landing: gainLeft has since been changed
        // externally (e.g. free-sleep's own web UI), independent of this plugin's write.
        snapshot.observeDeviceStatus({
          ...structuredClone(deviceStatusFixture),
          settings: { ...deviceStatusFixture.settings, gainLeft: 999 },
        });
        return Promise.resolve();
      },
    });

    const p = queue.submitDeviceSettings({ ledBrightness: 55 }); // the field this write actually changes
    await vi.advanceTimersByTimeAsync(500);
    await p;

    expect(refreshCalls).toBe(1);
    expect(fake.postDeviceStatusCalls).toEqual([
      { settings: { v: 1, gainLeft: 999, gainRight: 400, ledBrightness: 55 } }, // fresh gainLeft, not the stale 400
    ]);
    queue.stop();
  });

  it('an isPriming-only dispatch never calls refreshDeviceStatus — nothing on that lane needs fresh gains', async () => {
    const timers = createTimerHarness();
    const snapshot = new SnapshotStore({ timers });
    snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
    const fake = createFakePodClient({
      deviceStatus: deviceStatusFixture,
      settings: settingsFixture,
      schedules: schedulesFixture,
      services: servicesFixture,
    });
    let refreshCalls = 0;
    const queue = new WriteQueue({
      client: fake.client,
      snapshot,
      requestFastPoll: () => {},
      timers,
      refreshDeviceStatus: () => {
        refreshCalls += 1;
        return Promise.resolve();
      },
    });

    const p = queue.submitDeviceSettings({ isPriming: true });
    await vi.advanceTimersByTimeAsync(500);
    await p;

    expect(refreshCalls).toBe(0);
    expect(fake.postDeviceStatusCalls).toEqual([{ isPriming: true }]);
    queue.stop();
  });

  it('omitting refreshDeviceStatus entirely (no poller wired) falls back to whatever the snapshot already holds — every existing caller is unaffected', async () => {
    const { queue, fake } = setup();
    const p = queue.submitDeviceSettings({ ledBrightness: 55 });
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([{ settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 55 } }]);
    queue.stop();
  });
});

// ---------------------------------------------------------------------------------------
// settings-switches (#17/#18, tech-lead resolution 1): drain-before-decide — closing the
// ordering hazard between a pending side-lane write and a concurrently-submitted,
// `awayMode`-touching settings-lane write (design.md's "The ordering hazard"). The tech lead's
// condition for approving this mechanism: "the deadlock-avoidance must be proven, not asserted —
// tests covering both submission orders x both settings-POST outcomes (success/failure),
// executed through the real mutex". Every test below runs the real `WriteQueue` (no simplified
// stand-in mutex exists) against `startMockPod()`'s real HTTP mock, under real timers — a true
// deadlock would hang the test past vitest's own per-test timeout rather than silently passing,
// which is the strongest proof available in this suite.
// ---------------------------------------------------------------------------------------

describe('write queue: drain-before-decide (settings-switches, tech-lead resolution 1)', () => {
  /** `left.awayMode` starts `true` on the mock — every test below has `right`'s guard decision
   * hinge on whichever value `left.awayMode` settles to once the concurrent settings write
   * (targeting `left`) resolves, matching the "either side being away is sufficient" rule
   * (away-mode-guard spec) and this suite's own existing 9.6 pattern. */
  async function withAwayGuardPod(fn: (pod: MockPod, queue: WriteQueue, timers: TimerHarness) => Promise<void>): Promise<void> {
    vi.useRealTimers();
    const pod = await startMockPod({ state: { settings: { left: { awayMode: true } } } });
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const client = clientFor(pod);
      snapshot.observeSettings(await client.getSettings());
      const awayModeGuard = new AwayModeGuard({ snapshot, policy: 'block' });
      const queue = new WriteQueue({ client, snapshot, requestFastPoll: () => {}, timers, awayModeGuard });
      try {
        await fn(pod, queue, timers);
      } finally {
        queue.stop();
      }
    } finally {
      await pod.close();
    }
  }

  it(
    "side-first, settings write fails: the side write's away-mode decision is unaffected by the " +
      "settings write's optimistic value — governed by awayMode still true, exactly as if the " +
      'settings write had never been submitted (task 2.2)',
    async () => {
      await withAwayGuardPod(async (pod, queue) => {
        // Exhausts the client's own single retry too (client.test.ts's "regression-proofing"
        // case), so the settings write genuinely, persistently fails.
        pod.fault('POST /api/settings', { kind: 'status', status: 500, times: 2 });

        const sideP = queue.submitSide('right', { targetTemperatureF: 70 });
        sideP.catch(() => undefined);
        const settingsP = queue.submitSettings({ left: { awayMode: false } });
        settingsP.catch(() => undefined);

        await expect(settingsP).rejects.toThrow();
        // Had the pre-fix hazard still been present, `decide()` would have read the settings
        // write's premature `awayMode: false` overlay and let this through as `'plain'` — it
        // must instead still be refused, since the settings write never actually took effect.
        await expect(sideP).rejects.toBeInstanceOf(AwayModeBlockedError);
        expect(pod.requests.filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus')).toHaveLength(0);
      });
    },
  );

  it(
    'side-first, settings write succeeds: no deadlock, and the settings write is observably ' +
      "drained and settled before the side write's own dispatch reaches the Pod",
    async () => {
      await withAwayGuardPod(async (pod, queue) => {
        const sideP = queue.submitSide('right', { targetTemperatureF: 70 });
        const settingsP = queue.submitSettings({ left: { awayMode: false } });

        await Promise.all([sideP, settingsP]); // hangs forever (until vitest's own test timeout) if deadlocked

        const posts = pod.requests.filter((r) => r.method === 'POST' && (r.path === '/api/settings' || r.path === '/api/deviceStatus'));
        expect(posts.map((r) => r.path)).toEqual(['/api/settings', '/api/deviceStatus']);
      });
    },
  );

  it(
    'settings-first, settings write fails: the side write is still correctly governed by ' +
      "awayMode still true — the already-safe order's own decision is unchanged by drain-before-decide (task 2.3)",
    async () => {
      await withAwayGuardPod(async (pod, queue) => {
        pod.fault('POST /api/settings', { kind: 'status', status: 500, times: 2 });

        const settingsP = queue.submitSettings({ left: { awayMode: false } });
        settingsP.catch(() => undefined);
        const sideP = queue.submitSide('right', { targetTemperatureF: 70 });
        sideP.catch(() => undefined);

        await expect(settingsP).rejects.toThrow();
        await expect(sideP).rejects.toBeInstanceOf(AwayModeBlockedError);
        expect(pod.requests.filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus')).toHaveLength(0);
      });
    },
  );

  it('settings-first, settings write succeeds: no deadlock, and the side write dispatches once no longer away (task 2.3 sanity)', async () => {
    await withAwayGuardPod(async (pod, queue) => {
      const settingsP = queue.submitSettings({ left: { awayMode: false } });
      const sideP = queue.submitSide('right', { targetTemperatureF: 70 });

      await Promise.all([settingsP, sideP]);

      expect(pod.requests.filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus')).toHaveLength(1);
    });
  });
});
