/**
 * Pure derivation of "which alarm instant(s) are upcoming" from the already-cached `schedules`/
 * `settings` documents — no I/O, no timer, no poller call. `AlarmWindowScheduler`
 * (`./alarmWindowScheduler.ts`) is the only consumer today; `settings-switches`' "Skip Next
 * Alarm" computation is a planned second consumer (tech-lead resolution 3, alarm-events
 * design.md's final "Resolutions" section) — which is exactly why this eligibility/day-shift/
 * override-skip/timezone logic lives in its own module rather than inside the scheduler that
 * happens to have shipped first.
 *
 * Every behavioural rule below is a direct, literal port of a specific upstream function —
 * chosen deliberately (design.md, "Deriving instants") so a future upstream change to any one of
 * them is a one-function diff here too:
 *
 *   | Rule                          | Upstream source (`~/Code/free-sleep`, pinned v2.1.5/`dc0c710`) |
 *   |--------------------------------|------------------------------------------------------------|
 *   | Eligibility (four early returns) | `server/src/jobs/alarmScheduler.ts`'s `scheduleAlarm`    |
 *   | Calendar-day shift              | `server/src/jobs/utils.ts`'s `isEndTimeNextDay`/`getDayIndexForSchedule` |
 *   | `expiresAt` suppression, `disabled`'s non-role | `alarmScheduler.ts`'s recurring job body (checks only `expiresAt`) |
 *   | Override one-shot instant       | `alarmScheduler.ts`'s `scheduleAlarmOverride`, `nextOccurrenceHhMm` |
 *   | Timezone (`settings.timeZone`, not the host's) | `alarmScheduler.ts`'s `moment.tz(settingsData.timeZone)` calls |
 *
 * Timezone arithmetic (design.md, "Timezone arithmetic: `settings.timeZone` via `Intl`, not the
 * host's local zone, and not a new dependency") uses only `Intl.DateTimeFormat` and
 * `globalThis.Date`'s static UTC helpers — never the bare `Date`/`setTimeout`/`Math.random`
 * identifiers this file's own ESLint scoping forbids (tasks.md 4.5; same `no-restricted-globals`
 * discipline as `snapshot.ts`/`poller.ts`/`writeQueue.ts`/`keepAlive.ts`, extended here). Every
 * function below is otherwise pure: given the same `schedules`, `settings` and `nowMs`, it always
 * returns the same result — nothing here reads the ambient clock.
 *
 * **DST edges are resolved, not solved** — see `zonedTimeToInstant`'s doc. This matches, not
 * improves on, upstream's own unverified posture (`moment.tz` resolves the same ambiguity by its
 * own internal convention with no error either); design.md's "DST edges, noted honestly" and
 * tasks.md 2.4's pinned regression test both flag this explicitly rather than assuming it.
 */

import type { DailySchedule, Schedules, Settings, Side, SideSettings } from './types.ts';

// ---------------------------------------------------------------------------------------
// Weekday plumbing
// ---------------------------------------------------------------------------------------

export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

const SIDES: readonly Side[] = ['left', 'right'];

/** One week plus a day of slack (design.md, "Recomputation") — long enough that a side whose
 * only enabled weekday is six days out is still found. */
export const LOOKAHEAD_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------
// Timezone arithmetic: "format, diff, correct" (design.md, "Timezone arithmetic")
// ---------------------------------------------------------------------------------------

interface WallClockFields {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

interface ZonedNow extends WallClockFields {
  weekday: Weekday;
}

/**
 * What `epochMs` displays as, wall-clock, in `timeZone` — the "format" step. `Intl.
 * DateTimeFormat.prototype.formatToParts` accepts a plain epoch-ms number directly (ECMA-402),
 * so this never needs to construct a `Date` instance at all, bare or via `globalThis`.
 */
function wallClockFieldsInZone(epochMs: number, timeZone: string): ZonedNow {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(epochMs);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hourRaw = get('hour');
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // h23 never emits '24', but guard anyway rather than trust every ICU build identically.
    hour: hourRaw === '24' ? 0 : Number(hourRaw),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday').toLowerCase() as Weekday,
  };
}

/** Treats wall-clock fields as if they were UTC — the "guess" step. `globalThis.Date.UTC` is a
 * property access, not the bare `Date` identifier `no-restricted-globals` forbids (the same
 * escape hatch `poller.ts`'s vitals class already uses). */
function epochForWallClockUtc(f: WallClockFields): number {
  return globalThis.Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
}

/** `timeZone`'s UTC offset (ms, east-positive) at approximately `epochMs` — the "diff" step. */
function offsetAtMs(epochMs: number, timeZone: string): number {
  const fields = wallClockFieldsInZone(epochMs, timeZone);
  return epochForWallClockUtc(fields) - epochMs;
}

/**
 * Converts wall-clock fields meant to denote a moment in `timeZone` into the UTC instant they
 * denote (design.md's "format, diff, correct" technique): guess the instant by treating the
 * fields as UTC, measure that guess's own zone offset, correct by it, then repeat the
 * measurement once more against the corrected instant — offsets only take two values per zone
 * per year, so a second correction converges except exactly inside a DST transition window
 * itself.
 *
 * **DST edges, noted honestly, not silently assumed correct** (design.md): a wall-clock time
 * that is skipped (spring-forward) or repeated (fall-back) has no single correct instant: this
 * resolves a skipped time to the post-transition instant, and a repeated time to whichever
 * offset this second correction lands on. Matches, not improves on, upstream's own unverified
 * `moment.tz` resolution. See tasks.md 2.4's pinned regression test, which locks in *this*
 * behavior so a future `Intl`/Node change is caught — not a claim that the resolution itself is
 * correct against real hardware.
 */
function zonedTimeToInstant(timeZone: string, f: WallClockFields): number {
  const guess = epochForWallClockUtc(f);
  const corrected = guess - offsetAtMs(guess, timeZone);
  return guess - offsetAtMs(corrected, timeZone);
}

/** `{year,month,day}` shifted by `days` (positive or negative), via `globalThis.Date`'s own
 * overflow normalization — simpler and more robust than hand-rolled calendar arithmetic, and the
 * same `globalThis.Date` escape hatch used throughout this file. */
function addCalendarDays(f: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const ms = globalThis.Date.UTC(f.year, f.month - 1, f.day + days);
  const d = new globalThis.Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function parseHhMm(hhmm: string): { hour: number; minute: number } {
  const [hourRaw, minuteRaw] = hhmm.split(':');
  return { hour: Number(hourRaw ?? 0), minute: Number(minuteRaw ?? 0) };
}

/**
 * Next occurrence of `weekday` at `hhmm` (in `timeZone`), at or after `nowMs` — the weekly
 * recurrence's own instant (design.md's step 3, "generalized to 'next occurrence of this
 * weekday-and-time'... since a weekly recurrence, unlike the one-shot override job, is pinned to
 * a specific weekday").
 */
export function nextOccurrenceOfWeekdayTime(timeZone: string, weekday: Weekday, hhmm: string, nowMs: number): number {
  const now = wallClockFieldsInZone(nowMs, timeZone);
  const { hour, minute } = parseHhMm(hhmm);
  const targetIdx = WEEKDAYS.indexOf(weekday);
  const nowIdx = WEEKDAYS.indexOf(now.weekday);
  const daysUntil = (targetIdx - nowIdx + 7) % 7;
  const candidate = addCalendarDays(now, daysUntil);
  let instant = zonedTimeToInstant(timeZone, { ...candidate, hour, minute, second: 0 });
  if (instant <= nowMs) {
    // Only reachable when daysUntil === 0 and today's occurrence has already passed — the next
    // one is exactly a week out (mirrors upstream's own RecurrenceRule semantics).
    const nextWeek = addCalendarDays(candidate, 7);
    instant = zonedTimeToInstant(timeZone, { ...nextWeek, hour, minute, second: 0 });
  }
  return instant;
}

/**
 * Next occurrence of `hhmm` on any day (in `timeZone`), at or after `nowMs` — a direct port of
 * `nextOccurrenceHhMm` (`alarmScheduler.ts`): "today or tomorrow depending on 'now'; if the
 * `HH:mm` is already passed for 'now', schedule for tomorrow." Used only for the schedule
 * override's own one-shot instant, which — unlike the weekly recurrence — is not weekday-pinned.
 */
export function nextOccurrenceOfTime(timeZone: string, hhmm: string, nowMs: number): number {
  const now = wallClockFieldsInZone(nowMs, timeZone);
  const { hour, minute } = parseHhMm(hhmm);
  let instant = zonedTimeToInstant(timeZone, { ...now, hour, minute, second: 0 });
  if (instant <= nowMs) {
    const tomorrow = addCalendarDays(now, 1);
    instant = zonedTimeToInstant(timeZone, { ...tomorrow, hour, minute, second: 0 });
  }
  return instant;
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  // `globalThis.Date.parse` — parsing a fixed, externally-supplied timestamp string is not
  // "reading the ambient clock" the ESLint rule exists to forbid (the same distinction
  // `poller.ts`'s vitals class already draws for its own `globalThis.Date` use).
  const ms = globalThis.Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

// ---------------------------------------------------------------------------------------
// Calendar-day shift (`jobs/utils.ts`'s `isEndTimeNextDay`/`getDayIndexForSchedule`)
// ---------------------------------------------------------------------------------------

function nextWeekdayName(weekday: Weekday): Weekday {
  const idx = WEEKDAYS.indexOf(weekday);
  return WEEKDAYS[(idx + 1) % 7]!;
}

/**
 * Verbatim port of `isEndTimeNextDay`'s one-line predicate, composed with
 * `getNextDayOfWeekIndex`: an overnight session (power off after midnight, i.e. `power.off`'s
 * hour is `<= 12`) puts the alarm on the calendar day *after* the schedule's own weekday key, not
 * on it.
 */
export function alarmWeekdayFor(scheduleWeekday: Weekday, powerOffHhMm: string): Weekday {
  const endHour = Number(powerOffHhMm.split(':')[0]);
  return endHour <= 12 ? nextWeekdayName(scheduleWeekday) : scheduleWeekday;
}

// ---------------------------------------------------------------------------------------
// Eligibility (`alarmScheduler.ts`'s `scheduleAlarm`, its four early-return guards)
// ---------------------------------------------------------------------------------------

/**
 * `daily.power.enabled && daily.alarm.enabled && !sideSettings.awayMode && timeZone` — all four
 * required, exported standalone so a unit test can exercise each of the four independent failure
 * cases plus the all-true case directly (tasks.md 3.1).
 */
export function isAlarmEligible(
  daily: Pick<DailySchedule, 'power' | 'alarm'>,
  sideSettings: Pick<SideSettings, 'awayMode'>,
  timeZone: string | undefined,
): boolean {
  return daily.power.enabled && daily.alarm.enabled && !sideSettings.awayMode && Boolean(timeZone);
}

// ---------------------------------------------------------------------------------------
// scheduleOverrides.alarm.expiresAt suppression (design.md's step 4)
// ---------------------------------------------------------------------------------------

/**
 * A regular occurrence at or before a parseable, still-future `expiresAt` is suppressed —
 * `disabled` plays no role in this check at all (`docs/POD-API.md`: "`disabled` is read solely
 * by `scheduleAlarmOverride`," never by the recurring job's own skip check).
 */
export function isRegularOccurrenceSuppressed(instantMs: number, expiresAtRaw: string | undefined, nowMs: number): boolean {
  const expiresAtMs = parseTimestamp(expiresAtRaw);
  if (expiresAtMs === undefined) return false;
  if (expiresAtMs <= nowMs) return false; // not still future -> suppresses nothing
  return instantMs <= expiresAtMs;
}

// ---------------------------------------------------------------------------------------
// The composed derivation
// ---------------------------------------------------------------------------------------

export type AlarmSource = 'regular' | 'override';

export interface UpcomingAlarm {
  side: Side;
  instantMs: number;
  source: AlarmSource;
}

/** The stable occurrence key `AlarmWindowScheduler` uses to track which windows are already
 * active (design.md's "Recomputation": `${side}:${instantMs}:${source}`). */
export function alarmScheduleKey(alarm: UpcomingAlarm): string {
  return `${alarm.side}:${alarm.instantMs}:${alarm.source}`;
}

/**
 * Every side's upcoming alarm instant(s), derived purely from the given `schedules`/`settings`
 * documents relative to `nowMs`, bounded by `LOOKAHEAD_HORIZON_MS` — composes eligibility, the
 * calendar-day shift, the timezone utility, the `expiresAt` suppression, and the override
 * one-shot instant (design.md's "Deriving instants"). `undefined` schedules/settings (not yet
 * observed) or an empty `settings.timeZone` both produce an empty list, matching the
 * pod-alarm-scheduler spec's "No timezone configured contributes no instant" requirement.
 */
export function deriveUpcomingAlarms(
  schedules: Schedules | undefined,
  settings: Settings | undefined,
  nowMs: number,
): UpcomingAlarm[] {
  if (!schedules || !settings || !settings.timeZone) return [];
  const timeZone = settings.timeZone;
  const horizonMs = nowMs + LOOKAHEAD_HORIZON_MS;
  const results: UpcomingAlarm[] = [];

  for (const side of SIDES) {
    const sideSettings = settings[side];
    const sideSchedule = schedules[side];

    for (const weekday of WEEKDAYS) {
      const daily = sideSchedule[weekday];
      if (!isAlarmEligible(daily, sideSettings, timeZone)) continue;
      const alarmWeekday = alarmWeekdayFor(weekday, daily.power.off);
      const instantMs = nextOccurrenceOfWeekdayTime(timeZone, alarmWeekday, daily.alarm.time, nowMs);
      if (instantMs > horizonMs) continue;
      if (isRegularOccurrenceSuppressed(instantMs, sideSettings.scheduleOverrides.alarm.expiresAt, nowMs)) continue;
      results.push({ side, instantMs, source: 'regular' });
    }

    // The override one-shot instant is independent of away mode and of the eligibility predicate
    // above — upstream's own `scheduleAlarmOverride` has no away-mode check at all, only
    // `executeAlarm`'s own (force-overridable) check at *execution* time, which this plugin never
    // reproduces (design.md's "Away-mode interaction" is about the *dismiss write*, not this
    // read-only prediction).
    const override = sideSettings.scheduleOverrides.alarm;
    if (!override.disabled && override.timeOverride && override.expiresAt) {
      const expiresAtMs = parseTimestamp(override.expiresAt);
      if (expiresAtMs !== undefined && expiresAtMs > nowMs) {
        const instantMs = nextOccurrenceOfTime(timeZone, override.timeOverride, nowMs);
        if (instantMs <= horizonMs) {
          results.push({ side, instantMs, source: 'override' });
        }
      }
    }
  }

  return results.sort((a, b) => a.instantMs - b.instantMs);
}
