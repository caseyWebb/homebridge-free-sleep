import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultTimerApi, SnapshotStore, type Change, type OverlayHandle } from '../src/pod/snapshot.js';
import type { DeviceStatus, Schedules, Settings, SideStatus } from '../src/pod/types.js';
import { createTimerHarness, type TimerHarness } from './timerHarness.js';
import { startMockPod } from './mockPod.js';
import { loadFixture } from './loadFixture.js';

const deviceStatusFixture = loadFixture('deviceStatus.json') as DeviceStatus;
const settingsFixture = loadFixture('settings.json') as Settings;
const schedulesFixture = loadFixture('schedules.json') as Schedules;

/**
 * A stable, quiescent baseline side — deliberately *not* whatever the fixture's own values
 * happen to be, so that two calls to `withDeviceStatus` in the same test differ *only* in the
 * fields explicitly overridden, never in fields the fixture happens to set that a test didn't
 * mean to touch. See the writeQueue B1-regression fix: coupling a test's behaviour to an
 * incidental fixture value (rather than an explicit, test-owned baseline like this one) breaks
 * silently the moment the fixture is swapped for different real data.
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
        case 'presencePresent':
        case 'presenceActive':
        case 'vitalsOccupied':
        case 'vitalsActive':
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

  it('two overlay installs for the same key issued back-to-back from inside one notification never alias generations (nit: generation is reserved synchronously, not read back off the possibly-stale overlay map)', () => {
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 64 }));

    const handles: OverlayHandle[] = [];
    let installedBoth = false;
    store.subscribe((changes) => {
      if (!installedBoth && changes.some((c) => c.field === 'isOn')) {
        installedBoth = true;
        // Both installs happen synchronously from inside this notification, before either's own
        // (necessarily deferred, per design.md's "Notification delivery") commit has actually
        // applied — the exact window in which a generation computed from `this.overlay.get(key)`
        // would alias.
        handles.push(store.setOverlay('left', 'targetTemperatureF', 80, 15_000));
        handles.push(store.setOverlay('left', 'targetTemperatureF', 90, 15_000));
      }
    });
    store.observeDeviceStatus(withDeviceStatus({ targetTemperatureF: 64, isOn: true }));

    expect(handles).toHaveLength(2);
    expect(handles[0]!.generation).not.toBe(handles[1]!.generation);
    expect(store.get().left.targetTemperatureF).toBe(90); // the later install wins

    store.clearOverlay(handles[0]!); // stale handle — must not touch the still-live second entry
    expect(store.get().left.targetTemperatureF).toBe(90);

    store.clearOverlay(handles[1]!); // current handle — actually clears it
    expect(store.get().left.targetTemperatureF).toBe(64); // reverts to the raw value
  });
});

// ---------------------------------------------------------------------------------------
// Occupancy change (#19): observePresence / observeVitals (tasks.md 5.3-5.6)
// ---------------------------------------------------------------------------------------

describe('snapshot store: observePresence (5.3, 5.5, 5.6)', () => {
  let store: SnapshotStore;

  beforeEach(() => {
    store = new SnapshotStore();
  });

  it('presencePresent and presenceActive read as unknown before any observation', () => {
    expect(store.get().left.presencePresent).toBeUndefined();
    expect(store.get().left.presenceActive).toBeUndefined();
  });

  it('the first observation never proves; presencePresent reflects it immediately', () => {
    store.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    expect(store.get().left.presencePresent).toBe(false);
    expect(store.get().left.presenceActive).toBe(false); // observed, not yet proven
  });

  it('a second, identical observation still does not prove', () => {
    store.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    store.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    expect(store.get().left.presenceActive).toBe(false);
  });

  it('a third, differing observation proves, and stays proven even if a later one reverts to the baseline', () => {
    store.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    store.observePresence({ left: { present: true, lastUpdatedAt: 't1' } });
    expect(store.get().left.presenceActive).toBe(true);
    expect(store.get().left.presencePresent).toBe(true);

    store.observePresence({ left: { present: false, lastUpdatedAt: 't0' } }); // reverts to baseline
    expect(store.get().left.presenceActive).toBe(true); // still proven — sticky
    expect(store.get().left.presencePresent).toBe(false); // but the raw flag follows the latest observation
  });

  it('both sides update from a single observation, independently', () => {
    store.observePresence({
      left: { present: false, lastUpdatedAt: 't0' },
      right: { present: true, lastUpdatedAt: 't0' },
    });
    expect(store.get().left.presencePresent).toBe(false);
    expect(store.get().right.presencePresent).toBe(true);

    store.observePresence({
      left: { present: false, lastUpdatedAt: 't1' },
      right: { present: true, lastUpdatedAt: 't0' },
    });
    expect(store.get().left.presenceActive).toBe(true); // left changed from its baseline
    expect(store.get().right.presenceActive).toBe(false); // right has not
  });

  it('an entry absent from a later observation does not un-prove a side already proven', () => {
    store.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    store.observePresence({ left: { present: true, lastUpdatedAt: 't1' } }); // proves left
    expect(store.get().left.presenceActive).toBe(true);

    store.observePresence({}); // this observation says nothing about either side
    expect(store.get().left.presenceActive).toBe(true); // proof-of-life bookkeeping is untouched
  });

  it('a presencePresent change is a watched field producing exactly one notification', () => {
    store.observePresence({ left: { present: false, lastUpdatedAt: 't0' } });
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.observePresence({ left: { present: true, lastUpdatedAt: 't1' } });
    expect(received).toHaveLength(1);
    const fields = received[0]!.map((c) => c.field);
    expect(fields).toContain('presencePresent');
    expect(fields).toContain('presenceActive');
  });
});

describe('snapshot store: observeVitals (5.4, 5.5, 5.6)', () => {
  let store: SnapshotStore;

  beforeEach(() => {
    store = new SnapshotStore();
  });

  it('vitalsOccupied and vitalsActive read as unknown before any observation', () => {
    expect(store.get().left.vitalsOccupied).toBeUndefined();
    expect(store.get().left.vitalsActive).toBeUndefined();
  });

  it('an empty array leaves vitalsProven at its prior value for both sides (never regresses)', () => {
    store.observeVitals([]);
    expect(store.get().left.vitalsActive).toBe(false); // observed (empty), not proven
    expect(store.get().left.vitalsOccupied).toBe(false);
  });

  it('a non-empty array for one side proves only that side, immediately — no second observation required', () => {
    store.observeVitals([{ id: 1, side: 'left', timestamp: 't0', heart_rate: 60, hrv: null, breathing_rate: null }]);
    expect(store.get().left.vitalsActive).toBe(true);
    expect(store.get().left.vitalsOccupied).toBe(true);
    expect(store.get().right.vitalsActive).toBe(false);
    expect(store.get().right.vitalsOccupied).toBe(false);
  });

  it('a later empty array does not un-prove it; only vitalsOccupied changes', () => {
    store.observeVitals([{ id: 1, side: 'left', timestamp: 't0', heart_rate: 60, hrv: null, breathing_rate: null }]);
    store.observeVitals([]);
    expect(store.get().left.vitalsActive).toBe(true); // still proven
    expect(store.get().left.vitalsOccupied).toBe(false); // no longer occupied
  });

  it('a row with a null heart_rate does not count as occupied, but still proves the side live', () => {
    store.observeVitals([{ id: 1, side: 'left', timestamp: 't0', heart_rate: null, hrv: 40, breathing_rate: 14 }]);
    expect(store.get().left.vitalsOccupied).toBe(false);
    expect(store.get().left.vitalsActive).toBe(true);
  });

  it('a vitalsOccupied change is a watched field producing exactly one notification', () => {
    store.observeVitals([]);
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.observeVitals([{ id: 1, side: 'left', timestamp: 't0', heart_rate: 60, hrv: null, breathing_rate: null }]);
    expect(received).toHaveLength(1);
    const fields = received[0]!.map((c) => c.field);
    expect(fields).toContain('vitalsOccupied');
    expect(fields).toContain('vitalsActive');
  });

  it('a commit that changes only vitalsOccupied produces exactly one notification carrying that one field', () => {
    // Prove both sides live first, so a later empty/non-empty transition changes only
    // vitalsOccupied, not vitalsActive too (pod-snapshot's "one notification per commit").
    store.observeVitals([
      { id: 1, side: 'left', timestamp: 't0', heart_rate: 60, hrv: null, breathing_rate: null },
      { id: 2, side: 'right', timestamp: 't0', heart_rate: 60, hrv: null, breathing_rate: null },
    ]);
    const received: Array<readonly Change[]> = [];
    store.subscribe((changes) => received.push(changes));
    store.observeVitals([{ id: 3, side: 'right', timestamp: 't1', heart_rate: 60, hrv: null, breathing_rate: null }]);
    expect(received).toHaveLength(1);
    expect(received[0]!.map((c) => c.field)).toEqual(['vitalsOccupied']);
    expect(received[0]![0]).toMatchObject({ side: 'left', current: false });
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
