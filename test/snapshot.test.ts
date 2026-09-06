import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultTimerApi, SnapshotStore, type Change } from '../src/pod/snapshot.js';
import type { DeviceStatus, Schedules, Settings, SideStatus } from '../src/pod/types.js';
import { createTimerHarness, type TimerHarness } from './timerHarness.js';
import { startMockPod } from './mockPod.js';
import { loadFixture } from './loadFixture.js';

const deviceStatusFixture = loadFixture('deviceStatus.json') as DeviceStatus;
const settingsFixture = loadFixture('settings.json') as Settings;
const schedulesFixture = loadFixture('schedules.json') as Schedules;

/**
 * A stable, quiescent baseline side — deliberately *not* the fixture's own values (which have
 * `isOn: true` / `secondsRemaining: 1200`), so that two calls to `withDeviceStatus` in the same
 * test differ *only* in the fields explicitly overridden, never in fields the fixture happens
 * to set that a test didn't mean to touch.
 */
const BASELINE_SIDE: SideStatus = {
  currentTemperatureLevel: 0,
  currentTemperatureF: 75,
  targetTemperatureF: 64,
  secondsRemaining: 0,
  isOn: false,
  isAlarmVibrating: false,
};

function withDeviceStatus(overrides: Partial<SideStatus> = {}, side: 'left' | 'right' = 'left'): DeviceStatus {
  const base: DeviceStatus = structuredClone(deviceStatusFixture);
  base.left = { ...BASELINE_SIDE };
  base.right = { ...BASELINE_SIDE };
  base[side] = { ...BASELINE_SIDE, ...overrides };
  return base;
}

// ---------------------------------------------------------------------------------------
// 1. Shared timing plumbing
// ---------------------------------------------------------------------------------------

describe('shared timing plumbing (1.1, 1.2)', () => {
  it('defaultTimerApi.now() tracks Date.now()', () => {
    const before = Date.now();
    const value = defaultTimerApi.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('defaultTimerApi.random() stays within [0, 1) over 1000 draws', () => {
    for (let i = 0; i < 1000; i++) {
      const value = defaultTimerApi.random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('the harness fires exactly the callbacks scheduled at or before n, in scheduled order, and now() advances in lockstep', () => {
    vi.useFakeTimers();
    try {
      const timers = createTimerHarness();
      const fired: string[] = [];
      timers.setTimeout(() => fired.push('a@100'), 100);
      timers.setTimeout(() => fired.push('b@50'), 50);
      timers.setTimeout(() => fired.push('c@150'), 150);

      const before = timers.now();
      vi.advanceTimersByTime(120);
      expect(fired).toEqual(['b@50', 'a@100']);
      expect(timers.now()).toBe(before + 120);

      vi.advanceTimersByTime(100);
      expect(fired).toEqual(['b@50', 'a@100', 'c@150']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 2. State, immutability, synchronous reads
// ---------------------------------------------------------------------------------------

describe('snapshot store: state and immutability (2.1, 2.2, 2.4)', () => {
  let timers: TimerHarness;
  let store: SnapshotStore;

  beforeEach(() => {
    vi.useFakeTimers();
    timers = createTimerHarness();
    store = new SnapshotStore({ timers });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('get() returns a frozen object; mutation attempts do not change later reads; identical reference with no commit in between', () => {
    store.observeDeviceStatus(deviceStatusFixture);
    const first = store.get();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.left)).toBe(true);
    expect(() => {
      (first.left as { targetTemperatureF: number }).targetTemperatureF = 999;
    }).toThrow();
    expect(store.get().left.targetTemperatureF).toBe(deviceStatusFixture.left.targetTemperatureF);
    expect(store.get()).toBe(first);
  });

  it('every class reads as unknown before any commit; a failure does not erase known state', () => {
    expect(store.get().left.targetTemperatureF).toBeUndefined();
    expect(store.get().documents.schedules).toBeUndefined();
    expect(store.get().documents.services).toBeUndefined();

    store.observeDeviceStatus(deviceStatusFixture);
    expect(store.get().left.targetTemperatureF).toBe(deviceStatusFixture.left.targetTemperatureF);

    store.recordDeviceStatusFailure('network');
    expect(store.get().left.targetTemperatureF).toBe(deviceStatusFixture.left.targetTemperatureF);
  });

  it('connection: success/failure/success rises and resets the failure counter, and distinguishes error kinds', () => {
    expect(store.get().connection).toEqual({ online: false, consecutiveFailures: 0, lastSuccessAt: null, lastErrorKind: null });

    store.recordDeviceStatusFailure('network');
    expect(store.get().connection.online).toBe(false);
    expect(store.get().connection.consecutiveFailures).toBe(1);
    expect(store.get().connection.lastErrorKind).toBe('network');

    store.recordDeviceStatusFailure('network');
    expect(store.get().connection.consecutiveFailures).toBe(2);

    store.observeDeviceStatus(deviceStatusFixture);
    expect(store.get().connection.online).toBe(true);
    expect(store.get().connection.consecutiveFailures).toBe(0);
    expect(store.get().connection.lastSuccessAt).toBe(timers.now());

    store.recordDeviceStatusFailure('response');
    expect(store.get().connection.lastErrorKind).toBe('response');
    expect(store.get().connection.lastErrorKind).not.toBe('network');
  });

  it('get() is synchronous and I/O-free: 80 reads while a mock request is in flight add nothing to its recording', async () => {
    vi.useRealTimers();
    const pod = await startMockPod();
    try {
      const { PodClient } = await import('../src/pod/client.js');
      const { hostname, port } = new URL(pod.url);
      const client = new PodClient({ host: hostname, port: Number(port) });
      const inFlight = client.getDeviceStatus();

      const result = store.get();
      expect(result).not.toBeInstanceOf(Promise);
      const before = pod.requests.length;
      for (let i = 0; i < 80; i++) {
        store.get();
      }
      // Nothing about reading the snapshot 80 times can have added to the mock's recording —
      // whatever the in-flight request's own count happens to be by now, it is unaffected by
      // any of these 80 synchronous reads.
      expect(pod.requests.length).toBe(before);

      await inFlight;
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 3. Change notifications
// ---------------------------------------------------------------------------------------

describe('snapshot store: change notifications (3.1-3.5)', () => {
  let store: SnapshotStore;

  beforeEach(() => {
    store = new SnapshotStore();
  });

  it('exhaustively switching on change.field narrows previous/current per field (typecheck-level, 3.1)', () => {
    function describe_(change: Change): string {
      switch (change.field) {
        case 'currentTemperatureF':
        case 'targetTemperatureF':
          return `${change.side}:${change.field} ${change.previous ?? 'unknown'}->${change.current}`;
        case 'isOn':
        case 'isAlarmVibrating':
        case 'awayMode':
          return `${change.side}:${change.field}=${change.current}`;
        case 'waterLevelState':
        case 'isPriming':
        case 'connectionOnline':
          return `${change.field}=${change.current}`;
      }
    }
    const sample: Change = { scope: 'side', field: 'targetTemperatureF', side: 'left', previous: 64, current: 70 };
    expect(describe_(sample)).toBe('left:targetTemperatureF 64->70');

    // @ts-expect-error — 'bogus' is not a member of the watched-field enumeration.
    const invalid: Change = { scope: 'side', field: 'bogus', side: 'left', previous: 1, current: 2 };
    expect(invalid).toBeDefined();
  });

  it('one notification per commit listing every field that changed, not one per field (3.2)', () => {
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 70, isOn: true }));
    expect(received.length).toBe(1);
    const fields = received[0]!.map((c) => c.field);
    expect(fields).toContain('targetTemperatureF');
    expect(fields).toContain('isOn');
  });

  it('reading the snapshot from inside a listener returns the post-commit value (3.2)', () => {
    let seenDuringNotify: number | undefined;
    store.subscribe(() => {
      seenDuringNotify = store.get().left.targetTemperatureF;
    });
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 71 }));
    expect(seenDuringNotify).toBe(71);
  });

  it('an identical commit delivers no notification (3.2)', () => {
    store.observeDeviceStatus(deviceStatusFixture);
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.observeDeviceStatus(structuredClone(deviceStatusFixture));
    expect(received.length).toBe(0);
  });

  it('unsubscribing stops delivery; subscribing/unsubscribing during delivery does not affect who receives it in progress (3.3)', () => {
    const calls: string[] = [];
    let unsubB: () => void = () => undefined;
    const unsubA = store.subscribe(() => {
      calls.push('a');
      unsubB(); // unsubscribe b from *inside* a's own delivery — "a" is delivered first (subscribed first)
    });
    unsubB = store.subscribe(() => calls.push('b'));
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 65 }));
    expect(calls).toEqual(['a', 'b']); // b still got *this* delivery

    calls.length = 0;
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 66 }));
    expect(calls).toEqual(['a']); // but not the next one

    unsubA();
    calls.length = 0;
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 67 }));
    expect(calls).toEqual([]);
  });

  it('secondsRemaining changes deliver no notification, though get() reports the new value (3.4)', () => {
    store.observeDeviceStatus(withDeviceStatus({ secondsRemaining: 100, isOn: true }));
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.observeDeviceStatus(withDeviceStatus({ secondsRemaining: 200, isOn: true }));
    expect(received.length).toBe(0);
    expect(store.get().left.secondsRemaining).toBe(200);
  });

  it('schedules content changes deliver no per-field notification, though the content is readable (3.4)', () => {
    store.observeDeviceStatus(deviceStatusFixture);
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    const changedSchedules: Schedules = structuredClone(schedulesFixture);
    changedSchedules.left.monday.temperatures['22:00'] = 42;
    store.observeSchedules(changedSchedules);
    expect(received.length).toBe(0);
    expect(store.get().documents.schedules).toEqual(changedSchedules);
  });

  it('one bad subscriber does not silence the rest, and the next commit notifies all three again (3.5)', () => {
    const calls: string[] = [];
    store.subscribe(() => {
      calls.push('first');
      throw new Error('boom');
    });
    store.subscribe(() => calls.push('second'));
    store.subscribe(() => calls.push('third'));

    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 68 }));
    expect(calls).toEqual(['first', 'second', 'third']);

    calls.length = 0;
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 69 }));
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('a subscriber that installs an overlay produces a separate, later notification (3.5)', () => {
    // Seed a first commit so the *next* one changes exactly one field, not every
    // previously-unknown field at once.
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 64 }));

    const order: string[] = [];
    store.subscribe((changes) => {
      order.push(`notify:${changes.map((c) => c.field).join(',')}`);
      if (changes.some((c) => c.field === 'targetTemperatureF') && order.length === 1) {
        store.setOverlay('left', 'isOn', true, 15_000);
      }
    });
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 72 }));
    expect(order).toEqual(['notify:targetTemperatureF', 'notify:isOn']);
  });
});

// ---------------------------------------------------------------------------------------
// 4. Optimistic overlay
// ---------------------------------------------------------------------------------------

describe('snapshot store: optimistic overlay (4.1-4.5)', () => {
  let timers: TimerHarness;
  let store: SnapshotStore;

  beforeEach(() => {
    vi.useFakeTimers();
    timers = createTimerHarness();
    store = new SnapshotStore({ timers });
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 64, isOn: false, secondsRemaining: 0 }));
    store.observeSettings(settingsFixture);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('installing an overlay entry changes get() immediately and emits a notification, with no Pod request (4.1)', () => {
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.setOverlay('left', 'targetTemperatureF', 70, 15_000);
    expect(store.get().left.targetTemperatureF).toBe(70);
    expect(received.length).toBe(1);
  });

  it('installing a second entry for the same field replaces value and expiry (4.1)', () => {
    store.setOverlay('left', 'targetTemperatureF', 70, 5_000);
    vi.advanceTimersByTime(1000);
    store.setOverlay('left', 'targetTemperatureF', 75, 15_000);
    expect(store.get().left.targetTemperatureF).toBe(75);
    // Old expiry (5000 from first install => fires at 5000) must have no effect anymore.
    vi.advanceTimersByTime(4500); // total 5500ms from first install
    expect(store.get().left.targetTemperatureF).toBe(75);
  });

  it('attempting to overlay secondsRemaining is rejected (4.1)', () => {
    expect(() =>
      store.setOverlay(
        'left',
        // @ts-expect-error — secondsRemaining is not an OverlayableField.
        'secondsRemaining',
        100,
        15_000,
      ),
    ).toThrow();
  });

  it('a disagreeing observation is suppressed: pin 70, observe 64, get() still reads 70 with zero notifications (4.2)', () => {
    store.setOverlay('left', 'targetTemperatureF', 70, 15_000);
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 64 }));
    expect(store.get().left.targetTemperatureF).toBe(70);
    expect(received.length).toBe(0);
  });

  it('an exact targetTemperatureF match clears the entry silently, and a later disagreement is no longer suppressed (4.3)', () => {
    store.setOverlay('left', 'targetTemperatureF', 70, 15_000);
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));

    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 70 }));
    expect(received.length).toBe(0); // agreement retires silently

    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 64 }));
    expect(store.get().left.targetTemperatureF).toBe(64); // no longer suppressed
    expect(received.length).toBe(1);
  });

  it('an isOn:true entry is cleared by an observation reporting any positive secondsRemaining (4.3)', () => {
    store.setOverlay('left', 'isOn', true, 15_000);
    expect(store.get().left.isOn).toBe(true);

    store.observeDeviceStatus(withDeviceStatus({ isOn: true, secondsRemaining: 12345 }));
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    // Now a disagreeing report should no longer be suppressed, proving the entry is gone.
    store.observeDeviceStatus(withDeviceStatus({ isOn: false, secondsRemaining: 0 }));
    expect(store.get().left.isOn).toBe(false);
    expect(received.length).toBe(1);
  });

  it('expiry with no agreeing observation drops the entry and emits the reversion (4.4)', () => {
    store.setOverlay('left', 'targetTemperatureF', 70, 15_000);
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));

    vi.advanceTimersByTime(15_000);
    expect(store.get().left.targetTemperatureF).toBe(64);
    expect(received.length).toBe(1);
    expect(received[0]).toEqual([{ scope: 'side', field: 'targetTemperatureF', side: 'left', previous: 70, current: 64 }]);
  });

  it('expiry fires even when the Pod never answered again (4.4)', () => {
    store.setOverlay('left', 'targetTemperatureF', 70, 15_000);
    // No observeDeviceStatus call at all between install and expiry.
    vi.advanceTimersByTime(15_000);
    expect(store.get().left.targetTemperatureF).toBe(64);
  });

  it('an agreed entry never reverts, even long after its original expiry (4.5)', () => {
    store.setOverlay('left', 'targetTemperatureF', 70, 15_000);
    vi.advanceTimersByTime(1_000);
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 70 })); // agreement, entry retired

    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    vi.advanceTimersByTime(60_000); // well past the original 15s expiry
    expect(received.length).toBe(0);
    expect(store.get().left.targetTemperatureF).toBe(70);
  });
});
