## Purpose

How the plugin behaves while the Pod is not answering — which is a routine, daily,
several-minute state rather than an error. It defines the connection sensor the outage is
exposed through, the rule that reads keep serving last-known values instead of latching HomeKit
into "No Response", the one case where a failure is surfaced to the user, and the bounded
escalation for an outage that stops being routine.

## ADDED Requirements

### Requirement: The hub publishes a Pod Connection contact sensor

The hub accessory SHALL publish a contact sensor named "Pod Connection" that reports the
plugin's view of whether the Pod is reachable, so that an outage is available as data a user can
build a notification or an automation on rather than only as an absence of response.

The sensor SHALL report contact detected while the Pod is reachable and contact not detected
while it is not. It SHALL be published whenever the platform starts with a configured host,
independently of which sides are enabled.

#### Scenario: The sensor exists on the hub

- **WHEN** the platform starts with a configured host
- **THEN** the hub accessory carries exactly one contact sensor named "Pod Connection", and
  neither side accessory carries one

#### Scenario: The sensor follows reachability

- **WHEN** the Pod is reachable
- **THEN** the sensor reports contact detected
- **WHEN** the Pod stops answering
- **THEN** the sensor reports contact not detected

### Requirement: The sensor changes state only when reachability changes

The connection sensor SHALL be updated only on a transition. A run of consecutive failed
observations SHALL produce exactly one transition to unreachable, and the first subsequent
success SHALL produce exactly one transition back — regardless of how many observations, retries
or backoff steps occurred in between.

An outage that produces a burst of state changes is worse than no sensor at all: every change
is a push notification on every phone in the household.

#### Scenario: A restart flips the sensor exactly twice

- **WHEN** the Pod stops answering, stays unreachable across several polling attempts, and then
  starts answering again
- **THEN** the sensor's reported value changed exactly twice over the whole outage

#### Scenario: A continuing outage is silent

- **WHEN** the Pod remains unreachable for an extended period
- **THEN** no further update is pushed for the sensor after the initial transition

### Requirement: Status characteristics are carried only by services that declare them

The connection sensor SHALL additionally carry a fault status and an active status: the fault
status SHALL report a fault while the Pod is unreachable and no fault otherwise, and the active
status SHALL report inactive until the plugin has observed the Pod successfully at least once.

These status characteristics SHALL be added only to services whose HomeKit definition declares
them. They SHALL NOT be added to the thermostat, which does not.

#### Scenario: The sensor reports a fault while unreachable

- **WHEN** the Pod is unreachable
- **THEN** the connection sensor's fault status reports a fault, and it reports no fault once
  the Pod answers again

#### Scenario: The sensor is inactive before the first success

- **WHEN** the plugin has started and no observation of the Pod has yet succeeded
- **THEN** the connection sensor's active status reports inactive, and it reports active from
  the first successful observation onwards

#### Scenario: The thermostat carries no status characteristics

- **WHEN** a thermostat service's characteristics are enumerated
- **THEN** it carries neither a fault status nor an active status

### Requirement: A read never fails while any observation exists

While the plugin holds any successfully observed state, no read handler SHALL fail, whatever the
Pod's current reachability, unless the escalation period defined below has elapsed. Reads SHALL
serve last-known values.

Reporting a read failure is the only mechanism that surfaces "No Response" in the Home app, and
doing so for a transient failure produces an extended No Response state that commonly persists
until the user force-quits the app. Reporting the failure by attaching an error to a
characteristic's published value instead of failing the read is not an alternative: for a
plugin that serves values from read handlers it has no observable effect, because the value is
recorded but no event is emitted and no controller is notified, and the next successful read
clears the recorded status. The Pod reboots daily and is unreachable for minutes at a time as
routine behaviour.

#### Scenario: Reads keep working through an outage

- **WHEN** the Pod becomes unreachable, for a period shorter than the escalation period, and
  every characteristic of every published service is read
- **THEN** every read returns the last-known value and none of them fails

#### Scenario: An outage is not treated as a defect

- **WHEN** the Pod becomes unreachable
- **THEN** the plugin logs the outage at a diagnostic level rather than as an error, and no
  accessory is unregistered, re-registered or otherwise disturbed

### Requirement: Before any observation succeeds, reads serve the last published value

When the plugin has never successfully observed the Pod — the first poll of a launch has failed,
or has not yet completed — read handlers SHALL serve the value the characteristic already holds,
which HomeKit persists across plugin restarts, rather than failing or fabricating a default.

#### Scenario: A restart against an unreachable Pod serves persisted values

- **WHEN** the plugin restarts while the Pod is unreachable and the accessories are restored
  from HomeKit's cache
- **THEN** every read returns the value that characteristic held before the restart, and no read
  fails

#### Scenario: A first-ever launch against an unreachable Pod still answers

- **WHEN** the plugin launches for the first time, no observation succeeds, and a read occurs
- **THEN** the read returns the characteristic's default value rather than failing

### Requirement: A write that does not reach the Pod is reported as a communication failure

A write handler SHALL fail with a service-communication failure when the write it submitted did
not reach the Pod. A failed write is a real, user-initiated action that visibly did not happen,
so silently absorbing it would leave the user believing the bed changed when it did not.

Unlike a read failure this does not latch, because the next successful read clears the recorded
status.

#### Scenario: A write during an outage fails visibly

- **WHEN** the Pod is unreachable and a controller writes a mode or a target temperature
- **THEN** the write fails with a service-communication failure

#### Scenario: The failure does not latch

- **WHEN** a write has failed and the Pod then becomes reachable again
- **THEN** subsequent reads succeed and the accessory is not left in a No Response state

#### Scenario: A rejected payload also fails the write

- **WHEN** the Pod is reachable but rejects the dispatched body
- **THEN** the write fails with a service-communication failure and the reported value reverts
  to the last observed one

### Requirement: Reads escalate to failing only after a configured continuous outage

When the Pod has been continuously unreachable for longer than a configured escalation period,
read handlers SHALL begin failing with a service-communication failure, so that a genuinely
dead Pod is eventually shown as unavailable rather than as a stale but plausible reading. The
escalation SHALL clear on the first successful observation.

The escalation period SHALL be the `noResponseAfterMs` configuration value, defaulting to ten
minutes. A configured value of zero SHALL disable escalation entirely, so reads never fail.

When the plugin has never successfully observed the Pod, the escalation period SHALL be measured
from the start of the current launch.

#### Scenario: Inside the escalation period reads still succeed

- **WHEN** the Pod has been unreachable for less than the escalation period
- **THEN** reads return last-known values and do not fail

#### Scenario: Past the escalation period reads fail

- **WHEN** the Pod has been continuously unreachable for longer than the escalation period
- **THEN** reads fail with a service-communication failure

#### Scenario: The first success clears the escalation

- **WHEN** reads have begun failing and an observation then succeeds
- **THEN** the very next read succeeds and returns the newly observed value

#### Scenario: Zero disables escalation

- **WHEN** the escalation period is configured as zero and the Pod is unreachable for hours
- **THEN** reads continue to return last-known values and never fail

#### Scenario: A brief outage never escalates

- **WHEN** the Pod is unreachable for a period shorter than the escalation period and then
  answers again
- **THEN** no read failed at any point during the outage
