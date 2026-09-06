# pod-test-double Specification

## Purpose

The offline stand-in for real Pod hardware: recorded API fixtures with auditable provenance,
and a stateful mock Pod that reproduces free-sleep's actual — and frequently surprising —
write semantics rather than an idealised API. It is the executable specification the client
and every later feature (write coalescing, keep-alive, away-mode guard) are tested against.

## Requirements

### Requirement: Fixtures exist for every endpoint the plugin reads

The test suite SHALL include a fixture for each of the four Pod endpoints the plugin reads:
device status, settings, schedules, and services. Each fixture SHALL be stored at the exact
path the documented capture command writes to, so replacing a synthetic fixture with a real
capture is a plain overwrite with no code change.

Fixtures SHALL contain no identifying information — no serial numbers, account identifiers,
household names, or network addresses.

#### Scenario: All four endpoints are covered

- **WHEN** the fixture directory is listed
- **THEN** it contains a device status, settings, schedules, and services fixture, each named
  to match the capture command documented for it

#### Scenario: Fixtures are scrubbed

- **WHEN** a fixture is inspected
- **THEN** it contains no serial number, account or household identifier, personal name, or
  IP address

### Requirement: Fixture provenance is recorded and honest about being synthetic

The fixture directory SHALL carry documentation stating, for every fixture: whether it was
captured from real hardware or generated synthetically; the upstream free-sleep version,
commit and source file it was derived from when synthetic; the date; and what behaviour it
exists to exercise.

A synthetic fixture SHALL NOT be described as a capture.

#### Scenario: A reader can tell synthetic from captured

- **WHEN** someone reads the fixture documentation
- **THEN** each fixture is marked either captured or synthetic, and every synthetic one names
  the upstream version, commit, and source file it was derived from

#### Scenario: Swapping in a real capture is documented

- **WHEN** a real Pod becomes reachable
- **THEN** the documentation states the exact commands to capture each fixture, what to
  scrub, and which tests to re-run to confirm the swap

### Requirement: Every fixture parses through the vendored wire types

An automated test SHALL parse every fixture through the vendored wire contract for its
endpoint and fail if any fixture does not conform. This test SHALL run as part of the normal
test suite, with no Pod and no network available.

#### Scenario: A malformed fixture fails the suite

- **WHEN** a fixture is edited to violate the vendored contract for its endpoint
- **THEN** the test suite fails and names the fixture and the offending property

#### Scenario: The check runs offline

- **WHEN** the suite is run with no network access and no Pod on the LAN
- **THEN** the fixture-parsing test still runs and passes

### Requirement: Fixtures cover the water-level and power edge cases

In addition to a nominal device-status fixture, the suite SHALL include device-status
fixtures covering: both sides off, a low water level, and an unrecognised water-level string.
These variants are permanently synthetic and SHALL be marked as such.

#### Scenario: Edge-case fixtures exist and are exercised

- **WHEN** the water-level interpretation and power-state derivation are tested
- **THEN** they are tested against fixtures representing an adequate level, a low level, an
  unrecognised level, and both sides powered off

### Requirement: The device-status fixture asserts the absence of gesture tap counters

Reading free-sleep's source indicates gesture tap counters are never included in the HTTP
device-status response. The suite SHALL assert this absence against the device-status
fixture, so that a real capture containing them fails the suite loudly rather than passing
unnoticed.

#### Scenario: Tap counters absent, as expected

- **WHEN** the device-status fixture is checked
- **THEN** it has no gesture tap counters and the assertion passes

#### Scenario: A real capture containing tap counters fails loudly

- **WHEN** a real capture that does contain gesture tap counters replaces the fixture
- **THEN** the suite fails with a message stating that the assumption has been invalidated
  and pointing at the tracked issue for tap-driven features

### Requirement: The mock Pod is a real HTTP server addressable by URL

The mock SHALL listen on a real local HTTP port and expose its base URL, so that a client
under test reaches it through actual sockets and real HTTP semantics — including connection
failures, aborted requests, and timeouts. Tests SHALL be able to start it on an
automatically-chosen free port, and stop it completely so no handle keeps the test process
alive.

#### Scenario: Client reaches the mock over HTTP

- **WHEN** a test starts the mock and points a client at its base URL
- **THEN** the client's requests are served over HTTP without any interception or patching of
  the runtime's networking

#### Scenario: Parallel tests do not collide

- **WHEN** several tests each start their own mock at the same time
- **THEN** each gets a distinct port and its own independent state

#### Scenario: Shutdown releases everything

- **WHEN** a test stops the mock
- **THEN** the port is released, in-flight connections are closed, and the test process exits
  without an open-handle warning

### Requirement: The mock serves state seeded from the fixtures

The mock SHALL initialise its state from the committed fixtures, so that the data it serves
and the data the wire types are tested against never diverge, and so that replacing synthetic
fixtures with real captures automatically re-runs every mock-based test against real data.

Tests SHALL be able to override the seed state and to reset it between tests.

#### Scenario: Default reads match the fixtures

- **WHEN** a freshly started mock is read without any prior writes
- **THEN** each endpoint returns data equal to its fixture

#### Scenario: Tests can seed a specific starting state

- **WHEN** a test starts the mock with an overridden starting state — for example a side
  already powered off, or a side in away mode
- **THEN** reads reflect that state

#### Scenario: Reset restores the seed

- **WHEN** a test performs writes and then resets the mock
- **THEN** subsequent reads return the seeded state and the recorded request log is empty

### Requirement: The mock rejects unknown properties with 400

The mock SHALL validate every write body against the strict contract the Pod enforces, and
respond `400` with a body describing the offending property when the body contains an unknown
property or a value of the wrong type or out of range. It SHALL NOT silently ignore unknown
properties.

#### Scenario: Unknown property is rejected

- **WHEN** a device-status write contains a property the strict contract does not define
- **THEN** the mock responds 400 with detail identifying that property, and no state changes

#### Scenario: Out-of-range temperature is rejected

- **WHEN** a device-status write sets a target temperature outside 55–110 °F
- **THEN** the mock responds 400 and no state changes

#### Scenario: A valid write returns no content

- **WHEN** a valid device-status write is accepted
- **THEN** the mock responds 204 with an empty body

### Requirement: The mock reproduces the zero-duration silent no-op

A device-status write setting seconds-remaining to `0` SHALL be silently ignored by the mock:
it SHALL respond as a success, change no state, and in particular SHALL NOT power a side off.
Only an explicit power-off SHALL turn a side off.

#### Scenario: Zero duration does not turn a side off

- **WHEN** a side is on with time remaining and a write sets its seconds-remaining to 0
- **THEN** the response is a success, the side is still on, and its remaining time is
  unchanged

#### Scenario: Explicit power-off does turn a side off

- **WHEN** a write sets a side's power field to off
- **THEN** the side's remaining time becomes 0 and subsequent reads report it off

#### Scenario: A non-zero duration is applied

- **WHEN** a write sets a side's seconds-remaining to a positive value
- **THEN** the side's remaining time becomes that value

### Requirement: The mock reproduces the twelve-hour power-on duration and derived power state

A device-status write powering a side on SHALL set that side's remaining time to 43200
seconds. Reads SHALL NOT report a stored power flag; the reported power state SHALL be
derived as remaining time greater than zero.

#### Scenario: Powering on sets a twelve-hour duration

- **WHEN** a write powers a side on
- **THEN** a subsequent read reports that side's remaining time as 43200 and its power state
  as on

#### Scenario: Power state follows remaining time

- **WHEN** a side's remaining time is set directly to a positive value, and separately to
  zero
- **THEN** reads report the side as on in the first case and off in the second, with no
  independently stored power flag

### Requirement: The mock reproduces away-mode both-sides mirroring

When either side's settings have away mode enabled, a device-status write addressed to one
side SHALL be applied to both sides. When neither side is in away mode, a write SHALL affect
only the addressed side.

#### Scenario: A write to one side hits both under away mode

- **WHEN** the right side is in away mode and a write sets the left side's target temperature
- **THEN** both sides' target temperatures change

#### Scenario: Normal mode affects only the addressed side

- **WHEN** neither side is in away mode and a write sets the left side's target temperature
- **THEN** only the left side changes

### Requirement: The mock applies and records commands in the Pod's fixed order

Within a single device-status write the mock SHALL apply per-side fields in the order power,
target temperature, seconds-remaining, alarm-vibration, and SHALL apply top-level sections in
the order priming, left side, right side, device settings. Each applied field SHALL be
recorded as a distinct ordered command entry with its side and value.

Consequently, a write containing both power-on and an explicit seconds-remaining for one side
SHALL end with the explicit seconds-remaining as the surviving value.

#### Scenario: Command order is observable

- **WHEN** a write sets several fields across both sides in one body
- **THEN** the recorded command sequence lists them in the fixed order regardless of the order
  the properties appeared in the request body

#### Scenario: Explicit duration wins over power-on in one write

- **WHEN** one write sets a side's power to on and its seconds-remaining to 600
- **THEN** the side's remaining time ends at 600, not 43200

### Requirement: The mock records every request for assertion

The mock SHALL record each received request in order with its method, path, headers, parsed
body, response status, and receipt time, and expose the recording to tests. The recording
SHALL be resettable and SHALL include requests that were rejected with 400.

This recording is the mechanism by which later changes assert on write coalescing, keep-alive
cadence, and the away-mode write guard.

#### Scenario: Traffic can be asserted exactly

- **WHEN** a test drives a client through a sequence of operations
- **THEN** it can assert the exact number, order, method, path, and body of the requests the
  mock received

#### Scenario: Rejected requests are recorded too

- **WHEN** a write is rejected with 400
- **THEN** the recording contains that request and its 400 response status

#### Scenario: Headers are recorded so absence of credentials is provable

- **WHEN** a test inspects a recorded request
- **THEN** the request's headers are available, allowing an assertion that no authentication
  header was sent

### Requirement: The mock can inject transport and server faults

Tests SHALL be able to make the mock, for a chosen endpoint and for a chosen number of
subsequent requests: return a specific error status, delay its response beyond the client's
timeout, or destroy the connection without responding. After the configured number of faulty
responses, normal behaviour SHALL resume.

#### Scenario: A transient server error can be scripted

- **WHEN** a test configures the next request to an endpoint to fail with 500
- **THEN** that request receives 500 and the following request is served normally

#### Scenario: A hang can be scripted

- **WHEN** a test configures an endpoint to accept a connection and never respond
- **THEN** the client's own timeout is what ends the request

#### Scenario: A connection reset can be scripted

- **WHEN** a test configures an endpoint to destroy the connection without responding
- **THEN** the client observes a network-level failure rather than an HTTP status

### Requirement: The test double is reusable by later changes

The fixtures and the mock SHALL be usable from any test in the suite without duplication:
starting a mock, seeding its state, driving it, reading its recording, and injecting faults
SHALL all be available through a stable interface intended for reuse by the poller, write
queue, keep-alive, and away-mode-guard changes.

Behaviour that is a policy decision of the plugin — deduplicating writes, guarding away mode,
scheduling keep-alives — SHALL NOT be implemented in the mock. The mock models the Pod only.

#### Scenario: A later change reuses the mock unchanged

- **WHEN** a change that adds polling or write queueing writes its tests
- **THEN** it can start, seed, drive, assert on, and fault-inject the mock without modifying
  the mock's own source

#### Scenario: The mock does not implement plugin policy

- **WHEN** a client sends a write that plugin policy would have suppressed — for example a
  redundant write, or a write to a side while away mode is on
- **THEN** the mock applies the Pod's real semantics to it rather than suppressing it, so the
  policy can be tested by asserting on the recording
