## Context (delta rationale, not part of the synced spec)

Extends the mock and its fixtures to two more endpoints, following exactly the existing shape
this capability already commits to reusing without modification: fixture-seeded state, test-
overridable, resettable, and — since these are read-only endpoints with no plugin write policy
to keep out of the mock's own logic — no new write-semantics requirement is needed here. The
existing "mock rejects unknown properties," "records every request," and "can inject faults"
requirements already apply generically to any endpoint the mock serves and need no
endpoint-specific restatement.

## ADDED Requirements

### Requirement: Fixtures exist for the presence and vitals endpoints

The test suite SHALL include a fixture for the presence endpoint and a fixture for the vitals
endpoint, in addition to the four already required. Each SHALL be stored at the exact path the
documented capture command writes to. Both SHALL be real captures, not synthetic, and SHALL be
recorded as such in the fixture provenance documentation alongside the date, source Pod
generation, and free-sleep version they were captured from.

#### Scenario: Both new endpoints are covered

- **WHEN** the fixture directory is listed
- **THEN** it contains a presence fixture and a vitals fixture, each named to match the capture
  command documented for it

#### Scenario: Provenance records them as real captures

- **WHEN** the fixture provenance documentation is read
- **THEN** both new fixtures are marked as captured, not synthetic, with their capture date and
  source Pod generation and free-sleep version recorded

### Requirement: The vitals fixture and the mock preserve the wire's field names and row order

Neither the vitals fixture nor the mock's serving of it SHALL relabel a field name or reorder
rows into a canonical sort the real endpoint does not itself guarantee at capture time. A test
asserting against this fixture SHALL NOT assume a particular side appears first.

#### Scenario: Field names match the wire exactly

- **WHEN** the vitals fixture is inspected
- **THEN** its numeric field names are exactly `heart_rate`, `hrv`, and `breathing_rate`, not a
  relabeled camelCase equivalent

### Requirement: The mock serves presence and vitals state seeded from their fixtures

The mock SHALL initialise its presence and vitals state from their committed fixtures, exactly
as it already does for the four existing documents. Tests SHALL be able to override either
seed state and to reset both to their seeded values between tests.

#### Scenario: Default reads match the fixtures

- **WHEN** a freshly started mock's presence or vitals endpoint is read without any prior state
  override
- **THEN** the response equals that endpoint's fixture

#### Scenario: Tests can seed a specific presence or vitals state

- **WHEN** a test starts the mock with an overridden presence state (for example, a side
  reported present) or an overridden set of vitals rows (for example, a fresh or a stale
  reading)
- **THEN** reads reflect the overridden state

#### Scenario: Reset restores the seed for both new endpoints

- **WHEN** a test resets the mock after overriding presence or vitals state
- **THEN** subsequent reads of both endpoints return their originally seeded fixtures

### Requirement: The mock filters vitals reads the way the real endpoint does

The mock's vitals endpoint SHALL support the same optional side and time-range query parameters
the real endpoint accepts, and SHALL apply them with the same semantics: an exact match on side
when given, and inclusion only of rows whose timestamp falls within the given start and end
bounds when either is given. Omitting all filters SHALL return every seeded row for both sides.

#### Scenario: A side filter returns only that side's rows

- **WHEN** a vitals read specifies a side
- **THEN** only rows for that side are returned

#### Scenario: A time-range filter excludes rows outside it

- **WHEN** a vitals read specifies a start time, an end time, or both
- **THEN** only rows whose timestamp falls within the given bounds are returned

#### Scenario: No filters returns everything seeded

- **WHEN** a vitals read specifies no side and no time range
- **THEN** every seeded row for both sides is returned
