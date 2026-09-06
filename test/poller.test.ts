import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PodPoller } from '../src/pod/poller.js';
import { SnapshotStore, type EffectiveSnapshot, type Logger, type TimerApi } from '../src/pod/snapshot.js';
import type { DeviceStatus, Schedules, Services, Settings } from '../src/pod/types.js';
import { createFakePodClient, type FakePodClient } from './fakePodClient.js';
import { createTimerHarness, type TimerHarness } from './timerHarness.js';
import { loadFixture } from './loadFixture.js';

const deviceStatusFixture = loadFixture('deviceStatus.json') as DeviceStatus;
const settingsFixture = loadFixture('settings.json') as Settings;
const schedulesFixture = loadFixture('schedules.json') as Schedules;
const servicesFixture = loadFixture('services.json') as Services;

interface Setup {
  timers: TimerHarness;
  snapshot: SnapshotStore;
  fake: FakePodClient;
  logs: { warn: string[]; debug: string[] };
  poller: PodPoller;
}

function setup(options: Partial<ConstructorParameters<typeof PodPoller>[0]> = {}): Setup {
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  const fake = createFakePodClient({
    deviceStatus: deviceStatusFixture,
    settings: settingsFixture,
    schedules: schedulesFixture,
    services: servicesFixture,
  });
  const logs: { warn: string[]; debug: string[] } = { warn: [], debug: [] };
  const logger: Logger = { warn: (m) => logs.warn.push(m), debug: (m) => logs.debug.push(m) };
  const poller = new PodPoller({
    client: fake.client,
    snapshot,
    timers,
    logger,
    pollIntervalMs: 5000,
    slowPollIntervalMs: 60000,
    ...options,
  });
  return { timers, snapshot, fake, logs, poller };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 5. Classes, cadence, jitter
// ---------------------------------------------------------------------------------------

describe('poller: classes, cadence (5.1, 5.2)', () => {
  it('one period produces exactly one request per class, and the snapshot is updated from each (5.1)', async () => {
    const { fake, snapshot, poller } = setup();
    await poller.bootstrap();
    expect(fake.deviceStatus.calls).toBe(1);
    expect(fake.settings.calls).toBe(1);
    expect(fake.schedules.calls).toBe(1);
    expect(fake.services.calls).toBe(1);
    expect(snapshot.get().left.targetTemperatureF).toBe(deviceStatusFixture.left.targetTemperatureF);
    expect(snapshot.get().documents.settings).toEqual(settingsFixture);
    expect(snapshot.get().documents.schedules).toEqual(schedulesFixture);
    expect(snapshot.get().documents.services).toEqual(servicesFixture);
    poller.stop();
  });

  it('classes are scheduled independently: deviceStatus fires again while the slow classes do not (5.1)', async () => {
    const { fake, poller } = setup();
    await poller.bootstrap();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.deviceStatus.calls).toBe(2);
    expect(fake.settings.calls).toBe(1);
    expect(fake.schedules.calls).toBe(1);
    expect(fake.services.calls).toBe(1);
    poller.stop();
  });

  it('a configured deviceStatus interval below 5000ms is clamped, with a warning naming both values (5.2)', () => {
    const { logs, poller } = setup({ pollIntervalMs: 1000 });
    expect(logs.warn.some((m) => m.includes('1000') && m.includes('5000'))).toBe(true);
    poller.stop();
  });

  it('a configured slow-class interval below 60000ms is clamped, with a warning naming both values (5.2)', () => {
    const { logs, poller } = setup({ slowPollIntervalMs: 10_000 });
    expect(logs.warn.some((m) => m.includes('10000') && m.includes('60000'))).toBe(true);
    poller.stop();
  });

  it('no computed delay is ever below the 3000ms hard floor, regardless of caller (5.2)', async () => {
    const { fake, poller } = setup();
    await poller.bootstrap();
    poller.requestMode('deviceStatus', { intervalMs: 100, untilMs: Infinity, reason: 'test' });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(2);
    poller.stop();
  });
});

describe('poller: jitter (5.3)', () => {
  it('random: () => 0.5 yields exactly the effective interval', async () => {
    const { fake, poller, timers } = setup();
    timers.random = () => 0.5;
    await poller.bootstrap();
    await vi.advanceTimersByTimeAsync(4999);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(2);
    poller.stop();
  });

  it('random: () => 0 yields the -10% bound', async () => {
    const { fake, poller, timers } = setup();
    timers.random = () => 0;
    await poller.bootstrap();
    await vi.advanceTimersByTimeAsync(4499);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(2);
    poller.stop();
  });

  it('random: () => 1 yields the +10% bound', async () => {
    const { fake, poller, timers } = setup();
    timers.random = () => 1;
    await poller.bootstrap();
    await vi.advanceTimersByTimeAsync(5499);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(2);
    poller.stop();
  });

  it('a real random source over 50 scheduled delays produces at least two distinct values, all within bounds', async () => {
    const { fake, poller, timers } = setup();
    timers.random = Math.random;
    const callTimes: number[] = [];
    const originalGet = fake.client.getDeviceStatus.bind(fake.client);
    fake.client.getDeviceStatus = ((signal?: AbortSignal) => {
      callTimes.push(timers.now());
      return originalGet(signal);
    }) as typeof fake.client.getDeviceStatus;

    await poller.bootstrap();
    // Each window is the maximum possible single delay (5500ms); two delays can never sum to
    // less than 9000ms (each is >= 4500ms), so exactly one new firing lands per window.
    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(5500);
    }
    poller.stop();

    expect(callTimes.length).toBeGreaterThanOrEqual(51);
    const gaps = callTimes.slice(1, 51).map((t, i) => t - callTimes[i]!);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(4500);
      expect(gap).toBeLessThanOrEqual(5500);
    }
    expect(new Set(gaps).size).toBeGreaterThanOrEqual(2);
  });
});

describe('poller: in-flight suppression (5.4)', () => {
  it('a poll spanning three intervals results in exactly one in-flight request, and no burst on recovery', async () => {
    const { fake, poller } = setup();
    await poller.bootstrap();
    expect(fake.deviceStatus.calls).toBe(1);

    const control = fake.deviceStatus.queueDeferred();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.deviceStatus.calls).toBe(2); // now hanging

    await vi.advanceTimersByTimeAsync(5000 * 3);
    expect(fake.deviceStatus.calls).toBe(2); // still exactly one in flight — no backlog

    control.resolve(deviceStatusFixture);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fake.deviceStatus.calls).toBe(2); // one full interval after settle, not immediately
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(3);
    poller.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 6. Modes, backoff, bootstrap, lifecycle
// ---------------------------------------------------------------------------------------

describe('poller: requestMode (6.1)', () => {
  it('the shortest active request wins; releasing it falls back to the next shortest, then base', async () => {
    const { fake, poller, timers } = setup();
    timers.random = () => 0.5;
    await poller.bootstrap();
    const release5 = poller.requestMode('deviceStatus', { intervalMs: 5000, untilMs: Infinity, reason: 'a' });
    const release3 = poller.requestMode('deviceStatus', { intervalMs: 3000, untilMs: Infinity, reason: 'b' });

    await vi.advanceTimersByTimeAsync(2999);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(2); // fired at 3000, the shorter of the two

    release3();
    await vi.advanceTimersByTimeAsync(4999);
    expect(fake.deviceStatus.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(3); // now on the 5000ms mode

    release5();
    poller.stop();
  });

  it('a shorter interval becoming effective mid-delay reschedules from the last poll rather than waiting the old delay out', async () => {
    const { fake, poller } = setup();
    await poller.bootstrap();
    await vi.advanceTimersByTimeAsync(4000); // 4000ms into the pending 5000ms base delay
    expect(fake.deviceStatus.calls).toBe(1);
    poller.requestMode('deviceStatus', { intervalMs: 100, untilMs: Infinity, reason: 'urgent' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.deviceStatus.calls).toBe(2); // pulled in immediately, not at the old t=5000
    poller.stop();
  });

  it('expiry of the only active mode restores the base cadence, measured from the last poll', async () => {
    const { fake, poller, timers } = setup();
    timers.random = () => 0.5;
    await poller.bootstrap();
    poller.requestMode('deviceStatus', { intervalMs: 4000, untilMs: timers.now() + 4500, reason: 'burst' });

    await vi.advanceTimersByTimeAsync(3999);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // t=4000, still under the 4000ms mode
    expect(fake.deviceStatus.calls).toBe(2);

    // mode expires at t=4500; next base-cadence poll lands at lastPollAt(4000) + 5000 = 9000
    await vi.advanceTimersByTimeAsync(4999); // t=8999
    expect(fake.deviceStatus.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // t=9000
    expect(fake.deviceStatus.calls).toBe(3);
    poller.stop();
  });

  it('an arbitrary interval (e.g. a 3s alarm window) is accepted through the same mechanism', async () => {
    const { fake, poller } = setup();
    await poller.bootstrap();
    const release = poller.requestMode('deviceStatus', { intervalMs: 3000, untilMs: Infinity, reason: 'alarm' });
    await vi.advanceTimersByTimeAsync(2999);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(2);
    release();
    poller.stop();
  });
});

describe('poller: priming mode (6.2)', () => {
  it('priming holds the fast cadence for as long as it persists, then returns to base', async () => {
    const { fake, poller, snapshot, timers } = setup({ fastPollIntervalMs: 4000 });
    timers.random = () => 0.5;
    const priming = structuredClone(deviceStatusFixture);
    priming.isPriming = true;
    fake.deviceStatus.setFallback(priming);

    await poller.bootstrap();
    expect(snapshot.get().isPriming).toBe(true);
    expect(fake.deviceStatus.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(3999);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // t=4000
    expect(fake.deviceStatus.calls).toBe(2); // still priming, still fast (4000ms, not the 5000ms base)

    await vi.advanceTimersByTimeAsync(4000); // t=8000
    expect(fake.deviceStatus.calls).toBe(3);

    const cleared = structuredClone(deviceStatusFixture);
    cleared.isPriming = false;
    fake.deviceStatus.setFallback(cleared);
    await vi.advanceTimersByTimeAsync(4000); // t=12000 — this observation reports priming has ended
    expect(fake.deviceStatus.calls).toBe(4);
    expect(snapshot.get().isPriming).toBe(false);

    // back to the 5000ms base, measured from this last poll (t=12000)
    await vi.advanceTimersByTimeAsync(4999); // t=16999
    expect(fake.deviceStatus.calls).toBe(4);
    await vi.advanceTimersByTimeAsync(1); // t=17000
    expect(fake.deviceStatus.calls).toBe(5);
    poller.stop();
  });
});

describe('poller: backoff and recovery (6.3)', () => {
  it('delays grow ~10/20/40/60/60s and stay capped', async () => {
    const { fake, poller, timers } = setup({ maxBackoffMs: 60_000 });
    timers.random = () => 0.5;
    fake.deviceStatus.queueError(new Error('boom'));
    await poller.bootstrap();
    let expected = 1;
    expect(fake.deviceStatus.calls).toBe(expected);

    for (const gap of [10_000, 20_000, 40_000, 60_000, 60_000]) {
      fake.deviceStatus.queueError(new Error('boom'));
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(fake.deviceStatus.calls).toBe(expected);
      await vi.advanceTimersByTimeAsync(1);
      expected += 1;
      expect(fake.deviceStatus.calls).toBe(expected);
    }
    poller.stop();
  });

  it('backoff never outpaces a slow (5 minute) class', async () => {
    const { fake, poller, timers } = setup({ slowPollIntervalMs: 300_000, maxBackoffMs: 60_000 });
    timers.random = () => 0.5;
    fake.settings.queueError(new Error('boom'));
    await poller.bootstrap();
    expect(fake.settings.calls).toBe(1);

    fake.settings.queueError(new Error('boom'));
    await vi.advanceTimersByTimeAsync(300_000 - 1);
    expect(fake.settings.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.settings.calls).toBe(2); // stayed ~300s, never dropped to the 60s cap
    poller.stop();
  });

  it('one success returns the next gap to the effective interval, with no gradual recovery', async () => {
    const { fake, poller, timers } = setup({ maxBackoffMs: 60_000 });
    timers.random = () => 0.5;
    fake.deviceStatus.queueError(new Error('boom'));
    await poller.bootstrap();
    expect(fake.deviceStatus.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000 - 1);
    expect(fake.deviceStatus.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(2); // succeeds (fallback)

    await vi.advanceTimersByTimeAsync(4999);
    expect(fake.deviceStatus.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.deviceStatus.calls).toBe(3); // snapped back to 5000, not 20000
    poller.stop();
  });

  it('polling survives an hour-long outage and updates as soon as the Pod returns', async () => {
    const { fake, poller, snapshot, timers } = setup({ maxBackoffMs: 60_000 });
    timers.random = () => 0.5;
    for (let i = 0; i < 200; i++) fake.deviceStatus.queueError(new Error('down'));
    await poller.bootstrap();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(snapshot.get().connection.online).toBe(false);
    expect(fake.deviceStatus.calls).toBeGreaterThan(10);

    fake.deviceStatus.clearQueue(); // "the Pod returns" — next attempt succeeds via the fallback
    await vi.advanceTimersByTimeAsync(60_000); // the backed-off delay is at most 60s
    expect(snapshot.get().connection.online).toBe(true);
    poller.stop();
  });
});

describe('poller: bootstrap (6.4)', () => {
  it('an all-failing Pod still resolves bootstrap, leaves every class unknown, logs failures, and keeps polling', async () => {
    const { fake, poller, snapshot, logs } = setup({ bootstrapTimeoutMs: 1000 });
    fake.deviceStatus.queueError(new Error('boom'));
    fake.settings.queueError(new Error('boom'));
    fake.schedules.queueError(new Error('boom'));
    fake.services.queueError(new Error('boom'));

    await poller.bootstrap();
    expect(snapshot.get().left.targetTemperatureF).toBeUndefined();
    expect(snapshot.get().documents.settings).toBeUndefined();
    expect(logs.warn.length).toBeGreaterThanOrEqual(4);

    await vi.advanceTimersByTimeAsync(10_000); // deviceStatus's post-failure gap
    expect(fake.deviceStatus.calls).toBe(2);
    poller.stop();
  });

  it('a hanging Pod does not stall bootstrap past its deadline, and a late response still commits', async () => {
    const { fake, poller, snapshot } = setup({ bootstrapTimeoutMs: 2000 });
    const control = fake.deviceStatus.queueDeferred();
    const bootstrapDone = poller.bootstrap();
    await vi.advanceTimersByTimeAsync(2000);
    await bootstrapDone;
    expect(snapshot.get().left.targetTemperatureF).toBeUndefined();

    control.resolve(deviceStatusFixture);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot.get().left.targetTemperatureF).toBe(deviceStatusFixture.left.targetTemperatureF);
    poller.stop();
  });
});

describe('poller: refresh (6.5)', () => {
  it('a refresh mid-period issues exactly one request and updates the snapshot', async () => {
    const { fake, poller, snapshot } = setup({ slowPollIntervalMs: 300_000 });
    await poller.bootstrap();
    expect(fake.settings.calls).toBe(1);

    const changed = structuredClone(settingsFixture);
    changed.timeZone = 'America/Los_Angeles';
    fake.settings.queueValue(changed);

    await poller.refresh('settings');
    expect(fake.settings.calls).toBe(2);
    expect(snapshot.get().documents.settings?.timeZone).toBe('America/Los_Angeles');
    poller.stop();
  });

  it('a refresh during an in-flight poll issues no second request and settles with that poll\'s outcome', async () => {
    const { fake, poller, snapshot } = setup({ slowPollIntervalMs: 300_000 });
    await poller.bootstrap();

    const control = fake.settings.queueDeferred();
    const first = poller.refresh('settings');
    expect(fake.settings.calls).toBe(2);
    const second = poller.refresh('settings');
    expect(fake.settings.calls).toBe(2); // attached, not a new request

    const changed = structuredClone(settingsFixture);
    changed.timeZone = 'Europe/Berlin';
    control.resolve(changed);
    await Promise.all([first, second]);

    expect(fake.settings.calls).toBe(2);
    expect(snapshot.get().documents.settings?.timeZone).toBe('Europe/Berlin');
    poller.stop();
  });
});

describe('poller: stop() (6.6)', () => {
  it('cancels every pending timer; an outstanding request commits nothing when it resolves later', async () => {
    const { fake, poller, snapshot, timers } = setup();
    await poller.bootstrap();
    const control = fake.deviceStatus.queueDeferred();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.deviceStatus.calls).toBe(2);

    poller.stop();
    expect(timers.pendingCount()).toBe(0);

    const distinguishable = structuredClone(deviceStatusFixture);
    distinguishable.waterLevel = 'false';
    control.resolve(distinguishable);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot.get().waterLevelState).not.toBe('low');

    // Idempotent, and still leaves nothing scheduled.
    poller.stop();
    expect(timers.pendingCount()).toBe(0);
  });

  it('leaves no pending timers behind a normal run (test exits cleanly)', async () => {
    const { poller, timers } = setup();
    await poller.bootstrap();
    await vi.advanceTimersByTimeAsync(5000);
    poller.stop();
    expect(timers.pendingCount()).toBe(0);
  });
});

describe('poller: stop() guards further Pod contact (S3 regression)', () => {
  it('refresh() called after stop() issues no request', async () => {
    const { fake, poller } = setup({ slowPollIntervalMs: 300_000 });
    await poller.bootstrap();
    poller.stop();

    const before = fake.settings.calls;
    await poller.refresh('settings');
    expect(fake.settings.calls).toBe(before);
  });

  it('bootstrap() called after stop() issues no request at all', async () => {
    const { fake, poller } = setup();
    poller.stop();

    await poller.bootstrap();
    expect(fake.deviceStatus.calls).toBe(0);
    expect(fake.settings.calls).toBe(0);
    expect(fake.schedules.calls).toBe(0);
    expect(fake.services.calls).toBe(0);
  });
});

describe('poller: per-class enabled predicate (S4 regression)', () => {
  it('a class gated on a snapshot field is skipped while disabled, keeps its own schedule, and re-enables itself once the field flips — with no external kick', async () => {
    const { fake, poller, snapshot, timers } = setup({ slowPollIntervalMs: 60_000 });
    timers.random = () => 0.5;

    // Reach into the private class registry to gate the (otherwise-unused-here) `services`
    // class on a snapshot field — exactly the shape #19 will wire for real
    // (design.md: "the `enabled` predicate is there so #19 can gate on
    // `services.biometrics.enabled`"). No public constructor option exists for this yet, since
    // none of the four shipped classes needs it — this test exercises the mechanism itself.
    const internal = poller as unknown as {
      classes: Map<string, { spec: { enabled?: (snapshot: EffectiveSnapshot) => boolean } }>;
    };
    internal.classes.get('services')!.spec.enabled = (s) => s.left.awayMode === true;

    await poller.bootstrap();
    expect(fake.services.calls).toBe(0); // disabled at bootstrap — no observed awayMode yet
    expect(fake.deviceStatus.calls).toBe(1); // the other three classes are unaffected
    expect(fake.settings.calls).toBe(1);
    expect(fake.schedules.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000); // one full slow-class period
    expect(fake.services.calls).toBe(0); // still disabled — the schedule kept running, the request was skipped

    snapshot.observeSettings({
      ...settingsFixture,
      left: { ...settingsFixture.left, awayMode: true },
    });
    await vi.advanceTimersByTimeAsync(60_000); // next scheduled check re-evaluates and finds it enabled
    expect(fake.services.calls).toBe(1); // re-enabled itself — no refresh()/requestMode() call was needed
    poller.stop();
  });
});

describe('poller: nothing escapes the injected clock (6.7)', () => {
  it('a TimerApi whose now() never advances and whose setTimeout never fires produces no poll, backoff, or mode expiry, ever', async () => {
    const frozenTimers: TimerApi = {
      setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
      now: () => 0,
      random: () => 0.5,
    };
    const snapshot = new SnapshotStore({ timers: frozenTimers });
    const fake = createFakePodClient({
      deviceStatus: deviceStatusFixture,
      settings: settingsFixture,
      schedules: schedulesFixture,
      services: servicesFixture,
    });
    const poller = new PodPoller({
      client: fake.client,
      snapshot,
      timers: frozenTimers,
      pollIntervalMs: 5000,
      slowPollIntervalMs: 60_000,
    });
    poller.requestMode('deviceStatus', { intervalMs: 1000, untilMs: 2000, reason: 'x' });
    await poller.bootstrap();
    const callsAfterBootstrap = fake.deviceStatus.calls;

    await Promise.resolve();
    await Promise.resolve();

    expect(fake.deviceStatus.calls).toBe(callsAfterBootstrap);
    poller.stop();
  });
});
