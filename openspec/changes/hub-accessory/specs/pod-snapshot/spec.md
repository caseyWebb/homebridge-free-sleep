## MODIFIED Requirements

### Requirement: Watched fields are an explicit list that excludes continuously varying counters

The set of fields that produce change notifications SHALL be enumerated explicitly rather than
derived from a generic deep comparison of responses. It SHALL cover, per side, the current
temperature, the target temperature, the power state, the alarm-vibrating state, and away
mode; and, for the device as a whole, the water-level interpretation, the priming state,
reachability of the device-status endpoint, and whether the most recently observed subsystem
health report contains a failed subsystem.

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

#### Scenario: A change in the subsystem-health-failure derivation generates one notification

- **WHEN** a subsystem-health observation changes whether any subsystem reports a failed
  status, compared to the previous subsystem-health observation
- **THEN** exactly one change notification is delivered carrying that field

#### Scenario: An unchanged subsystem-health-failure derivation generates no event

- **WHEN** a new subsystem-health observation reports the identical set of failed-or-not
  subsystems, and the derived failure boolean is therefore unchanged
- **THEN** no change notification is delivered for that field

## ADDED Requirements

### Requirement: Subsystem-health reachability is exposed as data, independently of the device-status endpoint's reachability

The snapshot SHALL expose the plugin's view of whether its most recent attempt to read the
Pod's subsystem-health endpoint succeeded, and the time of its last success, tracked
separately from the device-status endpoint's own reachability — a poll of one endpoint
failing SHALL NOT be reported as a failure of the other.

#### Scenario: Subsystem-health reachability transitions independently of device status

- **WHEN** the subsystem-health endpoint stops responding while the device-status endpoint
  continues to be polled successfully
- **THEN** the snapshot reports subsystem-health as unreachable while continuing to report the
  device-status endpoint as reachable

#### Scenario: A subsystem-health failure does not erase the last observed report

- **WHEN** subsystem health has been observed successfully at least once, and a later poll of
  it fails
- **THEN** the snapshot still returns the last successfully observed subsystem-health report,
  and the derived failed-subsystem boolean computed from it is unchanged by the failed poll
