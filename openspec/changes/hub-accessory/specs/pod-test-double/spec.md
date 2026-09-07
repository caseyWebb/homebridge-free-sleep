## Context (delta rationale, not part of the synced spec)

This change adds two Pod endpoints this plugin has never called before (an alarm trigger and
subsystem health) and one write field to an endpoint the mock already reproduces (a priming
trigger on the device-status endpoint). The mock is this project's executable specification for
every write path (`test/mockPod.ts`'s own doc comment); both new endpoints and the new field
need mock coverage before any service built on them can be tested without live hardware.

## MODIFIED Requirements

### Requirement: Fixtures exist for every endpoint the plugin reads

The test suite SHALL include a fixture for each of the five Pod endpoints the plugin reads:
device status, settings, schedules, services, and subsystem health. Each fixture SHALL be
stored at the exact path the documented capture command writes to, so replacing a synthetic
fixture with a real capture is a plain overwrite with no code change.

Fixtures SHALL contain no identifying information — no serial numbers, account identifiers,
household names, or network addresses.

#### Scenario: All four endpoints are covered

- **WHEN** the fixture directory is listed
- **THEN** it contains a device status, settings, schedules, and services fixture, each named
  to match the capture command documented for it

#### Scenario: The subsystem-health endpoint is also covered

- **WHEN** the fixture directory is listed
- **THEN** it also contains a subsystem-health fixture, named to match the capture command
  documented for it

#### Scenario: Fixtures are scrubbed

- **WHEN** a fixture is inspected
- **THEN** it contains no serial number, account or household identifier, personal name, or
  IP address

### Requirement: Every fixture parses through the vendored wire types

An automated test SHALL parse every fixture through the vendored wire contract for its
endpoint and fail if any fixture does not conform, including the subsystem-health fixture
against its own vendored contract. This test SHALL run as part of the normal test suite, with
no Pod and no network available.

#### Scenario: A malformed fixture fails the suite

- **WHEN** a fixture is edited to violate the vendored contract for its endpoint
- **THEN** the test suite fails and names the fixture and the offending property

#### Scenario: The check runs offline

- **WHEN** the suite is run with no network access and no Pod on the LAN
- **THEN** the fixture-parsing test still runs and passes

#### Scenario: The default subsystem-health fixture reports no failure

- **WHEN** the default subsystem-health fixture is parsed
- **THEN** every subsystem in it reports a status other than failed, so that tests which do
  not deliberately exercise the server-fault sensor see no fault by default

## ADDED Requirements

### Requirement: The mock reproduces the alarm-trigger endpoint's override and non-idempotent behavior

The mock SHALL accept an alarm-trigger request and, when the request carries the override
flag, SHALL apply the trigger regardless of the addressed side's current power or away-mode
state — reproducing the real Pod's own override behavior rather than an idealized one that
always succeeds. The mock SHALL record the trigger as a distinct command, mirroring how it
already records every other hardware command upstream's write handler issues.

#### Scenario: An overriding trigger is recorded even for an off, away side

- **WHEN** an alarm trigger with the override flag set is submitted for a side that is off
  and in away mode
- **THEN** the mock records the trigger command as having been issued

#### Scenario: The mock's alarm endpoint is a known, routable endpoint

- **WHEN** a test injects a fault targeting the alarm-trigger endpoint
- **THEN** the fault is accepted as targeting a real, recognized endpoint rather than being
  silently ignored

### Requirement: The mock serves subsystem health and allows a test to inject a failed subsystem

The mock SHALL serve a subsystem-health document seeded from a fixture, and SHALL allow a
test to override that document wholesale at startup, mirroring the existing whole-document
override convention already used for the services and schedules documents.

#### Scenario: The default subsystem-health response reports no failure

- **WHEN** a subsystem-health read is made against a freshly started mock with no override
- **THEN** the response reports every subsystem as not failed

#### Scenario: A test can inject a failed subsystem

- **WHEN** the mock is started with a subsystem-health override containing one subsystem
  reporting a failed status
- **THEN** a subsystem-health read against that mock returns that failed subsystem

### Requirement: The mock reproduces the priming-trigger field's write semantics, including its no-op-when-false behavior

The mock's device-status write handling SHALL start a prime when the priming-trigger field is
present and true, mirroring upstream's own command. When the priming-trigger field is present
and false, the mock SHALL treat the write as a no-op with respect to priming — reproducing
upstream's own absence of a stop command — rather than inventing a cancellation behavior the
real Pod does not have.

#### Scenario: A true priming-trigger field starts a prime

- **WHEN** a device-status write sets the priming-trigger field to true
- **THEN** the mock records the priming command as having been issued

#### Scenario: A false priming-trigger field changes nothing

- **WHEN** a device-status write sets the priming-trigger field to false
- **THEN** the mock does not stop an in-progress prime, and records no priming-related command
  as a result of that field
