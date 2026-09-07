## Context (delta rationale, not part of the synced spec)

`pod-poller`'s existing "One shared poll per endpoint class serves every reader" requirement
already commits to the endpoint-class set being "extensible by describing a new class... without
altering the scheduling, jitter, backoff, or in-flight machinery," and its `enabled` extension
point was built, unused, specifically naming this change. This delta adds the first two
consumers of that extension point rather than modifying the mechanism itself — no existing
requirement's text changes; this file only adds new ones.

## ADDED Requirements

### Requirement: Presence and vitals are polled only for the configured occupancy source, and only once biometrics is confirmed enabled

The poller SHALL support a presence endpoint class, polled at approximately 30 seconds, and a
vitals endpoint class, polled at approximately 60 seconds. Each SHALL be enabled only while
both of the following hold: the configured occupancy source names that class's endpoint, and
the most recently observed services document reports biometrics as enabled. Before any services
document has been observed, biometrics SHALL be treated as not enabled.

Neither class SHALL be polled when the configured occupancy source names neither of them, or
names the other one.

#### Scenario: Neither class polls when occupancy is off

- **WHEN** the occupancy source is configured as none
- **THEN** neither the presence class nor the vitals class ever issues a request

#### Scenario: Only the configured source's class polls

- **WHEN** the occupancy source is configured as presence, and biometrics is confirmed enabled
- **THEN** the presence class polls on its own schedule and the vitals class never polls

#### Scenario: Biometrics must be confirmed, not merely unknown

- **WHEN** the occupancy source names a class, and no services document has yet been
  successfully observed
- **THEN** that class does not poll, until a services observation confirms biometrics enabled

#### Scenario: Biometrics turning off stops polling and turning it back on resumes it

- **WHEN** a previously-enabled class's occupancy source is unchanged, and a later services
  observation reports biometrics no longer enabled, and a still later one reports it enabled
  again
- **THEN** the class stops polling after the first change and resumes polling on its own
  schedule after the second, with no restart required

### Requirement: The vitals poll requests a single, fixed, recent window covering both sides

Each poll of the vitals class SHALL request a bounded, recent time window ending at the time of
the request, without restricting the request to one side, so that one request serves the
occupancy computation for both sides.

#### Scenario: One request serves both sides

- **WHEN** the vitals class polls
- **THEN** exactly one request is made, and its response is used to derive both sides' vitals-
  based occupancy

#### Scenario: The requested window is bounded and recent

- **WHEN** the vitals class's request is inspected
- **THEN** it requests a window ending at the time of the request and extending back a fixed,
  short duration, not an unbounded history
