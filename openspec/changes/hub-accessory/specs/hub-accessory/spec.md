## Purpose

Defines the five additional services the hub accessory can carry beyond its existing
connection sensor — water-low, prime, LED, test-alarm, and server-fault — their default
exposure, what they read, and what a write to each one does.

## ADDED Requirements

### Requirement: The hub publishes a water-low sensor unconditionally

The hub accessory SHALL publish a water-level sensor whenever the platform starts with a
configured host, independently of any config key gating the other four services this
capability adds. The sensor's HomeKit service type SHALL be a contact sensor by default, or a
leak sensor when configured, but SHALL exist in either case.

The sensor SHALL report the adequate state when the Pod's last-observed water level
interprets as adequate, and the low state when it interprets as low. When the last-observed
water level interprets as unknown, the sensor SHALL continue reporting whichever of those two
states it last reported, and SHALL additionally report a fault, rather than reporting low.

#### Scenario: The sensor exists without any config key enabling it

- **WHEN** the platform starts with a configured host and no water-related config key set
- **THEN** the hub accessory carries a water-level sensor

#### Scenario: Adequate and low map directly

- **WHEN** the Pod's water level interprets as adequate
- **THEN** the sensor reports the adequate state
- **WHEN** the Pod's water level interprets as low
- **THEN** the sensor reports the low state

#### Scenario: An unknown reading holds the previous state and raises a fault

- **WHEN** the Pod's water level interprets as unknown, and the sensor's last report was
  adequate
- **THEN** the sensor continues reporting the adequate state and additionally reports a fault,
  rather than switching to the low state

### Requirement: The water-level sensor's service type is configurable, defaulting to a contact sensor

The system SHALL accept a configuration value selecting between exactly two HomeKit service
types for the water-level sensor: a contact sensor and a leak sensor. The default SHALL be
the contact sensor. Selecting the leak sensor SHALL change only the service type the same
adequate/low/unknown derivation is published through; it SHALL NOT change the derivation
itself.

#### Scenario: The default is a contact sensor

- **WHEN** the water-level sensor's service-type configuration is omitted
- **THEN** the sensor is published as a contact sensor

#### Scenario: Configuring the leak sensor changes only the service type

- **WHEN** the water-level sensor's service-type configuration selects the leak sensor
- **THEN** the sensor is published as a leak sensor, and it reports the adequate, low, and
  unknown states using the identical derivation the contact-sensor form uses

### Requirement: A prime switch is published only when configured, and writing it on triggers a one-way prime

The hub accessory SHALL publish a switch controlling the Pod's priming cycle only when a
dedicated configuration value enables it; the default SHALL be disabled, and the switch SHALL
NOT exist on the hub accessory when disabled.

When enabled and written on, the switch SHALL cause a prime request to be sent to the Pod.
The switch's reported state SHALL reflect the Pod's own priming state as most recently
observed, becoming on once priming is observed to have started and off once it is observed to
have finished, independently of how promptly the write that triggered it is confirmed.

#### Scenario: Disabled by default

- **WHEN** the platform starts with no prime-switch configuration value set
- **THEN** the hub accessory carries no prime switch

#### Scenario: Enabling the switch publishes it

- **WHEN** the platform starts with the prime-switch configuration value enabled
- **THEN** the hub accessory carries a switch for priming

#### Scenario: Turning the switch on triggers a prime request

- **WHEN** the prime switch is enabled and is written on
- **THEN** a prime request is sent to the Pod

#### Scenario: The switch tracks the Pod's own priming state

- **WHEN** the Pod is observed to have started priming, and later observed to have finished
- **THEN** the switch reports on once the start is observed, and off once the finish is
  observed

### Requirement: Turning the prime switch off is refused, because the Pod has no way to stop a prime in progress

The system SHALL NOT send any request to the Pod as a result of the prime switch being
written off. The write SHALL be rejected with a status distinguishable from a failed-write
communication error, and the switch's reported state SHALL be corrected back to the Pod's
actual observed priming state shortly afterward.

#### Scenario: Writing the switch off sends no request

- **WHEN** the prime switch is written off, whether or not the Pod is currently priming
- **THEN** no request is sent to the Pod as a result of that write, and the write is rejected
  with a status distinct from a communication failure

#### Scenario: The tile is corrected back after a refused write

- **WHEN** the prime switch is written off and briefly reports off as a result of the write
  itself
- **THEN** its reported state is corrected back to the Pod's actual last-observed priming
  state shortly afterward, without a further characteristic write from any controller

### Requirement: An LED brightness lightbulb is published only when configured, and every write preserves the Pod's other device settings

The hub accessory SHALL publish a lightbulb controlling the Pod's LED, with an on/off state
and a brightness level, only when a dedicated configuration value enables it; the default
SHALL be disabled.

Every write that changes the LED's brightness or on/off state SHALL be sent to the Pod as
part of a complete device-settings object that also carries every other device setting the
Pod currently reports, so that no other device setting is ever altered as a side effect of an
LED write.

Turning the lightbulb on with no explicit brightness in the same write SHALL restore the
most recent nonzero brightness this plugin has itself written, defaulting to full brightness
if none has been written yet this accessory's lifetime. Turning the lightbulb off SHALL set
the brightness to zero.

#### Scenario: Disabled by default

- **WHEN** the platform starts with no LED configuration value set
- **THEN** the hub accessory carries no LED lightbulb

#### Scenario: A brightness write carries every other device setting unchanged

- **WHEN** the LED lightbulb is enabled and its brightness is written to a new value
- **THEN** the request sent to the Pod carries the new brightness together with every other
  device setting at its currently-observed value, none of them altered

#### Scenario: Turning on with no brightness restores the last nonzero value

- **WHEN** the lightbulb is off, was most recently set to a nonzero brightness by this
  plugin, and is then turned on without a brightness accompanying that write
- **THEN** the brightness sent to the Pod is that most recent nonzero value

#### Scenario: Turning on for the first time with no prior brightness defaults to full

- **WHEN** the lightbulb is turned on without an accompanying brightness, and this plugin has
  never itself written a nonzero brightness for it
- **THEN** the brightness sent to the Pod is full brightness

#### Scenario: Turning off zeroes the brightness

- **WHEN** the lightbulb is turned off
- **THEN** the brightness sent to the Pod is zero

### Requirement: A test-alarm switch is published only when configured, is momentary, and self-resets independently of the trigger's outcome

The hub accessory SHALL publish a momentary switch that manually triggers the Pod's alarm
vibration only when a dedicated configuration value enables it; the default SHALL be
disabled.

Writing the switch on SHALL send an immediate alarm trigger to the Pod, overriding the Pod's
own away-mode and power-state refusal so that the trigger fires regardless of either side's
current state. Approximately one second after being written on, the switch SHALL report off
again, regardless of whether the triggering request succeeded, failed, or is still
outstanding.

#### Scenario: Disabled by default

- **WHEN** the platform starts with no test-alarm configuration value set
- **THEN** the hub accessory carries no test-alarm switch

#### Scenario: Turning the switch on sends an overriding trigger

- **WHEN** the test-alarm switch is enabled and written on
- **THEN** an alarm trigger is sent to the Pod that is not refused by the addressed side being
  off or in away mode

#### Scenario: The switch self-resets on the same short timeline regardless of outcome

- **WHEN** the test-alarm switch is written on, and separately, on another occasion, the
  triggering request fails
- **THEN** in both cases the switch reports off again after approximately one second, with no
  characteristic write required to bring that about

### Requirement: A server-fault sensor is published only when configured, and reports the Pod's self-reported subsystem health

The hub accessory SHALL publish a sensor reporting whether the Pod's own reported internal
subsystem health shows a failure, only when a dedicated configuration value enables it; the
default SHALL be disabled.

The sensor SHALL report a fault-detected state when the most recently, successfully observed
subsystem health report contains at least one subsystem reporting a failed status, and SHALL
report no fault otherwise. The sensor SHALL additionally report a status fault when the
plugin's own attempt to observe subsystem health is currently failing, distinct from — and
without altering — its most recently observed fault-detected state.

#### Scenario: Disabled by default

- **WHEN** the platform starts with no server-fault configuration value set
- **THEN** the hub accessory carries no server-fault sensor

#### Scenario: A failed subsystem is reported

- **WHEN** the most recently observed subsystem health report contains a subsystem with a
  failed status
- **THEN** the sensor reports the fault-detected state

#### Scenario: A healthy report clears the fault-detected state

- **WHEN** the most recently observed subsystem health report contains no subsystem with a
  failed status
- **THEN** the sensor reports no fault detected

#### Scenario: A failing observation of subsystem health is distinguished from a failing subsystem

- **WHEN** the plugin's own attempt to observe subsystem health is currently failing, and the
  last successfully observed report showed no subsystem failure
- **THEN** the sensor continues reporting no fault detected while additionally reporting a
  status fault, rather than reporting a fault-detected state it has no evidence for
