# pod-snapshot Specification

## Purpose

The plugin's single cached view of a Pod: the last state observed for each API endpoint the
plugin reads, the derived connection state, and the optimistic overlay a pending write places
over it. It is the only thing HomeKit read handlers are allowed to touch, and its typed change
notifications are how every later accessory learns that something moved.

## Requirements

### Requirement: A snapshot read is synchronous and performs no I/O

Reading the snapshot SHALL return a value immediately and synchronously. It SHALL NOT return
a promise, SHALL NOT contact the Pod, and SHALL NOT block on any in-flight request. This holds
regardless of how stale the cached state is, whether a poll is currently in flight, and whether
the Pod is reachable.

This is the invariant the whole plugin rests on: HomeKit read handlers fire dozens of times
within a few hundred milliseconds when the app opens, and the Pod's status endpoint is a
serialised hardware round-trip.

#### Scenario: A read burst issues no requests

- **WHEN** the snapshot is read eighty times in immediate succession, with a Pod request
  already in flight
- **THEN** every read returns immediately with the currently cached value, and the Pod
  receives no additional request as a result of any of them

#### Scenario: Reading an unreachable Pod's snapshot still returns

- **WHEN** the Pod has been unreachable since the last successful poll and the snapshot is read
- **THEN** the read returns the last successfully observed state rather than failing, blocking,
  or waiting for the next poll

### Requirement: Snapshot state is carried in the Pod's own units

Every value the snapshot exposes SHALL be in the unit and type the Pod reports it in:
temperatures as integer °F, power and alarm state as booleans, water level as the raw string
the Pod returned plus its three-state interpretation. The snapshot SHALL NOT convert to
HomeKit units, and SHALL NOT round, clamp, or normalise a reading into a range the Pod does
not itself enforce.

Change detection SHALL therefore compare values by exact equality in those units.

#### Scenario: An out-of-range reading survives

- **WHEN** the Pod reports a current temperature below the settable minimum, as a cold room
  legitimately produces
- **THEN** the snapshot carries that value unchanged rather than clamping it

#### Scenario: Equal degrees produce no change

- **WHEN** two consecutive observations report the same integer °F for a field
- **THEN** no change is reported for that field, with no tolerance or epsilon involved

### Requirement: Each endpoint's state is unknown until its first success

The snapshot SHALL distinguish "not yet observed" from any observed value, per endpoint class.
A class whose first poll has not yet succeeded SHALL read as unknown rather than as a
default, a zero value, or an empty object. Once a class has been observed successfully, a
later failure SHALL NOT revert it to unknown — the last successful observation SHALL stand.

#### Scenario: Before the first poll

- **WHEN** the snapshot is read before any poll has succeeded
- **THEN** each endpoint class reads as unknown, and no fabricated default is returned

#### Scenario: A failure does not erase known state

- **WHEN** an endpoint class has been observed successfully and its next poll fails
- **THEN** the snapshot still returns the last successful observation for that class

### Requirement: Connection state is exposed as data

The snapshot SHALL expose the plugin's view of the Pod's reachability: whether the last poll
of the status endpoint succeeded, the number of consecutive failures, the time of the last
success, and the kind of the last failure, distinguishing a Pod that could not be reached
from one that answered with an unusable response.

The snapshot SHALL NOT decide what to do about an outage. It reports; policy belongs to the
accessory layer.

#### Scenario: Reachability transitions are observable

- **WHEN** the status endpoint fails after a run of successes, and later succeeds again
- **THEN** the snapshot reports the transition to unreachable and back, with the consecutive
  failure count rising and resetting accordingly

#### Scenario: Failure kinds are distinguishable

- **WHEN** one poll fails because the Pod could not be reached and another fails because the
  response did not match the expected shape
- **THEN** the reported failure kinds differ, so a caller can treat the first as the Pod's
  routine daily reboot and the second as a defect

### Requirement: A committed snapshot is immutable and shared by reference

Each committed snapshot SHALL be a distinct, deeply immutable value. Committing new state
SHALL create a new snapshot rather than mutating the previous one, so a caller holding an
earlier snapshot continues to observe the state as of the moment it read.

Because reads are frequent and commits are rare, a read SHALL NOT copy: it SHALL return the
committed value directly, and a caller SHALL NOT be able to corrupt shared state through it.

#### Scenario: A held snapshot does not change underneath its holder

- **WHEN** a caller reads the snapshot, a poll then commits new state, and the caller inspects
  the value it held
- **THEN** the held value is unchanged, and a fresh read returns the new state

#### Scenario: A caller cannot mutate shared state

- **WHEN** a caller attempts to modify a field of the value a read returned
- **THEN** the attempt does not alter what any subsequent read returns

### Requirement: Change notifications are typed, batched, and delivered per commit

The snapshot SHALL offer subscription to change notifications. Each commit that alters at
least one watched field SHALL produce exactly one notification carrying every field that
changed in that commit, each with its field identity, the side it belongs to where applicable,
its previous value, and its new value — all in the Pod's units. A commit that alters no
watched field SHALL produce no notification.

A subscriber SHALL be able to unsubscribe, after which it receives no further notifications.
When a notification is delivered, a read of the snapshot SHALL already return the new state.

#### Scenario: One notification per commit, not one per field

- **WHEN** a single observation changes a side's target temperature and its power state at
  once
- **THEN** subscribers receive one notification listing both changes, not two notifications

#### Scenario: An unchanged poll is silent

- **WHEN** an observation is identical to the previous one in every watched field
- **THEN** no notification is delivered

#### Scenario: The snapshot is current when subscribers are told

- **WHEN** a subscriber reads the snapshot from inside a change notification
- **THEN** the value it reads reflects the change it was just told about

#### Scenario: Unsubscribing is honoured

- **WHEN** a subscriber unsubscribes and a subsequent commit changes a watched field
- **THEN** that subscriber is not called

### Requirement: Watched fields are an explicit list that excludes continuously varying counters

The set of fields that produce change notifications SHALL be enumerated explicitly rather than
derived from a generic deep comparison of responses. It SHALL cover, per side, the current
temperature, the target temperature, the power state, the alarm-vibrating state, and away
mode; and, for the device as a whole, the water-level interpretation, the priming state, and
reachability.

A field that changes on essentially every observation by its nature — in particular the
remaining-seconds countdown — SHALL NOT be a watched field. It SHALL still be readable from
the snapshot, so that callers which genuinely need it can poll it, but it SHALL NOT generate a
notification, because doing so would emit an event on every poll forever.

#### Scenario: The countdown does not generate events

- **WHEN** consecutive observations differ only in a side's remaining-seconds value
- **THEN** no change notification is delivered, and reading the snapshot still returns the new
  remaining-seconds value

#### Scenario: Schedule contents do not generate events

- **WHEN** the schedules endpoint returns different contents than before
- **THEN** the new contents are readable from the snapshot and no per-field change notification
  is generated for them

### Requirement: An optimistic overlay takes precedence over observed values

The snapshot SHALL support overlay entries, each pinning one field of one side to a value for
a bounded period. While an entry is active, every read and every change comparison SHALL use
the overlaid value in place of the observed one. Installing, refreshing, or removing an entry
SHALL be a commit like any other, and SHALL therefore emit a change notification if it alters
a watched field's effective value.

An overlay entry SHALL only be permitted on a field whose post-write value is exactly
predictable. The remaining-seconds countdown SHALL NOT be overlaid.

#### Scenario: An overlay is visible immediately

- **WHEN** an overlay entry pins a side's target temperature to a new value
- **THEN** the next read returns the new value, and subscribers are notified of the change,
  without any Pod round-trip having occurred

#### Scenario: A disagreeing observation is suppressed

- **WHEN** an overlay pins a side's target temperature and an observation arrives reporting the
  old value — because the poll raced the write
- **THEN** the read still returns the overlaid value and no change notification is delivered
  for that field

#### Scenario: Refreshing an entry replaces it

- **WHEN** a second overlay entry is installed for a field that already has one
- **THEN** the later value and the later expiry apply, and the earlier entry no longer has any
  effect

### Requirement: An overlay entry is retired when an observation agrees with it

When an observation reports, for an overlaid field, a value exactly equal to the overlaid
value, the entry SHALL be removed at that commit. Removal SHALL NOT change the effective value
and SHALL therefore emit no change notification.

Agreement for a power-state entry SHALL be evaluated against the power state the Pod reports,
which the Pod derives from remaining seconds rather than storing — so an entry pinning a side
on is satisfied by any positive remaining time, not by an exact duration.

#### Scenario: Agreement quietly clears the entry

- **WHEN** an observation reports the same target temperature the overlay pins
- **THEN** the entry is removed, no change notification is emitted, and a subsequent
  disagreeing observation is no longer suppressed

#### Scenario: Power-on agreement does not require an exact duration

- **WHEN** an overlay pins a side on and an observation reports that side on with an arbitrary
  positive remaining time
- **THEN** the entry is treated as agreed and removed

### Requirement: An overlay that expires while the observation still disagrees pushes the truth

Every overlay entry SHALL carry an expiry. When the expiry passes and the most recent
observation for that field still disagrees, the entry SHALL be dropped and the observed value
SHALL become effective, emitting a change notification for the reversion.

Expiry SHALL be evaluated on a timer as well as on observation, so that an entry cannot
outlive its window merely because the Pod stopped answering. Continuing to present a value the
hardware never accepted is worse than showing the user that the write did not take.

#### Scenario: A failed write reverts visibly

- **WHEN** an overlay pins a target temperature, the Pod never reports that value, and the
  entry's window elapses
- **THEN** the entry is dropped, reads return the observed value again, and subscribers receive
  a change notification carrying the overlaid value as previous and the observed value as
  current

#### Scenario: Expiry fires without a poll

- **WHEN** an overlay entry's window elapses while the Pod is unreachable and no observation
  has arrived
- **THEN** the entry is still dropped at its expiry and the reversion to the last observed
  value is notified

#### Scenario: An agreed entry never expires

- **WHEN** an observation agrees with an entry before its window elapses
- **THEN** the entry is already gone and no reversion notification is ever emitted for it

### Requirement: Notification delivery is isolated and re-entrancy safe

A subscriber that throws SHALL NOT prevent other subscribers from receiving the notification,
SHALL NOT abort the commit, and SHALL NOT stop future notifications from being delivered to
any subscriber including itself. The failure SHALL be logged.

A subscriber that causes further state to change while it is being notified SHALL NOT corrupt
the sequence: the resulting change SHALL be applied after the current notification completes
and SHALL produce its own notification. Subscribing or unsubscribing during a notification
SHALL NOT affect who receives the notification currently being delivered.

#### Scenario: One bad subscriber does not silence the rest

- **WHEN** the first of three subscribers throws during a notification
- **THEN** the remaining two are still called, the error is logged, and the next commit
  notifies all three again

#### Scenario: A subscriber that writes back is sequenced

- **WHEN** a subscriber installs an overlay entry while handling a notification
- **THEN** that entry takes effect and produces a separate, later notification rather than
  being folded into or interleaved with the one in progress
