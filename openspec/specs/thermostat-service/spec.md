# thermostat-service Specification

## Purpose

The per-side HomeKit thermostat — the plugin's reason to exist. It defines which
characteristics each bed side publishes, what each one reports, how a user's mode and setpoint
changes become Pod writes, and how observed Pod state becomes HomeKit updates without the
published value ever fighting the value the user is currently dragging.

## Requirements

### Requirement: Each enabled side publishes one primary thermostat with a fixed characteristic set

Each side accessory the configuration enables SHALL publish exactly one thermostat service,
marked as that accessory's primary service, exposing exactly these characteristics: the current
heating/cooling state, the target heating/cooling state, the current temperature, the target
temperature, and the temperature display units.

The service SHALL NOT expose a heating threshold temperature or a cooling threshold
temperature. The Pod is a single-setpoint device, and publishing either threshold turns the
Home app's automatic mode into a two-setpoint range control that no Pod state can satisfy.

The hub accessory SHALL NOT publish a thermostat.

#### Scenario: Both sides publish a thermostat when both are enabled

- **WHEN** the platform starts with both sides enabled
- **THEN** each side accessory carries exactly one thermostat service, that service is the
  accessory's primary service, and the hub accessory carries none

#### Scenario: Neither threshold characteristic is present

- **WHEN** a published thermostat service's characteristics are enumerated
- **THEN** the list contains the five characteristics named above and contains neither a
  heating threshold temperature nor a cooling threshold temperature

#### Scenario: A disabled side publishes nothing

- **WHEN** the platform starts with only one side enabled
- **THEN** only that side's accessory exists and carries a thermostat, and no thermostat exists
  for the other side

### Requirement: The mode picker offers only Off and Auto, and Off is the fallback

The target heating/cooling state SHALL declare exactly two acceptable values — off and
automatic — with **off declared first**. HomeKit replaces a reported value that is not in the
declared list with the first declared value, so declaring off first guarantees that any such
replacement lands on off rather than on a mode that would imply the bed is running.

Every property declaration on every characteristic of this service SHALL be applied while the
service is being constructed, before any value is reported and before the accessory is
published. A property declaration applied after publication does not change the published
configuration that controllers cache.

#### Scenario: Only two modes are offered

- **WHEN** the acceptable values of the target heating/cooling state are enumerated
- **THEN** exactly two values are offered, off and automatic, and off is first in the list

#### Scenario: A heat or cool write is refused before it reaches the Pod

- **WHEN** a controller writes heat or cool to the target heating/cooling state
- **THEN** the write is rejected as an invalid value, no Pod request is issued, and the reported
  mode is unchanged

#### Scenario: Properties are declared before any value is reported

- **WHEN** the construction of a thermostat service is traced
- **THEN** every property declaration on every one of its characteristics happens before the
  service reports a value and before the accessory is registered

### Requirement: The target temperature is settable at whole-degree-Fahrenheit resolution across the whole range

The target temperature SHALL be published with the single set of properties the temperature
boundary defines, so that every whole degree Fahrenheit from the minimum to the maximum of the
settable range — both endpoints included — is selectable and no other value is. This service
SHALL NOT define its own range, step, or maximum margin.

#### Scenario: The published properties are the shared ones

- **WHEN** the target temperature's declared minimum, maximum and step are compared with the
  temperature boundary's published properties
- **THEN** they are identical

#### Scenario: Every whole degree in the range is reachable

- **WHEN** the values the published target temperature accepts are enumerated through HomeKit's
  own validator
- **THEN** they correspond exactly to the whole degrees Fahrenheit of the settable range,
  including both endpoints

### Requirement: The current temperature is reported truthfully and is never clamped into the settable range

The current temperature SHALL be published with a range wide enough to carry any reading the
Pod can produce, and SHALL NOT be constrained to the settable range. The Pod derives its
reported current temperature from a raw hardware level that legitimately goes below the
settable minimum in a cold room; narrowing the published range would silently rewrite a true
reading into a false one.

#### Scenario: A sub-range reading is reported unchanged

- **WHEN** the cached observation reports a current temperature below the settable minimum
- **THEN** the current temperature characteristic reports that reading, converted, rather than
  the settable minimum

#### Scenario: The published range admits out-of-range readings

- **WHEN** the current temperature's declared minimum and maximum are inspected
- **THEN** they are wider than the settable range in both directions, and no value the Pod can
  report falls outside them

### Requirement: The current state never reports Off while the side is running, and uses a sticky one-degree deadband

The current heating/cooling state has no idle value; its only permissible values are off, heat
and cool. The Home app builds an accessory tile's subtitle from the current state, so reporting
off for a side that is running would display "Off" beneath a bed that is actively heating.

The reported current state SHALL therefore be derived as: off when the side is not running;
heat when the target exceeds the current temperature by at least one degree Fahrenheit; cool
when the current temperature exceeds the target by at least one degree Fahrenheit; and
otherwise the most recently reported non-off state, so that a reading sitting at the setpoint
does not flicker between heat and cool. When there is no previously reported non-off state, the
sign of the difference SHALL decide, with a non-negative difference reporting heat.

This service SHALL NOT declare acceptable values for the current heating/cooling state; the
three values above are already its only ones.

#### Scenario: A running side never reports Off

- **WHEN** the side is running, for any combination of current and target temperature the Pod
  can report
- **THEN** the current state is heat or cool, and never off

#### Scenario: Heat and cool are chosen by the one-degree threshold

- **WHEN** the target is at least one degree Fahrenheit above the current temperature
- **THEN** the current state is heat
- **WHEN** the current temperature is at least one degree Fahrenheit above the target
- **THEN** the current state is cool

#### Scenario: The state is sticky inside the deadband

- **WHEN** the state has been reported as heat, and successive observations bring the current
  temperature to within one degree Fahrenheit of the target, oscillating either side of it
- **THEN** the reported state stays heat throughout, and no update is emitted for it

#### Scenario: Turning the side off reports Off

- **WHEN** an observation reports the side no longer running
- **THEN** the current state is off — which, since the sticky state is simply
  `characteristic.value` and nothing else (design.md, "The sticky deadband, and where its state
  lives"), overwrites whatever heat/cool state was reported before the side turned off. A
  subsequent on cycle that begins inside the deadband is therefore governed by the seed clause
  (the sign of the target/current difference), not by resurrecting the state from before the
  side was off

### Requirement: Every read is served synchronously from the cached observation

Every read handler on this service SHALL return a value synchronously from the plugin's cached
view of the Pod. No read handler SHALL be asynchronous, await anything, or cause a Pod request
of any kind — directly or by requesting a refresh. The Pod's status endpoint is a serialised
hardware round-trip, and the Home app issues a read for every characteristic each time it
opens.

#### Scenario: A read burst issues no Pod requests

- **WHEN** every characteristic of both sides' thermostats is read repeatedly in immediate
  succession
- **THEN** every read returns a value, and the Pod receives no request attributable to any of
  them

#### Scenario: No read handler is asynchronous

- **WHEN** the read handlers registered by this service are inspected
- **THEN** none of them returns a promise

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

### Requirement: Non-temperature characteristics are updated only on an actual change

The target heating/cooling state and the current heating/cooling state SHALL be updated only
when the value they would report changes. An observation that leaves both unchanged SHALL
produce no update for either.

#### Scenario: An unchanged observation is silent

- **WHEN** an observation reports the same power state, current temperature and target
  temperature as the previous one
- **THEN** no update is pushed for any characteristic of the service

#### Scenario: A power change updates both state characteristics

- **WHEN** an observation reports a side that was running as no longer running
- **THEN** the target state is updated to off and the current state is updated to off

### Requirement: Display units are served and stored locally, and never written to the Pod

The temperature display units characteristic SHALL be served from the accessory's persisted
context, seeded once from the Pod's configured temperature format the first time that format is
observed. A controller writing this characteristic SHALL be accepted and the value persisted in
the accessory's context.

The plugin SHALL NEVER write this value to the Pod. The Pod stores its temperature format in
its persisted settings, and every write to those settings makes it cancel and rebuild every
scheduled job — an unacceptable cost for a display preference that the Apple Home app ignores
entirely in favour of the device's own region setting.

#### Scenario: The unit is seeded once from the Pod

- **WHEN** the Pod's configured temperature format is observed for the first time and the
  accessory's context holds no display unit
- **THEN** the characteristic reports the corresponding unit and the context records it

#### Scenario: A write is accepted and does not reach the Pod

- **WHEN** a controller writes a different display unit
- **THEN** the write succeeds, subsequent reads report the written unit, and the Pod receives no
  request of any kind

#### Scenario: A later Pod format change does not overwrite the user's choice

- **WHEN** the accessory's context already holds a display unit and a later observation reports
  a different temperature format on the Pod
- **THEN** the characteristic continues to report the stored unit and no update is pushed

#### Scenario: The stored unit survives a restart

- **WHEN** a display unit has been written and the plugin is restarted
- **THEN** the characteristic reports the written unit rather than re-seeding from the Pod
