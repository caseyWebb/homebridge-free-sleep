## Purpose

Derives when each side's next alarm(s) will fire from the already-cached schedules and
settings documents, and requests a bounded high-frequency polling window around each one so a
short-lived alarm event is never missed by the platform's normal, much slower polling cadence.

## ADDED Requirements

### Requirement: Upcoming alarm instants are derived from cached schedules and settings

The system SHALL compute, for each side, the wall-clock instant(s) an alarm is expected to fire,
using only the platform's already-cached `schedules` and `settings` documents — it SHALL NOT
issue a Pod request of its own to do so.

For a given side and weekday, an alarm instant SHALL be derived only when all of the following
hold for that weekday's schedule: the power schedule is enabled, the alarm is enabled, that side
is not in away mode, and a timezone is configured. A weekday schedule missing any of these SHALL
contribute no instant.

The literal calendar day an instant falls on SHALL account for a sleep session that crosses
midnight: when the schedule's power-off time is in the early morning, the alarm's calendar day
SHALL be the day after the schedule's own weekday, not the schedule's weekday itself.

Every `HH:mm` time value SHALL be interpreted in the Pod's configured timezone
(`settings.timeZone`), never the host machine's local timezone — computing the correct instant
therefore SHALL account for that timezone's UTC offset, including a UTC offset that differs
between the current moment and the target instant across a daylight-saving transition.

#### Scenario: A fully-enabled weekday schedule produces an instant

- **WHEN** a side's schedule for a given weekday has its power schedule enabled, its alarm
  enabled, that side not in away mode, and a configured timezone
- **THEN** the system derives an upcoming alarm instant for that side and weekday

#### Scenario: A disabled power schedule contributes no instant

- **WHEN** a side's schedule for a given weekday has the power schedule disabled, regardless of
  whether the alarm itself is marked enabled
- **THEN** the system derives no upcoming alarm instant for that side and weekday

#### Scenario: A disabled alarm contributes no instant

- **WHEN** a side's schedule for a given weekday has the alarm disabled
- **THEN** the system derives no upcoming alarm instant for that side and weekday

#### Scenario: Away mode suppresses a side's instants entirely

- **WHEN** a side is currently observed in away mode
- **THEN** the system derives no upcoming alarm instant for that side, regardless of any
  weekday's schedule

#### Scenario: An overnight session's alarm lands on the following calendar day

- **WHEN** a weekday's schedule has a power-off time in the early morning (indicating the sleep
  session continues past midnight) and an alarm time also in the early morning
- **THEN** the derived instant falls on the calendar day after that schedule's own weekday, not
  on the weekday itself

#### Scenario: The configured timezone governs the computed instant

- **WHEN** a schedule's alarm time is a given `HH:mm` and the Pod's configured timezone differs
  from the host machine's local timezone
- **THEN** the derived instant corresponds to that `HH:mm` in the Pod's configured timezone, not
  in the host machine's local timezone

#### Scenario: No timezone configured contributes no instant

- **WHEN** the settings document has no usable timezone value
- **THEN** the system derives no upcoming alarm instant for any side

### Requirement: A future schedule-override expiry skips the regular occurrence it covers

A side's `scheduleOverrides.alarm.expiresAt` value, when parseable and later than the current
moment, SHALL suppress every regular weekday-derived occurrence for that side that would
otherwise fall at or before that expiry — mirroring that the Pod's own recurring alarm job skips
a firing under the same condition. The `scheduleOverrides.alarm.disabled` field SHALL NOT by
itself suppress a regular occurrence; it governs only the separate override occurrence below.

#### Scenario: A future expiry suppresses the covered occurrence

- **WHEN** a side's next regular alarm occurrence falls at or before a configured, still-future
  `scheduleOverrides.alarm.expiresAt`
- **THEN** that occurrence is not among the system's derived upcoming instants for that side

#### Scenario: A past or absent expiry suppresses nothing

- **WHEN** a side's `scheduleOverrides.alarm.expiresAt` is absent, unparseable, or not later than
  the current moment
- **THEN** regular weekday-derived occurrences for that side are derived normally

#### Scenario: An occurrence beyond the expiry is unaffected

- **WHEN** a side's next regular alarm occurrence falls after a configured, still-future
  `scheduleOverrides.alarm.expiresAt`
- **THEN** that occurrence is still among the system's derived upcoming instants

#### Scenario: `disabled` alone does not revive a suppressed occurrence

- **WHEN** a side's `scheduleOverrides.alarm.disabled` is true but `expiresAt` is still in the
  future and covers the next regular occurrence
- **THEN** that regular occurrence remains suppressed

### Requirement: An active schedule override contributes its own one-shot instant

When a side's `scheduleOverrides.alarm` has `disabled` false and both `timeOverride` and
`expiresAt` set, with `expiresAt` later than the current moment, the system SHALL derive one
additional, one-shot upcoming instant for that side at `timeOverride`'s next occurrence in the
configured timezone.

#### Scenario: A live override produces its own instant

- **WHEN** a side's schedule override is not disabled and both its time and its expiry are set
  with the expiry still in the future
- **THEN** the system derives an additional upcoming instant at the override's time, alongside
  (or instead of, per the suppression requirement above) any regular occurrence it covers

#### Scenario: A disabled override produces no instant of its own

- **WHEN** a side's schedule override has `disabled` true
- **THEN** the system derives no override-specific instant for that side, whatever
  `timeOverride`/`expiresAt` hold

### Requirement: Each upcoming instant is covered by a bounded high-frequency polling window

For every derived upcoming instant that falls within the system's lookahead horizon, the system
SHALL request a bounded window of significantly more frequent device-status polling, covering a
symmetric margin of at least three minutes before and after that instant, without requiring any
change to the underlying polling mechanism's own base cadence or its other active modes.

A window's request SHALL compose with, and outlive neither less nor more than, any other
concurrently active reason for faster polling: the effective polling rate at any moment SHALL be
at least as fast as any single active request, including this one.

#### Scenario: A window is requested around an imminent instant

- **WHEN** a derived upcoming instant lies within the lookahead horizon
- **THEN** device-status polling runs at the configured fast alarm-polling interval for at least
  three minutes before and three minutes after that instant

#### Scenario: Outside any window, ordinary polling is unaffected

- **WHEN** no derived upcoming instant is within its window
- **THEN** device-status polling proceeds at whatever cadence other active concerns already
  determine, with no additional acceleration from this system

#### Scenario: Two nearby instants produce uninterrupted fast polling across both

- **WHEN** two derived upcoming instants (for the same or different sides) have overlapping or
  adjacent windows
- **THEN** device-status polling remains at the fast alarm-polling interval continuously across
  the combined span, with no gap back to a slower cadence in between

#### Scenario: A stale window is withdrawn when the schedule changes

- **WHEN** a previously-requested window's instant is no longer among the system's derived
  upcoming instants on a later recomputation, and that window's expiry has not yet arrived
- **THEN** the request for that window is withdrawn rather than left to run to its original expiry

### Requirement: The schedule is periodically re-derived without depending on a push notification

The system SHALL periodically recompute its derived upcoming instants from the current cached
schedules and settings documents, without depending on a change notification for either document —
so that an edit to the schedule made through another interface is eventually reflected in this
system's polling-window requests even though the platform's change-notification stream does not
report schedule or settings edits as discrete events.

#### Scenario: A schedule edit is eventually reflected

- **WHEN** the cached schedules document changes to add, remove, or retime a side's alarm between
  two of the system's periodic recomputations
- **THEN** the system's next recomputation reflects the new schedule, without requiring a restart

### Requirement: Stopping the system cancels its schedule

Stopping this system SHALL cancel its own recomputation timer and withdraw every currently active
polling-window request it holds, leaving no timer scheduled and no request outstanding on its
behalf.

#### Scenario: A stopped system leaves nothing scheduled

- **WHEN** the system is stopped, whether or not any window is currently active
- **THEN** no further recomputation ever runs, and any polling-window request it had made is
  withdrawn
