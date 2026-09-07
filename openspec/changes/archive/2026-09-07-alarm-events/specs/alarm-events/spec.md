## Purpose

Exposes a Pod side's alarm as two HomeKit primitives: an instantaneous "just started ringing"
event a Home automation can trigger on, and a switch that stops the vibration.

## ADDED Requirements

### Requirement: A side publishes an alarm-press event on the rising edge of vibration

Each published side accessory SHALL carry a stateless programmable-switch service that fires a
single-press event exactly when that side's alarm transitions from not vibrating to vibrating. It
SHALL NOT fire on any other transition, and SHALL NOT fire from the platform's first-ever
observation of that side's vibration state, since that observation cannot distinguish "just
started" from "was already vibrating before this platform launch."

#### Scenario: A rising edge fires exactly one press

- **WHEN** a side's alarm-vibrating state is observed to change from not-vibrating to vibrating
- **THEN** that side's programmable-switch service reports exactly one single-press event

#### Scenario: The falling edge fires nothing

- **WHEN** a side's alarm-vibrating state is observed to change from vibrating to not-vibrating
- **THEN** that side's programmable-switch service reports no press event

#### Scenario: An unchanged state fires nothing

- **WHEN** a side's alarm-vibrating state is observed with the same value as previously observed
- **THEN** that side's programmable-switch service reports no press event

#### Scenario: A pre-existing vibration observed at startup fires no press

- **WHEN** the platform's first-ever observation of a side reports its alarm already vibrating
- **THEN** that side's programmable-switch service reports no press event for that first
  observation

### Requirement: A side publishes a switch that reflects and can stop the alarm

Each published side accessory SHALL carry a switch service, distinct from the programmable
switch, that reports on while that side's alarm is observed vibrating and off otherwise. Turning
this switch off SHALL submit a write clearing that side's vibration; turning it off when the
alarm is already stopped SHALL be accepted with no observable effect.

#### Scenario: The switch reflects an active alarm

- **WHEN** a side's alarm is observed vibrating
- **THEN** that side's dismiss switch reports on

#### Scenario: The switch reflects a stopped alarm

- **WHEN** a side's alarm is observed not vibrating
- **THEN** that side's dismiss switch reports off

#### Scenario: Turning the switch off stops the alarm

- **WHEN** a side's dismiss switch is turned off while that side's alarm is vibrating
- **THEN** a write is submitted for that side clearing its vibration state, and no other field of
  that side is affected by this write

#### Scenario: Turning the switch off with nothing to dismiss is harmless

- **WHEN** a side's dismiss switch is turned off while that side's alarm is already not vibrating
- **THEN** the write is submitted the same as any other off-write, and the switch continues to
  report off with no error surfaced to the caller

### Requirement: Turning the dismiss switch on is accepted and reverted, never sent to the Pod

Turning a side's dismiss switch on SHALL be accepted without error and SHALL NOT be submitted as
a write to the Pod. The switch's reported state SHALL revert to reflecting the side's actual
observed vibration state shortly afterward.

#### Scenario: An on-write is accepted, not forwarded, and reverts

- **WHEN** a side's dismiss switch is turned on
- **THEN** the write is accepted without error, no write reaches the Pod as a result, and the
  switch's reported state shortly reverts to match the side's actual observed vibration state

### Requirement: Both alarm services exist for every published side and no other accessory

The programmable-switch and dismiss-switch services SHALL be published on every side accessory
the platform currently publishes, and SHALL NOT be published on the hub accessory.

#### Scenario: Both services exist per published side

- **WHEN** the platform publishes a side accessory
- **THEN** that accessory carries exactly one alarm programmable-switch service and exactly one
  dismiss switch service, in addition to its other services

#### Scenario: The hub carries neither

- **WHEN** the hub accessory is inspected
- **THEN** it carries neither an alarm programmable-switch service nor a dismiss switch service
