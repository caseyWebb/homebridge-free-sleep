## MODIFIED Requirements

### Requirement: A characteristic is updated only when its value changed in the Pod's own units

The plugin SHALL keep, per side accessory, a shadow record of the last Fahrenheit value it
published for the target temperature and for the current temperature. It SHALL push a
temperature update to HomeKit only when a newly observed Fahrenheit value differs from the
shadow, and SHALL update the shadow whenever it publishes or accepts a value.

This comparison SHALL be made in whole degrees Fahrenheit, not in the converted unit. HomeKit
stores the exact value a controller wrote, unsnapped, so a converted value re-derived from the
same Fahrenheit degree does not compare equal to it; pushing it would emit a change event and
redraw the slider under the user's finger.

A write handler SHALL claim the written Fahrenheit degree into the shadow and SHALL NOT push an
update for the value it was just given.

The shadow SHALL be held in the accessory's persisted context, so a plugin restart does not
produce a spurious update for a value that was already published.

Before an observed target temperature is compared against the shadow or published, it SHALL be
clamped to the settable range's bounds. The shadow for the target temperature SHALL never record
a value outside that range, even when the Pod itself reports one. This clamping applies only to
the target temperature; the current temperature's shadow and comparisons are unaffected, per
this service's separate requirement that current temperature is never clamped into the settable
range.

#### Scenario: An unchanged degree pushes nothing

- **WHEN** successive observations report the same whole degree Fahrenheit for a side's target
  temperature
- **THEN** no update is pushed for that characteristic

#### Scenario: A write is not echoed back to the writer

- **WHEN** a controller writes a target temperature and the change is accepted
- **THEN** no update is pushed for that characteristic as a result of the write itself

#### Scenario: The confirming observation of a written value pushes nothing

- **WHEN** a controller writes a target temperature and a later observation reports that same
  whole degree Fahrenheit
- **THEN** no update is pushed for that characteristic, and the reported value is the written
  degree

#### Scenario: A genuine external change is pushed

- **WHEN** the Pod's own interface changes a side's target temperature to a different whole
  degree and the next observation reports it
- **THEN** exactly one update is pushed for that characteristic, carrying the new degree

#### Scenario: The shadow survives a restart

- **WHEN** the plugin is restarted and the first observation reports the same values that were
  published before the restart
- **THEN** no update is pushed for either temperature characteristic

#### Scenario: An out-of-range target temperature is clamped before it reaches the shadow

- **WHEN** an observation reports a target temperature outside the settable range's bounds
- **THEN** the target temperature characteristic reports the nearest bound of the settable
  range, converted, and the shadow records that clamped bound rather than the raw out-of-range
  degree

#### Scenario: An out-of-range reading does not permanently desynchronize the shadow

- **WHEN** an observation reports an out-of-range target temperature, and a later observation
  reports an in-range degree different from the clamped bound that was published
- **THEN** exactly one update is pushed for the in-range degree — the earlier out-of-range
  reading does not suppress it

### Requirement: Mode and setpoint writes become one minimal Pod patch each

Writing off or automatic to the target heating/cooling state SHALL submit a power patch for
that side and nothing else. Writing the target temperature SHALL submit a target-temperature
patch, in whole degrees Fahrenheit, for that side and nothing else. Neither SHALL submit a
persisted-settings write.

Writes SHALL be submitted to the plugin's write path so that writes arriving close together are
merged into a single Pod request, and each write handler SHALL settle only when the dispatch
carrying it settles.

#### Scenario: Turning a side on submits only a power patch

- **WHEN** automatic is written to the target heating/cooling state
- **THEN** the Pod receives one status write whose body sets that side's power on, carrying no
  temperature field and no duration field

#### Scenario: A setpoint change submits only a temperature patch

- **WHEN** a target temperature is written
- **THEN** the Pod receives one status write whose body sets that side's target temperature to
  the corresponding whole degree Fahrenheit, and carries no power field

#### Scenario: A slider drag produces one Pod request

- **WHEN** a controller writes a rapid succession of target temperatures to one side, as
  dragging the Home app's temperature slider does
- **THEN** the Pod receives exactly one status write for that side, carrying the last value of
  the drag

#### Scenario: A mode change and a setpoint change together are one request

- **WHEN** the target heating/cooling state and the target temperature of the same side are
  written within a few milliseconds of each other
- **THEN** the Pod receives exactly one status write, whose body carries both the power field
  and the temperature field for that side

#### Scenario: No settings write is ever issued

- **WHEN** any sequence of mode, setpoint and display-unit writes is performed
- **THEN** the Pod receives no write to its persisted-settings endpoint, because such a write
  makes it cancel and rebuild every scheduled job

#### Scenario: A full-range drag never snaps back mid-drag

- **WHEN** a controller writes a rapid succession of target temperatures spanning the whole
  settable range to one side — long enough to span more than one of the write path's own
  internal batches — while a stale observation reporting an earlier, disagreeing target
  temperature is delivered partway through
- **THEN** the reported target temperature never moves backward to a value earlier than the
  drag's current point; every value it takes on on the way to the drag's final value is a value
  the drag itself specified
