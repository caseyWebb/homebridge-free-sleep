/**
 * Pure derivation-logic tests for `src/pod/alarmSchedule.ts` (alarm-events tasks.md groups 2
 * and 3). No timers, no I/O — every test calls the module's exported pure functions directly
 * with an explicit `nowMs`.
 */
import { describe, expect, it } from 'vitest';

import {
  alarmWeekdayFor,
  deriveUpcomingAlarms,
  isAlarmEligible,
  isRegularOccurrenceSuppressed,
  nextOccurrenceOfTime,
  nextOccurrenceOfWeekdayTime,
  WEEKDAYS,
  type Weekday,
} from '../../src/pod/alarmSchedule.js';
import type { DailySchedule, Schedules, Settings, Side, SideSchedule, SideSettings } from '../../src/pod/types.js';

// ---------------------------------------------------------------------------------------
// Builders — every field defaulted to "inert" (disabled/empty) so a test only overrides what
// it cares about.
// ---------------------------------------------------------------------------------------

function dailySchedule(overrides: {
  power?: Partial<DailySchedule['power']>;
  alarm?: Partial<DailySchedule['alarm']>;
} = {}): DailySchedule {
  return {
    temperatures: {},
    power: { on: '21:00', off: '07:00', onTemperature: 82, enabled: false, ...overrides.power },
    alarm: {
      time: '06:45',
      vibrationIntensity: 60,
      vibrationPattern: 'rise',
      duration: 30,
      enabled: false,
      alarmTemperature: 80,
      ...overrides.alarm,
    },
  };
}

function inertSideSchedule(overrides: Partial<Record<Weekday, DailySchedule>> = {}): SideSchedule {
  const base = {} as SideSchedule;
  for (const day of WEEKDAYS) {
    base[day] = overrides[day] ?? dailySchedule();
  }
  return base;
}

interface SideSettingsOverrides extends Partial<Omit<SideSettings, 'scheduleOverrides'>> {
  scheduleOverrides?: {
    temperatureSchedules?: Partial<SideSettings['scheduleOverrides']['temperatureSchedules']>;
    alarm?: Partial<SideSettings['scheduleOverrides']['alarm']>;
  };
}

function sideSettings(overrides: SideSettingsOverrides = {}): SideSettings {
  const { scheduleOverrides, ...rest } = overrides;
  return {
    name: 'Side',
    awayMode: false,
    taps: {
      doubleTap: { type: 'temperature', change: 'decrement', amount: 1 },
      tripleTap: { type: 'temperature', change: 'increment', amount: 1 },
      quadTap: { type: 'alarm', behavior: 'dismiss', snoozeDuration: 60, inactiveAlarmBehavior: 'power' },
    },
    ...rest,
    scheduleOverrides: {
      temperatureSchedules: { disabled: false, expiresAt: '', ...scheduleOverrides?.temperatureSchedules },
      alarm: { disabled: false, timeOverride: '', expiresAt: '', ...scheduleOverrides?.alarm },
    },
  };
}

function settingsDoc(overrides: { timeZone?: string; left?: SideSettingsOverrides; right?: SideSettingsOverrides } = {}): Settings {
  return {
    id: 'test',
    timeZone: overrides.timeZone ?? 'Asia/Tokyo',
    left: sideSettings(overrides.left),
    right: sideSettings(overrides.right),
    primePodDaily: { enabled: false, time: '14:00' },
    temperatureFormat: 'fahrenheit',
    rebootDaily: false,
  };
}

function schedulesDoc(overrides: { left?: Partial<Record<Weekday, DailySchedule>>; right?: Partial<Record<Weekday, DailySchedule>> } = {}): Schedules {
  return {
    left: inertSideSchedule(overrides.left),
    right: inertSideSchedule(overrides.right),
  };
}

// ---------------------------------------------------------------------------------------
// 2.2 — calendar-day shift (jobs/utils.ts's isEndTimeNextDay)
// ---------------------------------------------------------------------------------------

describe('alarmWeekdayFor — calendar-day shift (tasks.md 2.2)', () => {
  it.each([
    ['00:00', true],
    ['06:59', true],
    ['12:00', true], // upstream's exact boundary: hour <= 12 shifts
    ['12:59', true], // Number('12:59'.split(':')[0]) === 12 -> still shifts
    ['13:00', false],
    ['20:00', false],
    ['23:59', false],
  ] as const)('power.off %s -> shifts forward: %s', (powerOff, shifts) => {
    const result = alarmWeekdayFor('monday', powerOff);
    expect(result).toBe(shifts ? 'tuesday' : 'monday');
  });

  it('wraps saturday forward to sunday', () => {
    expect(alarmWeekdayFor('saturday', '06:00')).toBe('sunday');
  });

  it('does not shift a PM power-off on saturday', () => {
    expect(alarmWeekdayFor('saturday', '22:00')).toBe('saturday');
  });
});

// ---------------------------------------------------------------------------------------
// 2.3 — timezone utility, fixed-offset zone (no DST)
// ---------------------------------------------------------------------------------------

// Asia/Tokyo is a fixed UTC+9 offset year-round — every expectation below is computed by hand
// (local = UTC + 9h), an oracle wholly independent of the code under test.
describe('nextOccurrenceOfWeekdayTime / nextOccurrenceOfTime — Asia/Tokyo, a fixed-offset zone (tasks.md 2.3)', () => {
  // 2026-01-07T00:00:00Z = Wednesday 2026-01-07 09:00 JST.
  const NOW_MS = Date.UTC(2026, 0, 7, 0, 0, 0);

  it("today's occurrence, not yet passed (10:00 JST target, now is 09:00 JST)", () => {
    const instant = nextOccurrenceOfWeekdayTime('Asia/Tokyo', 'wednesday', '10:00', NOW_MS);
    expect(instant).toBe(Date.UTC(2026, 0, 7, 1, 0, 0)); // 2026-01-07 10:00 JST - 9h
  });

  it("today's occurrence already passed -> rolls to next week (08:00 JST target, now is 09:00 JST)", () => {
    const instant = nextOccurrenceOfWeekdayTime('Asia/Tokyo', 'wednesday', '08:00', NOW_MS);
    expect(instant).toBe(Date.UTC(2026, 0, 13, 23, 0, 0)); // 2026-01-14 08:00 JST (next Wed) - 9h -> Jan 13 23:00Z
  });

  it('a different, future weekday resolves to that weekday, same week', () => {
    const instant = nextOccurrenceOfWeekdayTime('Asia/Tokyo', 'saturday', '07:00', NOW_MS);
    expect(instant).toBe(Date.UTC(2026, 0, 9, 22, 0, 0)); // 2026-01-10 07:00 JST - 9h -> Jan 9 22:00Z
  });

  it('an earlier-in-the-week weekday resolves to next week', () => {
    const instant = nextOccurrenceOfWeekdayTime('Asia/Tokyo', 'monday', '07:00', NOW_MS);
    expect(instant).toBe(Date.UTC(2026, 0, 11, 22, 0, 0)); // 2026-01-12 07:00 JST - 9h -> Jan 11 22:00Z
  });

  it("nextOccurrenceOfTime: not yet passed today", () => {
    const instant = nextOccurrenceOfTime('Asia/Tokyo', '10:00', NOW_MS);
    expect(instant).toBe(Date.UTC(2026, 0, 7, 1, 0, 0));
  });

  it('nextOccurrenceOfTime: already passed today -> tomorrow', () => {
    const instant = nextOccurrenceOfTime('Asia/Tokyo', '08:00', NOW_MS);
    expect(instant).toBe(Date.UTC(2026, 0, 7, 23, 0, 0)); // 2026-01-08 08:00 JST - 9h
  });
});

// ---------------------------------------------------------------------------------------
// 2.4 — DST-transition pinned regression (design.md's Open Question 3)
// ---------------------------------------------------------------------------------------

describe('zonedTimeToInstant — DST-transition pinned regression (tasks.md 2.4)', () => {
  // America/Los_Angeles, 2027: spring-forward is 2027-03-14 02:00 -> 03:00 (second Sunday of
  // March). 02:30 local is a SKIPPED wall-clock time — there is no single correct instant; this
  // pins the module's *current* resolution (design.md: "resolves a skipped time to the
  // post-transition instant") so a future Intl/Node behavior change is caught, not silently
  // assumed correct. NOT verified against real hardware — see design.md's "DST edges, noted
  // honestly, not silently assumed correct".
  it('spring-forward: a skipped wall-clock time resolves to the post-transition (PDT, UTC-7) instant', () => {
    const nowMs = Date.UTC(2027, 2, 8, 0, 0, 0); // the Monday immediately before the transition Sunday
    const instant = nextOccurrenceOfWeekdayTime('America/Los_Angeles', 'sunday', '02:30', nowMs);
    expect(instant).toBe(Date.UTC(2027, 2, 14, 9, 30, 0)); // pinned: 2027-03-14T09:30:00.000Z
  });

  // Fall-back is 2027-11-07 02:00 -> 01:00 (first Sunday of November). 01:30 local is a
  // REPEATED wall-clock time (occurs once as PDT, once as PST) — this pins the module's current
  // resolution (design.md: "a repeated time to whichever offset the second correction iteration
  // lands on... empirically the first/earlier of the two candidates"), again not a correctness
  // claim against real hardware.
  it('fall-back: a repeated wall-clock time resolves to the earlier (PDT, UTC-7) instant', () => {
    const nowMs = Date.UTC(2027, 10, 1, 0, 0, 0); // well before the transition
    const instant = nextOccurrenceOfWeekdayTime('America/Los_Angeles', 'sunday', '01:30', nowMs);
    expect(instant).toBe(Date.UTC(2027, 10, 7, 8, 30, 0)); // pinned: 2027-11-07T08:30:00.000Z
  });
});

// ---------------------------------------------------------------------------------------
// 3.1 — eligibility predicate
// ---------------------------------------------------------------------------------------

describe('isAlarmEligible (tasks.md 3.1)', () => {
  const eligibleDaily = dailySchedule({ power: { enabled: true }, alarm: { enabled: true } });
  const notAway = { awayMode: false };

  it('is true when power enabled, alarm enabled, not away, and a timezone is configured', () => {
    expect(isAlarmEligible(eligibleDaily, notAway, 'America/Chicago')).toBe(true);
  });

  it('is false when the power schedule is disabled', () => {
    const daily = dailySchedule({ power: { enabled: false }, alarm: { enabled: true } });
    expect(isAlarmEligible(daily, notAway, 'America/Chicago')).toBe(false);
  });

  it('is false when the alarm itself is disabled', () => {
    const daily = dailySchedule({ power: { enabled: true }, alarm: { enabled: false } });
    expect(isAlarmEligible(daily, notAway, 'America/Chicago')).toBe(false);
  });

  it('is false when the side is in away mode', () => {
    expect(isAlarmEligible(eligibleDaily, { awayMode: true }, 'America/Chicago')).toBe(false);
  });

  it('is false when no timezone is configured (undefined or empty string)', () => {
    expect(isAlarmEligible(eligibleDaily, notAway, undefined)).toBe(false);
    expect(isAlarmEligible(eligibleDaily, notAway, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 3.3 — scheduleOverrides.alarm.expiresAt suppression
// ---------------------------------------------------------------------------------------

describe('isRegularOccurrenceSuppressed (tasks.md 3.3)', () => {
  const nowMs = Date.UTC(2026, 0, 7, 0, 0, 0);

  it('a future expiry at or after the occurrence suppresses it', () => {
    const instantMs = nowMs + 3600_000;
    const expiresAt = new Date(instantMs + 3600_000).toISOString(); // after the occurrence, still future
    expect(isRegularOccurrenceSuppressed(instantMs, expiresAt, nowMs)).toBe(true);
  });

  it('a future expiry exactly equal to the occurrence still suppresses it ("at or before")', () => {
    const instantMs = nowMs + 3600_000;
    const expiresAt = new Date(instantMs).toISOString();
    expect(isRegularOccurrenceSuppressed(instantMs, expiresAt, nowMs)).toBe(true);
  });

  it('an absent expiry suppresses nothing', () => {
    expect(isRegularOccurrenceSuppressed(nowMs + 3600_000, '', nowMs)).toBe(false);
    expect(isRegularOccurrenceSuppressed(nowMs + 3600_000, undefined, nowMs)).toBe(false);
  });

  it('an unparseable expiry suppresses nothing', () => {
    expect(isRegularOccurrenceSuppressed(nowMs + 3600_000, 'not-a-date', nowMs)).toBe(false);
  });

  it('a past (no longer future) expiry suppresses nothing', () => {
    const pastExpiry = new Date(nowMs - 3600_000).toISOString();
    expect(isRegularOccurrenceSuppressed(nowMs + 3600_000, pastExpiry, nowMs)).toBe(false);
  });

  it('an occurrence after a still-future expiry is unaffected', () => {
    const expiresAt = new Date(nowMs + 3600_000).toISOString();
    const instantAfterExpiry = nowMs + 7200_000;
    expect(isRegularOccurrenceSuppressed(instantAfterExpiry, expiresAt, nowMs)).toBe(false);
  });
});

describe("deriveUpcomingAlarms — disabled alone does not revive a suppressed occurrence (tasks.md 3.3)", () => {
  it('disabled: true with a still-future, covering expiresAt still suppresses the regular occurrence', () => {
    const nowMs = Date.UTC(2026, 0, 7, 0, 0, 0); // Wed 09:00 JST
    const daily = dailySchedule({
      power: { enabled: true, off: '20:00' }, // no day-shift
      alarm: { enabled: true, time: '10:00' },
    });
    // Regular occurrence: today (Wed) 10:00 JST -> Date.UTC(2026,0,7,1,0,0).
    const futureExpiresAt = new Date(Date.UTC(2026, 0, 7, 2, 0, 0)).toISOString(); // after the occurrence
    const settings = settingsDoc({
      left: { scheduleOverrides: { alarm: { disabled: true, timeOverride: '', expiresAt: futureExpiresAt } } },
    });
    const schedules = schedulesDoc({ left: { wednesday: daily } });

    const upcoming = deriveUpcomingAlarms(schedules, settings, nowMs);
    expect(upcoming.some((a) => a.side === 'left' && a.source === 'regular')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 3.4 — the override one-shot instant
// ---------------------------------------------------------------------------------------

describe('deriveUpcomingAlarms — override one-shot instant (tasks.md 3.4)', () => {
  const nowMs = Date.UTC(2026, 0, 7, 0, 0, 0); // Wed 09:00 JST

  it('a live override (not disabled, time + still-future expiry both set) produces its own instant', () => {
    const futureExpiresAt = new Date(nowMs + 3600_000 * 5).toISOString();
    const settings = settingsDoc({
      left: { scheduleOverrides: { alarm: { disabled: false, timeOverride: '11:00', expiresAt: futureExpiresAt } } },
    });
    const schedules = schedulesDoc();

    const upcoming = deriveUpcomingAlarms(schedules, settings, nowMs);
    const override = upcoming.find((a) => a.side === 'left' && a.source === 'override');
    expect(override).toBeDefined();
    expect(override!.instantMs).toBe(Date.UTC(2026, 0, 7, 2, 0, 0)); // 11:00 JST - 9h
  });

  it('a disabled override produces no instant of its own, whatever timeOverride/expiresAt hold', () => {
    const futureExpiresAt = new Date(nowMs + 3600_000 * 5).toISOString();
    const settings = settingsDoc({
      left: { scheduleOverrides: { alarm: { disabled: true, timeOverride: '11:00', expiresAt: futureExpiresAt } } },
    });
    const schedules = schedulesDoc();

    const upcoming = deriveUpcomingAlarms(schedules, settings, nowMs);
    expect(upcoming.some((a) => a.side === 'left' && a.source === 'override')).toBe(false);
  });

  it('an override with a past expiry produces no instant', () => {
    const pastExpiresAt = new Date(nowMs - 3600_000).toISOString();
    const settings = settingsDoc({
      left: { scheduleOverrides: { alarm: { disabled: false, timeOverride: '11:00', expiresAt: pastExpiresAt } } },
    });
    const schedules = schedulesDoc();

    const upcoming = deriveUpcomingAlarms(schedules, settings, nowMs);
    expect(upcoming.some((a) => a.side === 'left' && a.source === 'override')).toBe(false);
  });

  it('an override with timeOverride unset produces no instant', () => {
    const futureExpiresAt = new Date(nowMs + 3600_000 * 5).toISOString();
    const settings = settingsDoc({
      left: { scheduleOverrides: { alarm: { disabled: false, timeOverride: '', expiresAt: futureExpiresAt } } },
    });
    const schedules = schedulesDoc();

    const upcoming = deriveUpcomingAlarms(schedules, settings, nowMs);
    expect(upcoming.some((a) => a.side === 'left' && a.source === 'override')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 3.2 / 3.5 — end-to-end: a realistic multi-day, multi-side fixture
// ---------------------------------------------------------------------------------------

describe('deriveUpcomingAlarms — end-to-end (tasks.md 3.2, 3.5)', () => {
  // now = Wednesday 2026-01-07 09:00 JST.
  const nowMs = Date.UTC(2026, 0, 7, 0, 0, 0);

  it('derives exactly the expected set across an overnight-crossing weekday, a same-day weekday, a disabled day, an away side, and a live override', () => {
    const left: Partial<Record<Weekday, DailySchedule>> = {
      // Overnight session: power off at 07:00 (hour <= 12) shifts wednesday -> thursday; the
      // alarm's own early-morning time lands on that shifted day.
      wednesday: dailySchedule({ power: { enabled: true, off: '07:00' }, alarm: { enabled: true, time: '06:45' } }),
      // Same-day (non-overnight) session: power off at 20:00, no shift.
      saturday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }),
      // Power enabled but alarm disabled -> contributes nothing.
      friday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: false, time: '07:00' } }),
      // Power disabled -> contributes nothing regardless of the alarm's own enabled flag.
      thursday: dailySchedule({ power: { enabled: false, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }),
    };
    // Right side: fully eligible on monday, but the side itself is in away mode -> contributes
    // nothing from its regular schedule; its live override instant is unaffected by away mode.
    const right: Partial<Record<Weekday, DailySchedule>> = {
      monday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }),
    };
    const schedules = schedulesDoc({ left, right });

    const rightFutureExpiresAt = new Date(nowMs + 3600_000 * 6).toISOString();
    const settings = settingsDoc({
      right: {
        awayMode: true,
        scheduleOverrides: { alarm: { disabled: false, timeOverride: '10:00', expiresAt: rightFutureExpiresAt } },
      },
    });

    const upcoming = deriveUpcomingAlarms(schedules, settings, nowMs);

    // Left, wednesday -> thursday shift: 2026-01-08 06:45 JST.
    const leftOvernight = { side: 'left' as Side, instantMs: Date.UTC(2026, 0, 7, 21, 45, 0), source: 'regular' as const };
    // Left, saturday, no shift: 2026-01-10 07:00 JST.
    const leftSameDay = { side: 'left' as Side, instantMs: Date.UTC(2026, 0, 9, 22, 0, 0), source: 'regular' as const };
    // Right, override one-shot: today 10:00 JST (not yet passed relative to 09:00 JST "now").
    const rightOverride = { side: 'right' as Side, instantMs: Date.UTC(2026, 0, 7, 1, 0, 0), source: 'override' as const };

    expect(upcoming).toEqual([rightOverride, leftOvernight, leftSameDay].sort((a, b) => a.instantMs - b.instantMs));

    // Explicitly confirm the negative cases contribute nothing (friday/thursday disabled;
    // right's monday regular occurrence suppressed by away mode).
    expect(upcoming.filter((a) => a.side === 'right' && a.source === 'regular')).toHaveLength(0);
    expect(upcoming).toHaveLength(3);
  });

  it('contributes no instant for any side when settings.timeZone is empty', () => {
    const schedules = schedulesDoc({
      left: { monday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }) },
    });
    const settings = settingsDoc({ timeZone: '' });
    expect(deriveUpcomingAlarms(schedules, settings, nowMs)).toEqual([]);
  });

  it('returns an empty list when schedules or settings have not been observed yet', () => {
    expect(deriveUpcomingAlarms(undefined, settingsDoc(), nowMs)).toEqual([]);
    expect(deriveUpcomingAlarms(schedulesDoc(), undefined, nowMs)).toEqual([]);
  });
});
