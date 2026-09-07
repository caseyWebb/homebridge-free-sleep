# skip-alarm-switch Specification

## Purpose
Exposes a one-tap way to skip each side's next scheduled alarm from the Home app, by driving
the same `scheduleOverrides.alarm.expiresAt` skip mechanism free-sleep's own recurring alarm
job already honors, and self-clearing once that override lapses.

## Requirements

### Requirement: The switch's state is derived from whether an unexpired skip override exists

Reading the switch's state for a side SHALL be `true` when that side's
`scheduleOverrides.alarm.expiresAt` is a non-empty timestamp that is still in the future
relative to the current time, and `false` otherwise (including when it is empty, or a past
timestamp). This derivation SHALL use only the shared cached snapshot and SHALL NEVER itself
issue a request to the Pod, and SHALL NOT throw while a snapshot exists.

#### Scenario: An unexpired override reads as on

- **WHEN** a side's `scheduleOverrides.alarm.expiresAt` is a timestamp later than the current
  time
- **THEN** that side's Skip Next Alarm switch reads as on

#### Scenario: An expired or empty override reads as off

- **WHEN** a side's `scheduleOverrides.alarm.expiresAt` is empty, or is a timestamp at or
  before the current time
- **THEN** that side's Skip Next Alarm switch reads as off

#### Scenario: The switch self-clears once the override lapses, without a write

- **WHEN** a side's Skip Next Alarm switch was on because of an override, and the current time
  advances past that override's `expiresAt` with no further write
- **THEN** the switch's state is read as off on the next read, with no settings write made to
  produce that transition

### Requirement: The switch proactively pushes on an external change or at expiry

S6 (settings-switches PR #46 review): the switch SHALL push its updated state to HomeKit,
without waiting for a read, both when a settings observation reveals a side's
`scheduleOverrides.alarm.expiresAt` changed by some means other than this switch's own write
(e.g. free-sleep's own web UI), and at the exact instant an active override's `expiresAt`
elapses.

#### Scenario: An externally-changed override is pushed to HomeKit

- **WHEN** a settings observation reveals a side's `scheduleOverrides.alarm.expiresAt` changed
  to a value this switch did not itself write
- **THEN** the switch's displayed state is pushed to HomeKit reflecting the new value, without
  waiting for a subsequent read

#### Scenario: The tile drops to off at the exact expiry instant, without a read

- **WHEN** the current time reaches a side's active override's `expiresAt`
- **THEN** the switch's displayed state is pushed to HomeKit as off at that instant, without any
  read having occurred

### Requirement: Turning the switch on skips exactly the next scheduled alarm

Turning a side's Skip Next Alarm switch on SHALL compute that side's next scheduled alarm
occurrence from the cached schedules snapshot, that side's `settings.timeZone`, and the
current time, using this rule: the *alarm time* read is the one scheduled for the current
sleep day — the calendar day, in that time zone, that began 12 hours before the current time
(N6, settings-switches PR #46 review: not necessarily the same calendar day the computed
timestamp is ultimately applied to); the *target date* that alarm time is applied to is today
if the current time is before noon in that time zone, otherwise tomorrow; the written instant
is that alarm time, on that target date, plus 2 minutes. It SHALL then post `{[side]:
{scheduleOverrides: {alarm: {disabled: true, timeOverride: '', expiresAt: <the computed
timestamp, as a full ISO-8601 string including a UTC offset>}}}}`.

A day with alarms disabled (`power.enabled` or `alarm.enabled` false for the sleep day whose
alarm time is read) SHALL still produce a computed occurrence and a written `expiresAt` — this
requirement concerns only what timestamp is computed and written, not whether an alarm would
have fired on that day regardless.

#### Scenario: Skipping before noon targets today's alarm

- **WHEN** a user turns the switch on before noon in the side's configured time zone
- **THEN** the written `expiresAt` targets today's date, at the sleep day's scheduled alarm
  time, plus 2 minutes

#### Scenario: Skipping at or after noon targets tomorrow's alarm

- **WHEN** a user turns the switch on at or after noon in the side's configured time zone
- **THEN** the written `expiresAt` targets tomorrow's date, at the sleep day's scheduled alarm
  time, plus 2 minutes

#### Scenario: The written timestamp is unambiguous across time zones

- **WHEN** any `expiresAt` value is written by this switch
- **THEN** it is a complete ISO-8601 string that includes a UTC offset, not a bare local time

### Requirement: A toggle whose computed instant has already elapsed is refused, not written

S5 (settings-switches PR #46 review): the noon rule above targets *today's* date whenever the
current time is before noon — but if the sleep day's scheduled alarm has already rung earlier
that same morning (the current time falls between that alarm and the following noon), the
computed instant is already in the past. Turning the switch on in that window SHALL be refused
outright — the characteristic write SHALL fail with a distinct, user-visible HomeKit error, and
the switch's displayed state SHALL be corrected back to the last-confirmed value shortly
afterward — rather than producing a `POST /api/settings` write whose resulting override is
already expired and therefore skips nothing.

#### Scenario: A toggle in the post-alarm-to-noon dead window is refused

- **WHEN** a user turns the switch on and the computed skip instant is already at or before the
  current time
- **THEN** the characteristic write fails distinctly, no `POST /api/settings` request is made,
  and the switch's displayed state reverts to the last-confirmed value shortly afterward

#### Scenario: A toggle outside the dead window proceeds normally

- **WHEN** a user turns the switch on and the computed skip instant is still in the future
- **THEN** the write proceeds exactly as the requirement above describes

### Requirement: Turning the switch off clears the override outright

Turning a side's Skip Next Alarm switch off SHALL post `{[side]: {scheduleOverrides: {alarm:
{disabled: false, timeOverride: '', expiresAt: ''}}}}`, regardless of whether the existing
override has already lapsed.

#### Scenario: Turning off an active skip clears it

- **WHEN** a user turns off a side's Skip Next Alarm switch while an unexpired override is in
  effect
- **THEN** that side's next scheduled alarm is no longer skipped

### Requirement: Settings writes this switch makes are debounced, rate-limited, and confirmed

A toggle of this switch SHALL be debounced locally by at least 2 seconds before producing a
`POST /api/settings` request, and SHALL be rate-limited to at most one settings write per side
per 10-second window (S4, settings-switches PR #46 review — issue #17's own "debounce >= 2s,
rate-limit" text, using the same 10-second window `away-mode-switch` uses). Following a
successful write, the switch's service SHALL trigger a settings re-read so that a subsequent
read of the switch's state reflects the written value promptly rather than waiting for the
next regular poll. A toggle whose coalesced value already matches the currently-observed on/off
state (S3, settings-switches PR #46 review) SHALL produce no write at all.

#### Scenario: Rapid toggling produces at most one write

- **WHEN** a user toggles a side's Skip Next Alarm switch twice within 2 seconds
- **THEN** at most one `POST /api/settings` request is made, carrying the final state

#### Scenario: A toggle that nets out to no change produces no write

- **WHEN** a user toggles a side's Skip Next Alarm switch such that the coalesced final value
  equals the currently-observed on/off state
- **THEN** no `POST /api/settings` request is made, and the toggle still completes successfully

#### Scenario: Rapid repeated toggles are rate-limited to one write per 10 seconds

- **WHEN** a user flips the Skip Next Alarm switch for the same side more than once within a
  10-second window
- **THEN** at most one settings write for that side is sent within that window, carrying the
  most recent value

#### Scenario: A successful write is confirmed promptly

- **WHEN** a toggle's settings write succeeds
- **THEN** the cached settings are refreshed without waiting for the next regularly-scheduled
  settings poll

### Requirement: A failed write surfaces as a communication failure, not silently

When the settings write a toggle produces fails, the characteristic write SHALL fail with a
distinct, user-visible HomeKit error rather than silently reporting success, and the switch's
displayed state SHALL be corrected back to the last-confirmed value shortly afterward.

#### Scenario: A failed skip-alarm write is surfaced to the user

- **WHEN** the `POST /api/settings` request a toggle produces fails
- **THEN** the characteristic write fails with a distinct error rather than appearing to
  succeed, and the switch's displayed state reverts to the last-confirmed value
