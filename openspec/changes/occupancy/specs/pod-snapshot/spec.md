## Context (delta rationale, not part of the synced spec)

The snapshot stays policy-free about *which* occupancy source is configured — that decision
lives in the service layer, per this project's established boundary (`pod-snapshot`'s Purpose:
"It reports; policy belongs to the accessory layer," already stated for connection state and
extended here to occupancy). This delta only adds new observed data, new watched fields, and
the proof-of-life bookkeeping needed to make each source's trustworthiness signal correct; it
does not modify any existing requirement's text.

## ADDED Requirements

### Requirement: Presence and vitals observations are stored per side, unconditionally

The snapshot SHALL accept an observation of the presence endpoint's full response and, per
side, expose the most recently observed presence flag. It SHALL accept an observation of the
vitals endpoint's response for a time window and, per side, expose whether that window
contained a row with a non-null heart rate. Both SHALL read as unknown until their own first
observation, following the same "unknown until first success" rule already established for
every other observed document.

#### Scenario: Unobserved presence and vitals read as unknown

- **WHEN** the snapshot is read before either endpoint has ever been observed
- **THEN** both sides' presence flag and vitals-derived occupancy read as unknown

#### Scenario: An observation updates both sides at once

- **WHEN** a presence observation reports both sides' current flags
- **THEN** both sides' presence flags update from that single observation

### Requirement: A side's presence trust flag requires an observed change from this launch's baseline

The snapshot SHALL record, per side, the `lastUpdatedAt` value from its first-ever presence
observation this launch as that side's baseline. The side's presence trust flag SHALL become
true the first time a later observation reports a `lastUpdatedAt` different from that baseline,
and SHALL remain true afterward regardless of what any subsequent observation reports.

#### Scenario: The baseline alone does not set the trust flag

- **WHEN** a side has been observed only reporting the same `lastUpdatedAt` as its first
  observation this launch, however many times
- **THEN** that side's presence trust flag is false

#### Scenario: A differing observation sets the trust flag, permanently

- **WHEN** a side's observed `lastUpdatedAt` differs from its baseline at least once
- **THEN** that side's presence trust flag becomes true, and a later observation matching the
  original baseline does not clear it

### Requirement: A side's vitals trust flag requires only one ever-successful observation with a row

The snapshot SHALL record, per side, whether any vitals observation has ever included at least
one row for that side. The side's vitals trust flag SHALL become true the first time this
occurs and SHALL remain true afterward, regardless of how many later observations include no
row for that side.

#### Scenario: The first row sets the trust flag immediately

- **WHEN** a vitals observation includes at least one row for a side, for the first time
- **THEN** that side's vitals trust flag becomes true immediately — no second observation is
  required

#### Scenario: A later empty observation does not clear the trust flag

- **WHEN** a side's vitals trust flag is already true, and a later observation includes no row
  for that side
- **THEN** the trust flag remains true

### Requirement: Presence and vitals data and their trust flags are watched fields

A change to a side's observed presence flag, its presence trust flag, its vitals-derived
occupancy, or its vitals trust flag SHALL each be a watched field: a commit that changes any of
them SHALL produce a change notification carrying that field, exactly like every other watched
field.

#### Scenario: A presence flag change is notified

- **WHEN** a side's observed presence flag changes between two observations
- **THEN** subscribers receive a change notification naming that field, that side, the previous
  value, and the new value

#### Scenario: A trust flag becoming true is notified

- **WHEN** a side's presence or vitals trust flag transitions from false (or unknown) to true
- **THEN** subscribers receive a change notification for that transition

#### Scenario: An unrelated document change produces no occupancy notification

- **WHEN** a commit changes only fields unrelated to presence or vitals
- **THEN** no change notification naming a presence or vitals field is produced
