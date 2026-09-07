## Purpose

A per-side `OccupancySensor`, driven by a configurable source (`'presence'` or `'vitals'`),
whose `StatusActive` characteristic is the load-bearing part: it distinguishes "this source has
proven it can tell the truth" from "this source has answered, but that answer might just be a
stale default," so that the sensor is never confidently, permanently wrong.

## ADDED Requirements

### Requirement: The occupancy sensor exists only when a source is configured

A side accessory SHALL carry an `OccupancySensor` service if and only if `occupancySource` is
configured as `'presence'` or `'vitals'`. When `occupancySource` is `'none'` — the default —
no side accessory SHALL carry this service, and a previously-published one SHALL be removed on
restore.

#### Scenario: Default configuration publishes no occupancy sensor

- **WHEN** the platform starts with `occupancySource` omitted (or explicitly `'none'`)
- **THEN** neither side accessory carries an `OccupancySensor` service

#### Scenario: Configuring a source publishes the sensor per enabled side

- **WHEN** the platform starts with `occupancySource: 'presence'` or `'vitals'` and `sides:
  'both'`
- **THEN** both side accessories carry exactly one `OccupancySensor` service each

#### Scenario: Reverting to `'none'` removes a previously-published sensor

- **WHEN** the platform previously ran with a non-`'none'` `occupancySource` and is restarted
  with `occupancySource: 'none'`
- **THEN** the occupancy service is removed from every side accessory that carried it, without
  affecting that accessory's other services

### Requirement: `presence` source reports the Pod's raw presence flag, gated by proof of a real transition

When `occupancySource` is `'presence'`, a side's `OccupancyDetected` SHALL reflect the most
recently observed `present` value for that side from the presence endpoint. `StatusActive`
SHALL report inactive until at least one observation for that side reports a value for
`lastUpdatedAt` different from the value first observed this launch, and SHALL report active
from that point on, including through any later observation — even one that reports the same
value as the original baseline.

This distinction exists because the presence endpoint's backing store resets to a fixed
default on every Pod restart, which is itself a valid, successful response that carries no
information about whether the underlying detector has produced a real result since this
plugin started watching.

#### Scenario: A fresh launch is inactive before any transition

- **WHEN** the platform has just started with `occupancySource: 'presence'`, and a side's
  presence has been observed only reporting the same value repeatedly since launch
- **THEN** that side's occupancy sensor reports `StatusActive` inactive, whatever the reported
  occupancy value is

#### Scenario: A real transition proves the source live

- **WHEN** a side's observed presence value changes at least once after the plugin's first
  observation of it this launch
- **THEN** that side's occupancy sensor reports `StatusActive` active from that point onward

#### Scenario: Active status does not regress

- **WHEN** a side's occupancy sensor has become active, and a later observation reports the
  same value it started with at launch
- **THEN** `StatusActive` remains active

#### Scenario: Occupancy value follows the raw flag regardless of active status

- **WHEN** a side's presence value is observed, whether or not that side's `StatusActive` has
  yet become active
- **THEN** `OccupancyDetected` reflects the most recently observed value

### Requirement: `vitals` source derives occupancy from a recent heart-rate reading, proven live by any reading ever

When `occupancySource` is `'vitals'`, a side's `OccupancyDetected` SHALL report occupied
whenever the most recent poll of the vitals endpoint, windowed to a fixed recent interval,
includes at least one row for that side carrying a non-null heart rate; otherwise it SHALL
report not occupied. `StatusActive` SHALL report inactive until the first poll that returns at
least one row for that side, at which point it SHALL report active and SHALL remain active
regardless of how many subsequent polls return no rows for that side.

This asymmetry with the presence source is deliberate: the vitals data store does not reset on
a Pod restart, and the underlying pipeline only ever writes a row while a side is genuinely
occupied — a side observed correctly and continuously empty for longer than the recent window
is expected to produce zero rows, which is not evidence that the source has stopped working.

#### Scenario: A fresh reading reports occupied

- **WHEN** the most recent windowed poll of the vitals endpoint includes a row for a side with
  a non-null heart rate
- **THEN** that side's occupancy sensor reports occupied

#### Scenario: No recent reading reports not occupied

- **WHEN** the most recent windowed poll of the vitals endpoint includes no row for a side, or
  only rows with a null heart rate
- **THEN** that side's occupancy sensor reports not occupied

#### Scenario: The very first reading proves the source live

- **WHEN** a side's vitals endpoint poll returns at least one row for that side for the first
  time since the plugin started
- **THEN** that side's occupancy sensor reports `StatusActive` active immediately, with no
  requirement to observe a change across two readings

#### Scenario: An empty bed does not un-prove the source

- **WHEN** a side's occupancy sensor has become active, and a subsequent poll returns no rows
  for that side because the side is genuinely unoccupied
- **THEN** `StatusActive` remains active, and only `OccupancyDetected` changes to not occupied

### Requirement: The occupancy sensor never fails a read

The occupancy sensor's read handlers SHALL NOT throw, regardless of the Pod's reachability,
whether the configured source's data has ever been observed, or whether it has been proven
live. `StatusActive` is this service's designated mechanism for expressing "do not trust this
reading," and degrading it is the complete, correct response to every one of those conditions —
there is no additional escalation to a read failure for this service.

#### Scenario: An unobserved source never fails a read

- **WHEN** the configured source has produced no observation yet
- **THEN** a read of either characteristic returns a value without throwing

#### Scenario: An unreachable Pod never fails a read

- **WHEN** the Pod is unreachable and the occupancy sensor's characteristics are read
- **THEN** both reads return their last-known values without throwing, and `StatusActive`
  simply stops advancing rather than being forced to any particular value by the outage itself

### Requirement: A change to either value is pushed within one poll interval

Whenever an observation changes a side's occupancy value or its active status, the affected
side's occupancy sensor SHALL be updated without requiring a subsequent characteristic read to
notice — the same push-on-change mechanism every other observed field already uses.

#### Scenario: Getting into bed is reflected promptly

- **WHEN** a side transitions from unoccupied to occupied under the configured source
- **THEN** that side's `OccupancyDetected` characteristic is pushed to the new value within one
  polling interval of that source, with no explicit read required to observe it

#### Scenario: An unrelated change does not push the occupancy sensor

- **WHEN** an observation changes a field the occupancy sensor does not read — for example the
  other side's occupancy, or a target temperature
- **THEN** no update is pushed to the occupancy sensor as a result

### Requirement: Restoring from the accessory cache reuses the existing service

An occupancy sensor already present on a restored side accessory SHALL be reused, not
recreated, exactly like every other restored service on that accessory.

#### Scenario: A restart with an unchanged configuration does not duplicate the service

- **WHEN** the platform restarts with `occupancySource` unchanged from the previous launch and
  a side accessory already carries an occupancy sensor
- **THEN** that same service is reused, and the accessory does not end up with two occupancy
  sensors
