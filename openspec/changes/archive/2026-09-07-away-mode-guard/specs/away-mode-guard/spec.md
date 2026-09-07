## Purpose

Prevents a HomeKit write addressed to one side from silently changing the other side's
hardware, undetected, whenever the Pod's own away-mode coupling is active — and defines the one
shared checkpoint every side-write originator in the plugin routes through so that guarantee
holds regardless of which feature initiated the write.

## ADDED Requirements

### Requirement: Every side write is checked against both sides' away-mode state before it reaches the Pod

Before a write addressed to one side is dispatched, the system SHALL determine whether either
side currently has away mode enabled, using the freshest away-mode knowledge available without
issuing a request dedicated solely to that check. When neither side is in away mode, the write
SHALL proceed exactly as submitted, with no additional request and no change to the cached view
beyond what the write itself produces.

This check SHALL apply uniformly to every feature that originates a side write — not solely the
per-side thermostat — so that a later write originator (for example, a keep-alive mechanism)
gains the same protection by routing through the same checkpoint, without that checkpoint being
reimplemented per feature.

#### Scenario: Neither side away leaves a write untouched

- **WHEN** a side write is submitted and neither side's cached settings report away mode enabled
- **THEN** the write is dispatched exactly as submitted, and no extra request is made

#### Scenario: A second write originator gains the same protection

- **WHEN** a feature other than the thermostat submits a side write while one side is in away
  mode
- **THEN** the same policy (block or mirror) that governs a thermostat-originated write governs
  this write too

### Requirement: The configured policy governs a write attempted while either side is in away mode

When either side is in away mode, the system SHALL apply exactly one of two configured policies
to a write addressed to either side:

- **`block`**: the write SHALL NOT be dispatched to the Pod. The submitter SHALL receive a
  rejection that identifies the cause as the away-mode policy, distinguishable from a rejection
  caused by a failed or unreachable Pod. The cached view SHALL NOT change as a result of the
  refused write.
- **`mirror`**: the write SHALL be dispatched exactly as submitted. In addition, the system
  SHALL reflect the write's user-visible fields on the other side's cached view as well, so that
  the cached view (and anything reading it) shows both sides changing together — matching the
  Pod's own physical both-sides effect — rather than reporting only the addressed side as
  changed until a later poll happens to catch up.

#### Scenario: A blocked write never reaches the Pod

- **WHEN** the policy is `block`, the left side is in away mode, and a write is submitted for
  the right side
- **THEN** the Pod receives no request for this write, the submitter's request is rejected with
  a cause identifying the away-mode policy, and the cached view for both sides is unchanged

#### Scenario: A mirrored write updates both sides' cached view

- **WHEN** the policy is `mirror`, the left side is in away mode, and a write setting the right
  side's target temperature is submitted
- **THEN** the Pod receives the write addressed to the right side, and the cached view reports
  the same target temperature for the left side as well, without waiting for a poll

#### Scenario: Either side being away is sufficient to trigger the policy

- **WHEN** only the side being written to is in away mode, or only the other side is, or both
  are
- **THEN** the configured policy is applied in every one of these three cases identically

### Requirement: The away-mode check and the resulting dispatch cannot be reordered against another in-flight write

The determination of which policy applies, and the decision it produces, SHALL be made without
another write this plugin issues being able to land in between — so that a concurrent away-mode
toggle this plugin itself is writing cannot cause the check to observe a state that a write
already accepted for dispatch will contradict by the time it lands.

#### Scenario: A concurrent away-mode toggle does not race the check

- **WHEN** a write toggling away mode on is submitted at nearly the same moment as a side write
  to the other side
- **THEN** the side write is evaluated against a single, consistent view of away-mode state —
  either as it was before the toggle's effect became visible, or as it was after, never a state
  that the toggle's own dispatch could still invalidate

### Requirement: Away-mode knowledge can be stale relative to a change made outside the plugin, and this is bounded, not eliminated

Away-mode state observed only through this plugin's own polling and its own writes SHALL be
treated as authoritative at decision time. The system SHALL NOT guarantee detection of an
away-mode change made through any path other than this plugin (for example, directly against
free-sleep's own web interface) any sooner than that change is next observed by the plugin's
ordinary settings polling.

#### Scenario: An externally-made away-mode change is caught on the next observation, not sooner

- **WHEN** away mode is enabled through a path other than this plugin, and a side write is
  submitted before the next settings observation reflects that change
- **THEN** the write is evaluated against the away-mode state last known to the plugin, which may
  not yet reflect the external change
