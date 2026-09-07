/**
 * `AlarmWindowScheduler` (`src/pod/alarmWindowScheduler.ts`) — window/timer/requestMode tests
 * (alarm-events tasks.md group 4). The pure derivation itself is covered by
 * `test/pod/alarmSchedule.test.ts`; these tests exercise only the recompute-and-reconcile loop,
 * the self-rescheduling timer's clamp, and `stop()`.
 *
 * `poller` is a hand-written fake recording every `requestMode` call and its returned release —
 * `AlarmWindowSchedulerOptions.poller` is typed as the concrete `PodPoller` class (design.md,
 * "imports only snapshot.ts, poller.ts... never writeQueue.ts"), so a fake satisfying just the
 * one method this module calls is handed in via the same `as unknown as PodPoller` escape hatch
 * `platform.ts` already uses for `MinimalPodClient`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AlarmWindowScheduler } from '../../src/pod/alarmWindowScheduler.js';
import type { PodPoller } from '../../src/pod/poller.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import type { DailySchedule, Schedules, Settings, SideSchedule } from '../../src/pod/types.js';
import { createTimerHarness, type TimerHarness } from '../timerHarness.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type Weekday = (typeof WEEKDAYS)[number];

function inertDaily(): DailySchedule {
  return {
    temperatures: {},
    power: { on: '21:00', off: '20:00', onTemperature: 82, enabled: false },
    alarm: { time: '00:00', vibrationIntensity: 60, vibrationPattern: 'rise', duration: 30, enabled: false, alarmTemperature: 80 },
  };
}

function inertSideSchedule(): SideSchedule {
  const side = {} as SideSchedule;
  for (const day of WEEKDAYS) side[day] = inertDaily();
  return side;
}

function emptySchedules(): Schedules {
  return { left: inertSideSchedule(), right: inertSideSchedule() };
}

function utcSettings(): Settings {
  const side = {
    name: 'Side',
    awayMode: false,
    scheduleOverrides: {
      temperatureSchedules: { disabled: false, expiresAt: '' },
      alarm: { disabled: false, timeOverride: '', expiresAt: '' },
    },
    taps: {
      doubleTap: { type: 'temperature' as const, change: 'decrement' as const, amount: 1 },
      tripleTap: { type: 'temperature' as const, change: 'increment' as const, amount: 1 },
      quadTap: { type: 'alarm' as const, behavior: 'dismiss' as const, snoozeDuration: 60, inactiveAlarmBehavior: 'power' as const },
    },
  };
  return {
    id: 'test',
    timeZone: 'UTC',
    left: structuredClone(side),
    right: structuredClone(side),
    primePodDaily: { enabled: false, time: '14:00' },
    temperatureFormat: 'fahrenheit',
    rebootDaily: false,
  };
}

/**
 * Seeds the `left` side with exactly one eligible weekday/time — no calendar-day shift (`power.
 * off: '20:00'`), and `settings.timeZone: 'UTC'` so the instant equals the wall-clock fields
 * directly, no offset arithmetic to reason about in the test.
 *
 * A schedule's `alarm.time` is `HH:mm` — minute granularity only — so `targetMs` is rounded down
 * to the whole minute before use; the actual derived `instantMs` (not `targetMs`) is returned for
 * every caller's own window-math assertions, so a test's own arithmetic never has to duplicate
 * this rounding to stay in sync with what the scheduler actually derives.
 */
function withOneAlarmAt(targetMs: number): { schedules: Schedules; settings: Settings; instantMs: number } {
  const instantMs = Math.floor(targetMs / 60_000) * 60_000;
  const d = new Date(instantMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const weekday: Weekday = WEEKDAYS[d.getUTCDay()]!;

  const schedules = emptySchedules();
  schedules.left[weekday] = {
    temperatures: {},
    power: { on: '21:00', off: '20:00', onTemperature: 82, enabled: true },
    alarm: { time: `${hh}:${mm}`, vibrationIntensity: 60, vibrationPattern: 'rise', duration: 30, enabled: true, alarmTemperature: 80 },
  };
  return { schedules, settings: utcSettings(), instantMs };
}

interface RequestModeCall {
  classId: string;
  options: { intervalMs: number; untilMs: number; reason: string };
}

function createFakePoller(): { poller: PodPoller; calls: RequestModeCall[]; releases: Array<() => void> } {
  const calls: RequestModeCall[] = [];
  const releases: Array<() => void> = [];
  const fake = {
    requestMode: (classId: string, options: RequestModeCall['options']) => {
      calls.push({ classId, options });
      const release = vi.fn();
      releases.push(release);
      return release;
    },
  };
  return { poller: fake as unknown as PodPoller, calls, releases };
}

interface Setup {
  timers: TimerHarness;
  snapshot: SnapshotStore;
  calls: RequestModeCall[];
  releases: Array<() => void>;
  nowMs: number;
  build: (options?: { alarmPollIntervalMs?: number; windowMarginMs?: number }) => AlarmWindowScheduler;
}

function setup(): Setup {
  const timers = createTimerHarness();
  // Aligned to a whole-minute boundary — a schedule's `alarm.time` is `HH:mm` (minute
  // granularity only), so aligning `nowMs` up front means every `nowMs + <round multiple of a
  // minute>` used below round-trips through `withOneAlarmAt`'s minute-floor unchanged, with
  // nothing left to reconcile between a test's own arithmetic and what the scheduler derives.
  // `vi.setSystemTime` moves the fake clock directly, without advancing through it — nothing is
  // scheduled yet at this point, so no timer fires as a side effect.
  const nowMs = Math.ceil(timers.now() / 60_000) * 60_000;
  vi.setSystemTime(nowMs);
  const snapshot = new SnapshotStore({ timers });
  const { poller, calls, releases } = createFakePoller();
  const build = (options: { alarmPollIntervalMs?: number; windowMarginMs?: number } = {}): AlarmWindowScheduler =>
    new AlarmWindowScheduler({
      snapshot,
      poller,
      timers,
      alarmPollIntervalMs: options.alarmPollIntervalMs ?? 3000,
      ...(options.windowMarginMs !== undefined ? { windowMarginMs: options.windowMarginMs } : {}),
    });
  return { timers, snapshot, calls, releases, nowMs, build };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// 4.1 — construction
// ---------------------------------------------------------------------------------------

describe('AlarmWindowScheduler construction (tasks.md 4.1)', () => {
  it('constructs against an empty snapshot with no upcoming alarms and requests nothing', () => {
    const { build, calls } = setup();
    const scheduler = build();
    expect(calls).toHaveLength(0);
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------------------
// recomputeNow() — the platform's post-bootstrap kick (platform.ts's own real-data gap: this
// scheduler is constructed before the platform's bootstrap has populated any schedules/settings
// observation, so its construction-time tick necessarily sees an empty snapshot; platform.ts
// calls this once bootstrap settles).
// ---------------------------------------------------------------------------------------

describe('AlarmWindowScheduler.recomputeNow()', () => {
  it('arms a window whose schedule only became observable after construction, without waiting for the self-rescheduled ceiling tick', () => {
    const { snapshot, calls, nowMs, build } = setup();
    // Nothing observed at construction time — matches platform.ts's own real sequencing (this
    // scheduler is constructed before the poller's bootstrap has run at all).
    const scheduler = build({ windowMarginMs: 180_000 });
    expect(calls).toHaveLength(0);

    const { schedules, settings } = withOneAlarmAt(nowMs + 60_000); // well inside the window
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);

    scheduler.recomputeNow();
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });

  it('replaces the previously-scheduled timer rather than leaving two pending', () => {
    const { snapshot, timers, build } = setup();
    const scheduler = build();
    const before = timers.pendingCount();
    expect(before).toBeGreaterThan(0); // the construction-time tick's own ceiling timer

    scheduler.recomputeNow();
    expect(timers.pendingCount()).toBe(before); // replaced, not added to

    void snapshot;
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 4.2 — recompute-and-reconcile
// ---------------------------------------------------------------------------------------

describe('AlarmWindowScheduler recompute-and-reconcile (tasks.md 4.2)', () => {
  const WINDOW_MARGIN_MS = 180_000;

  it('an instant already inside its window at construction is armed immediately', () => {
    const { snapshot, calls, nowMs, build } = setup();
    const { schedules, settings, instantMs } = withOneAlarmAt(nowMs + 60_000); // 1 min out, well inside ±3 min
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);

    const scheduler = build({ windowMarginMs: WINDOW_MARGIN_MS, alarmPollIntervalMs: 3000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.classId).toBe('deviceStatus');
    expect(calls[0]!.options.reason).toBe('alarm');
    expect(calls[0]!.options.intervalMs).toBe(3000);
    expect(calls[0]!.options.untilMs).toBe(instantMs + WINDOW_MARGIN_MS);
    scheduler.stop();
  });

  it('an instant not yet in its window is armed once the self-rescheduled tick reaches the window start', async () => {
    const { snapshot, calls, nowMs, build } = setup();
    const { schedules, settings, instantMs } = withOneAlarmAt(nowMs + 300_000); // 5 min out
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);

    const scheduler = build({ windowMarginMs: WINDOW_MARGIN_MS });
    expect(calls).toHaveLength(0); // window starts at instantMs - 180_000ms, not yet reached

    await vi.advanceTimersByTimeAsync(instantMs - WINDOW_MARGIN_MS - nowMs);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.untilMs).toBe(instantMs + WINDOW_MARGIN_MS);
    scheduler.stop();
  });

  it('a stale window is withdrawn on the next recompute once its instant no longer appears in the derivation', async () => {
    const { snapshot, calls, releases, nowMs, build } = setup();
    // instantMs = nowMs + 180_000: inside its window at construction (window starts exactly at
    // nowMs) *and* its untilMs (instantMs + 180_000 = nowMs + 360_000) survives past the
    // 300_000ms recompute-ceiling tick below — so that tick's own "tidy already-elapsed entries"
    // step (reconcile's first loop) does not prune it first; the withdrawal below exercises the
    // *stale-but-not-yet-expired* path (design.md's step 3) specifically, not a natural expiry.
    const { schedules, settings } = withOneAlarmAt(nowMs + 180_000); // armed on construction
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);

    const scheduler = build({ windowMarginMs: WINDOW_MARGIN_MS });
    expect(calls).toHaveLength(1);
    expect(releases[0]).not.toHaveBeenCalled();

    // The schedule changes out from under the armed window — disable the alarm entirely, so the
    // next recompute's derivation no longer includes this occurrence at all.
    const disabled = structuredClone(schedules);
    for (const day of WEEKDAYS) disabled.left[day].alarm.enabled = false;
    snapshot.observeSchedules(disabled);

    // No more unarmed occurrences remain, so the scheduler's own next tick was scheduled at the
    // recompute ceiling (300_000ms) after construction's own tick.
    await vi.advanceTimersByTimeAsync(300_000);

    expect(releases[0]).toHaveBeenCalledTimes(1);
    // No new requestMode call was made for the now-absent occurrence.
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 4.3 — self-rescheduling timer clamp
// ---------------------------------------------------------------------------------------

describe('AlarmWindowScheduler self-rescheduling timer (tasks.md 4.3)', () => {
  it('clamps up to MIN_TICK_MS (1000ms) when a window start is imminent but not yet due', async () => {
    const { snapshot, calls, nowMs, build } = setup();
    // A margin deliberately *not* a whole multiple of a minute (unlike `alarm.time`'s own
    // minute granularity), so `windowStart` can land less than 1000ms after `nowMs` — the whole
    // point of this scenario. instantMs = nowMs + 180_000 (already minute-aligned, so
    // `withOneAlarmAt`'s own minute-floor rounding is a no-op here); windowStart = instantMs -
    // 179_500 = nowMs + 500.
    const windowMarginMs = 179_500;
    const { schedules, settings } = withOneAlarmAt(nowMs + 180_000);
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);

    const scheduler = build({ windowMarginMs });
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0); // the clamped tick has not fired yet

    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(1); // fired at the 1000ms floor, windowStart had already passed
    scheduler.stop();
  });

  it('clamps down to RECOMPUTE_CEILING_MS (300_000ms) even when nothing is upcoming soon', async () => {
    const { snapshot, calls, nowMs, build } = setup();
    const windowMarginMs = 180_000;
    // Nothing upcoming at construction time (empty schedules) — the scheduler's own next tick is
    // scheduled at the 300_000ms ceiling, not derived from anything (there is nothing to derive
    // from). An occurrence added immediately afterward whose window will already contain "now" by
    // the time that ceiling tick fires proves the ceiling — not any earlier recompute — is what
    // catches it (mirrors the "schedule edit is eventually reflected" trade-off, design.md's
    // "Recomputation").
    const scheduler = build({ windowMarginMs });
    expect(calls).toHaveLength(0);

    const instantMs = nowMs + 300_000 + 60_000; // window: [nowMs+180_000, nowMs+540_000]
    const { schedules, settings } = withOneAlarmAt(instantMs);
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(calls).toHaveLength(0); // the ceiling tick has not fired yet

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1); // the ceiling tick fired at exactly 300_000ms and caught it
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------------------
// 4.4 — stop()
// ---------------------------------------------------------------------------------------

describe('AlarmWindowScheduler.stop() (tasks.md 4.4)', () => {
  it('cancels the scheduled timer and releases every currently active window', () => {
    const { snapshot, timers, releases, nowMs, build } = setup();
    const { schedules, settings } = withOneAlarmAt(nowMs + 60_000);
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);

    const scheduler = build({ windowMarginMs: 180_000 });
    expect(timers.pendingCount()).toBeGreaterThan(0);
    expect(releases[0]).not.toHaveBeenCalled();

    scheduler.stop();

    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(0);
  });

  it('is idempotent whether or not the timer was ever pending, and stops further recomputation', async () => {
    const { snapshot, timers, calls, nowMs, build } = setup();
    const scheduler = build();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
    expect(timers.pendingCount()).toBe(0);

    // A schedule change and a long time advance after stop() must never re-arm anything.
    const { schedules, settings } = withOneAlarmAt(nowMs + 60_000);
    snapshot.observeSchedules(schedules);
    snapshot.observeSettings(settings);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(calls).toHaveLength(0);
  });
});
