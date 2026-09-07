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
  nextAlarmSkipInstant,
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
  // pins the module's *current* resolution: it resolves to the *pre*-transition wall-clock
  // reading, 01:30 PST (one hour before the nominal time) — differing from `moment.tz`'s own
  // `moveInvalidForward` default (which would move forward to 03:30 PDT instead) by exactly that
  // one hour (S4, alarm-events PR #45 review — the previous "matches upstream"/"post-transition"
  // characterization here was backwards). Pinned so a future Intl/Node behavior change is
  // caught, not silently assumed correct. NOT verified against real hardware — see design.md's
  // "DST edges, noted honestly, not silently assumed correct".
  it('spring-forward: a skipped wall-clock time resolves to the pre-transition (PST, UTC-8) instant', () => {
    const nowMs = Date.UTC(2027, 2, 8, 0, 0, 0); // the Monday immediately before the transition Sunday
    const instant = nextOccurrenceOfWeekdayTime('America/Los_Angeles', 'sunday', '02:30', nowMs);
    expect(instant).toBe(Date.UTC(2027, 2, 14, 9, 30, 0)); // pinned: 2027-03-14T09:30:00.000Z (01:30 PST)
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

  // S5 (alarm-events PR #45 review): a live, otherwise-eligible override on a side currently in
  // away mode still contributes no instant — `scheduleAlarmOverride` (which arms the job) has no
  // away-mode check of its own, but `executeAlarm` (which fires it) early-returns on `awayMode`
  // regardless of which mechanism scheduled the job, making a predicted window here purely
  // spurious. Previously this branch was deliberately independent of away mode; this pins the
  // corrected behavior.
  it('an away side with an otherwise-live override produces zero instants — regular or override', () => {
    const futureExpiresAt = new Date(nowMs + 3600_000 * 5).toISOString();
    const settings = settingsDoc({
      left: {
        awayMode: true,
        scheduleOverrides: { alarm: { disabled: false, timeOverride: '11:00', expiresAt: futureExpiresAt } },
      },
    });
    const schedules = schedulesDoc({
      left: { wednesday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }) },
    });

    const upcoming = deriveUpcomingAlarms(schedules, settings, nowMs);
    expect(upcoming.filter((a) => a.side === 'left')).toHaveLength(0);
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
    // nothing from its regular schedule. S5 (alarm-events PR #45 review): its live override
    // instant is *also* suppressed by away mode — `executeAlarm` (the function that actually
    // fires any alarm job, override or regular) early-returns on `awayMode` regardless of which
    // mechanism scheduled the job, so predicting a window for an away side's override would be
    // purely spurious (`alarmSchedule.ts`'s own updated doc on this branch).
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

    expect(upcoming).toEqual([leftOvernight, leftSameDay].sort((a, b) => a.instantMs - b.instantMs));

    // Explicitly confirm the negative cases contribute nothing (friday/thursday disabled;
    // right's monday regular occurrence AND its live override both suppressed by away mode).
    expect(upcoming.filter((a) => a.side === 'right' && a.source === 'regular')).toHaveLength(0);
    expect(upcoming.filter((a) => a.side === 'right' && a.source === 'override')).toHaveLength(0);
    expect(upcoming).toHaveLength(2);
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

// ---------------------------------------------------------------------------------------
// B1 (alarm-events PR #45 review): a malformed alarm.time or an unrecognized settings.timeZone
// must not throw out of this pure function — the reviewer's own two executed reproductions
// (a bare RangeError from `Intl.DateTimeFormat`, previously uncaught) — and must not silently
// corrupt the derivation with a non-finite instant either.
// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// nextAlarmSkipInstant — settings-switches (#17, tech-lead resolution 3): the Skip Next Alarm
// switch's own next-occurrence rule, a direct port of AlarmNotification.tsx's "sleep day"
// convention (now minus 12h decides which weekday's `alarm.time` to read) composed with
// AlarmDisabledDialog.tsx's own noon-based target-date rule (today if before noon, else
// tomorrow, +2 minutes) — see the function's own doc for the exact upstream citations.
// tasks.md 1.1's own verification table: before noon, at/after noon, an alarm exactly at
// midnight, and a time zone with a non-whole-hour UTC offset.
// ---------------------------------------------------------------------------------------

describe('nextAlarmSkipInstant (settings-switches, tasks.md 1.1)', () => {
  // Distinct alarm.time per weekday so a test can prove *which* day's entry was actually read:
  // tuesday and wednesday differ (06:45 vs 07:15); every other day is irrelevant to these tests.
  const sideSchedule = inertSideSchedule({
    tuesday: dailySchedule({ alarm: { time: '06:45' } }),
    wednesday: dailySchedule({ alarm: { time: '07:15' } }),
  });

  it("before noon (mid-morning): targets today's date, using the sleep-day (now minus 12h = tuesday) schedule's alarm time", () => {
    // 2026-01-07T00:00:00Z = Wednesday 2026-01-07 09:00 JST. now-12h = Tuesday 21:00 JST.
    const nowMs = Date.UTC(2026, 0, 7, 0, 0, 0);
    const instant = nextAlarmSkipInstant('Asia/Tokyo', sideSchedule, nowMs);
    // Tuesday's 06:45 + 2min = 06:47, applied to *today's* (Wednesday's) calendar date.
    expect(instant).toBe(Date.UTC(2026, 0, 6, 21, 47, 0)); // 2026-01-07 06:47 JST - 9h
  });

  it("at/after noon (afternoon): targets tomorrow's date, using the sleep-day (now minus 12h = wednesday, same calendar day) schedule's alarm time", () => {
    // 2026-01-07 15:00 JST. now-12h = 2026-01-07 03:00 JST -> still Wednesday.
    const nowMs = Date.UTC(2026, 0, 7, 6, 0, 0);
    const instant = nextAlarmSkipInstant('Asia/Tokyo', sideSchedule, nowMs);
    // Wednesday's 07:15 + 2min = 07:17, applied to *tomorrow's* (Thursday's) calendar date.
    expect(instant).toBe(Date.UTC(2026, 0, 7, 22, 17, 0)); // 2026-01-08 07:17 JST - 9h
  });

  it('exactly noon counts as "at or after" — targets tomorrow, matching upstream\'s isSameOrAfter', () => {
    const nowMs = Date.UTC(2026, 0, 7, 3, 0, 0); // 2026-01-07 12:00:00 JST exactly
    const instant = nextAlarmSkipInstant('Asia/Tokyo', sideSchedule, nowMs);
    expect(instant).toBe(Date.UTC(2026, 0, 7, 22, 17, 0)); // same as the after-noon case above
  });

  it('an alarm scheduled exactly at midnight resolves to 00:02 on the target date', () => {
    const midnightSchedule = inertSideSchedule({ tuesday: dailySchedule({ alarm: { time: '00:00' } }) });
    const nowMs = Date.UTC(2026, 0, 7, 0, 0, 0); // Wednesday 09:00 JST, before noon -> today; sleep-day tuesday
    const instant = nextAlarmSkipInstant('Asia/Tokyo', midnightSchedule, nowMs);
    expect(instant).toBe(Date.UTC(2026, 0, 6, 15, 2, 0)); // 2026-01-07 00:02 JST - 9h
  });

  it('a non-whole-hour UTC offset zone (Asia/Kolkata, UTC+5:30) resolves correctly', () => {
    // 2026-01-07 09:00 IST, before noon. now-12h = 2026-01-06 21:00 IST -> Tuesday.
    const nowMs = Date.UTC(2026, 0, 7, 3, 30, 0);
    const instant = nextAlarmSkipInstant('Asia/Kolkata', sideSchedule, nowMs);
    // Tuesday's 06:45 + 2min = 06:47 IST, today's (Wednesday's) date.
    expect(instant).toBe(Date.UTC(2026, 0, 7, 1, 17, 0)); // 2026-01-07 06:47 IST - 5:30
  });
});

describe('deriveUpcomingAlarms — B1: a bad entry is skipped, not thrown, and does not affect siblings', () => {
  const nowMs = Date.UTC(2026, 0, 7, 0, 0, 0); // Wed 09:00 JST

  it('a malformed alarm.time ("6:45 AM") is skipped — no throw, other weekdays and the other side still derive', () => {
    const left: Partial<Record<Weekday, DailySchedule>> = {
      // Malformed: `parseHhMm` yields `minute: NaN`, which makes every downstream `Date.UTC`/
      // `Intl` computation `NaN` — `Intl.DateTimeFormat.prototype.formatToParts` itself then
      // throws a RangeError on a non-finite epoch.
      wednesday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '6:45 AM' } }),
      // A sibling weekday for the *same* side, well-formed — must still derive despite
      // wednesday's own throw.
      saturday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }),
    };
    const right: Partial<Record<Weekday, DailySchedule>> = {
      // The *other* side, well-formed — must still derive too.
      monday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }),
    };
    const schedules = schedulesDoc({ left, right });
    const settings = settingsDoc();

    const errors: Array<{ key: string; error: unknown }> = [];
    let upcoming: ReturnType<typeof deriveUpcomingAlarms> = [];
    expect(() => {
      upcoming = deriveUpcomingAlarms(schedules, settings, nowMs, (key, error) => errors.push({ key, error }));
    }).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.key).toBe('left:wednesday');
    expect(errors[0]!.error).toBeInstanceOf(RangeError);

    // The offending entry contributed nothing; the two well-formed siblings did.
    expect(upcoming.some((a) => a.side === 'left' && a.source === 'regular' && a.instantMs === Date.UTC(2026, 0, 7, 21, 45, 0))).toBe(
      false,
    );
    expect(upcoming.some((a) => a.side === 'left' && a.source === 'regular')).toBe(true); // saturday
    expect(upcoming.some((a) => a.side === 'right' && a.source === 'regular')).toBe(true); // monday
    expect(upcoming.every((a) => Number.isFinite(a.instantMs))).toBe(true); // never a NaN instant
  });

  it('an unrecognized settings.timeZone is skipped entirely — no throw, an empty result, one error per weekday/override entry', () => {
    const schedules = schedulesDoc({
      left: { monday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }) },
      right: { tuesday: dailySchedule({ power: { enabled: true, off: '20:00' }, alarm: { enabled: true, time: '07:00' } }) },
    });
    const settings = settingsDoc({ timeZone: 'Not/AZone' });

    const errors: Array<{ key: string; error: unknown }> = [];
    let upcoming: ReturnType<typeof deriveUpcomingAlarms> = [];
    expect(() => {
      upcoming = deriveUpcomingAlarms(schedules, settings, nowMs, (key, error) => errors.push({ key, error }));
    }).not.toThrow();

    expect(upcoming).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.error instanceof RangeError)).toBe(true);
  });
});
