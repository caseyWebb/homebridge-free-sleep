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

#### Scenario: An unconfirmed prime-on write self-corrects within a bounded interval (S3, PR #44 review)

- **WHEN** the prime switch is written on, and no subsequent observation within a bounded
  interval after that write settles shows the Pod actually priming
- **THEN** the switch's reported state is corrected back to off within that bounded interval,
  without a further characteristic write from any controller
- **WHEN** instead a subsequent observation within that same bounded interval does show the
  Pod actually priming
- **THEN** the switch's reported state remains on

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
most recent nonzero brightness observed for it — whether that value was most recently set by
this plugin's own write or observed to have been changed some other way (**revised, N3, PR #44
review** — originally only a value this plugin had itself written; a value changed externally,
e.g. through free-sleep's own web UI, and then turned off through this plugin, was not
restored) — defaulting to full brightness if no nonzero brightness has ever been observed this
accessory's lifetime. Turning the lightbulb off SHALL set the brightness to zero.

The external, currently-observed value used above and by the "every other device setting"
guarantee above it SHALL be as freshly observed as a bounded pre-dispatch refresh can make it,
per `pod-write-queue`'s own added requirement (S4, PR #44 review) — not necessarily the value
that was current when the write was first made, since the two can differ by however long the
write sat in its own debounce window.

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

#### Scenario: An externally-changed brightness survives an off/on cycle through this plugin (N3, PR #44 review)

- **WHEN** the lightbulb's brightness is changed to a nonzero value by something other than
  this plugin, is then turned off through this plugin, and is then turned on again without a
  brightness accompanying that write
- **THEN** the brightness sent to the Pod is the externally-set value observed just before the
  off-write, not a value this plugin had itself previously written (or the full-brightness
  default, if this plugin had never itself written a nonzero brightness before)

#### Scenario: Turning on for the first time with no prior brightness defaults to full

- **WHEN** the lightbulb is turned on without an accompanying brightness, and this plugin has
  never itself written a nonzero brightness for it
- **THEN** the brightness sent to the Pod is full brightness

#### Scenario: Turning off zeroes the brightness

- **WHEN** the lightbulb is turned off
- **THEN** the brightness sent to the Pod is zero

### Requirement: Two per-side test-alarm switches are published only when configured, are momentary, and each self-resets independently of its own trigger's outcome

**Revised (G0, tech-lead ruling, PR #44 review):** the hub accessory SHALL publish two
independent momentary switches, one per side, that each manually trigger the Pod's alarm
vibration for that side only, when a single dedicated configuration value enables them; the
default SHALL be disabled for both. (A single both-sides switch was rejected: a hub-level
trigger firing on both sides risks vibrating a sleeping partner's side as a side effect of
testing the other — a config toggle cannot mitigate that risk, only removing the both-sides
behavior can.)

Writing either switch on SHALL send an immediate alarm trigger to the Pod for that switch's own
side only, overriding the Pod's own away-mode and power-state refusal so that the trigger fires
regardless of that side's current state, and SHALL NOT trigger the other side. Approximately one
second after being written on, that switch SHALL report off again, regardless of whether the
triggering request succeeded, failed, or is still outstanding; the other side's switch is
unaffected.

#### Scenario: Disabled by default

- **WHEN** the platform starts with no test-alarm configuration value set
- **THEN** the hub accessory carries neither test-alarm switch

#### Scenario: Turning one side's switch on sends an overriding trigger to that side only

- **WHEN** the test-alarm switches are enabled and one side's switch is written on
- **THEN** an alarm trigger is sent to the Pod for that side only, not refused by that side
  being off or in away mode, and no trigger is sent for the other side

#### Scenario: Each switch self-resets on the same short timeline regardless of outcome

- **WHEN** a side's test-alarm switch is written on, and separately, on another occasion, the
  triggering request fails
- **THEN** in both cases that switch reports off again after approximately one second, with no
  characteristic write required to bring that about, and the other side's switch is unaffected
  either way

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

#### Scenario: A reachability transition promptly updates the sensor's status characteristics (S1, PR #44 review)

- **WHEN** the plugin's attempt to observe subsystem health transitions from succeeding to
  failing, or from failing to succeeding
- **THEN** the sensor's status-fault and status-active characteristics are pushed promptly to
  reflect that transition, not merely the next time some other field of this sensor happens to
  change
