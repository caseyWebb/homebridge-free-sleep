# pod-keep-alive Specification

## Purpose
Keeps a side that HomeKit believes is on from silently turning itself off when the Pod's
12-hour `isOn` duration runs out, by periodically re-posting the remaining time while — and
only while — that side is observed on.

## Requirements

### Requirement: A side nearing expiry while on is re-armed

While a side is observed on and its remaining time is known, the system SHALL, once that
remaining time drops below the configured threshold, submit a write that resets the side's
remaining time to the configured full duration. A side whose remaining time is still at or
above the threshold SHALL NOT be written to.

#### Scenario: A side just under the threshold is re-armed

- **WHEN** a side is on and its observed remaining time drops below the configured threshold
- **THEN** a write is submitted for that side resetting its remaining time to the configured
  duration

#### Scenario: A side comfortably above the threshold is left alone

- **WHEN** a side is on and its observed remaining time is at or above the configured
  threshold
- **THEN** no write is submitted for that side

### Requirement: A side that is off is never written to

The system SHALL only ever act on a side it currently observes to be on. A side observed off
— including immediately after the Pod's daily reboot, when every side's remaining time
resets to zero — SHALL NOT be re-armed, regardless of what its remaining time was previously.

#### Scenario: An off side is not re-armed

- **WHEN** a side is observed off, whatever its remaining time
- **THEN** no write is submitted for that side

#### Scenario: A reboot is not mistaken for a side needing a keep-alive

- **WHEN** the Pod reboots and a previously-on side is subsequently observed off
- **THEN** no write is submitted for that side, and it is not turned back on

### Requirement: A re-arm write never carries a zero duration

Every write this system submits SHALL set the side's remaining time to the configured
duration, which SHALL always be a positive, non-zero number of seconds. This system SHALL
NEVER submit a write that sets a side's remaining time to zero.

#### Scenario: The re-armed duration is always positive

- **WHEN** a re-arm write is submitted for any side
- **THEN** the remaining-time value it carries is greater than zero

### Requirement: A redundant re-arm is suppressed until it would matter again

Once a re-arm write has been submitted for a side, the system SHALL NOT submit another one for
that same side until enough time has passed that the first re-arm's own remaining time would
itself be approaching the configured threshold again. This holds even if the side's observed
remaining time has not yet caught up to reflect the first re-arm.

#### Scenario: A second check right after a re-arm submits nothing further

- **WHEN** the system checks a side again shortly after re-arming it, before any new
  observation of that side's remaining time has arrived
- **THEN** no additional write is submitted for that side

#### Scenario: A later check re-arms again once due

- **WHEN** enough time has passed since a side's last re-arm that its remaining time would
  again be approaching the configured threshold
- **THEN** the side is re-armed again

### Requirement: Disabling keep-alive stops all checks and writes

When keep-alive is configured off, the system SHALL perform no periodic checks and SHALL
never submit a write on any side's behalf, regardless of how close any side's remaining time
is to expiring.

#### Scenario: A disabled configuration is inert

- **WHEN** keep-alive is configured off and a side is on with its remaining time already past
  the threshold
- **THEN** no write is ever submitted for that side

### Requirement: Re-arm writes are submitted through the shared write path

A re-arm write SHALL be submitted through the same write-submission entry point every other
write to a side uses, never dispatched directly to the Pod. It SHALL carry only the
remaining-time field, and SHALL NOT cause the cached view of that side's remaining time to
change until a subsequent observation reports the new value.

#### Scenario: A re-arm is indistinguishable in kind from any other side write

- **WHEN** a re-arm fires for a side
- **THEN** it is submitted the same way a HomeKit-triggered write to that side would be, and
  is therefore subject to the same debouncing, ordering, and merging rules as any other
  pending write to that side

#### Scenario: The re-arm is not reflected in the cached snapshot ahead of an observation

- **WHEN** a re-arm write is submitted for a side
- **THEN** that side's cached remaining-time value is unchanged until an observation of the
  Pod reports the new value

### Requirement: Stopping the system cancels its schedule

Stopping this system SHALL cancel its periodic check and leave no timer scheduled. It SHALL
NOT submit any further writes once stopped, including one that was about to become due.

#### Scenario: A stopped system schedules nothing further

- **WHEN** the system is stopped
- **THEN** no further check ever runs and no timer remains scheduled

### Requirement: An explicit user off always beats a keep-alive re-arm

Side write submissions SHALL carry an origin (`'user'` by default; `'keepAlive'` for re-arm
writes). When the write queue's debounce merge combines a user-origin `isOn` with
keep-alive-origin duration fields for the same side, the keep-alive fields SHALL be dropped
before duration-field reduction runs, so the user's intent is what reaches the Pod.
(Added at reconcile — tech lead resolution 5.)

#### Scenario: Off tapped during the same debounce window as a re-arm

- **WHEN** a keep-alive re-arm and a user `isOn: false` for the same side land in one
  debounce window
- **THEN** the dispatched patch turns the side off (mock as oracle: the side ends off), and
  the user's optimistic off tile never reverts

#### Scenario: A re-arm alone is unaffected

- **WHEN** a keep-alive re-arm merges with no user-origin fields
- **THEN** it dispatches unchanged and refreshes the side's remaining duration
