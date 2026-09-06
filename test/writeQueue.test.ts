import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PodClient } from '../src/pod/client.js';
import { SnapshotStore } from '../src/pod/snapshot.js';
import { WriteQueue, WriteQueueStoppedError, type SidePatch, type WriteQueueOptions } from '../src/pod/writeQueue.js';
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
  fastPollRequests: number[];
  queue: WriteQueue;
}

function setup(options: Partial<Omit<WriteQueueOptions, 'client' | 'snapshot' | 'requestFastPoll' | 'timers'>> = {}): Setup {
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  snapshot.observeDeviceStatus(structuredClone(deviceStatusFixture));
  snapshot.observeSettings(structuredClone(settingsFixture));
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings: settingsFixture,
    schedules: schedulesFixture,
    services: servicesFixture,
  });
  const fastPollRequests: number[] = [];
  const queue = new WriteQueue({
    client: fake.client,
    snapshot,
    requestFastPoll: (untilMs) => fastPollRequests.push(untilMs),
    timers,
    ...options,
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
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([pDevice, pSettings]);
    expect(fake.postDeviceStatusCalls).toEqual([{ settings: { ledBrightness: 40 } }]);
    expect(fake.postSettingsCalls).toEqual([{ primePodDaily: { enabled: false } }]);
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
      const p2 = queue.submitSettings({ left: { awayMode: true } });
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
    expect(fastPollRequests[0]).toBe(timers.now() + 90_000);
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

describe('write queue: no policy (9.6)', () => {
  it('an away-mode write is dispatched unmodified — the queue does not guard it', async () => {
    const { queue, fake, snapshot } = setup();
    snapshot.observeSettings({ ...structuredClone(settingsFixture), left: { ...settingsFixture.left, awayMode: true } });
    const p = queue.submitSide('right', { targetTemperatureF: 68 });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(fake.postDeviceStatusCalls).toEqual([{ right: { targetTemperatureF: 68 } }]);
    queue.stop();
  });

  it("with the real mock, the Pod's own away-mode mirroring still applies — the queue neither knows nor blocks it", async () => {
    // Real timers only — see the note on the 8.2 describe block above.
    vi.useRealTimers();
    const pod = await startMockPod({ state: { settings: { left: { awayMode: true } } } });
    try {
      const timers = createTimerHarness();
      const snapshot = new SnapshotStore({ timers });
      const client = clientFor(pod);
      const queue = new WriteQueue({ client, snapshot, requestFastPoll: () => {}, timers });
      const p = queue.submitSide('right', { targetTemperatureF: 90 });
      await realDelay(450);
      await p;
      const status = await client.getDeviceStatus();
      expect(status.left.targetTemperatureF).toBe(90);
      expect(status.right.targetTemperatureF).toBe(90);
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
});
