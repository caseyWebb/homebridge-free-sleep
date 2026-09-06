## Purpose

Typed, resilient access to a free-sleep Pod's unauthenticated LAN HTTP API: the vendored
wire contract for device status, settings, schedules and services; the request behaviour
that keeps a plugin from overwhelming the Pod's serialised hardware queue (timeout,
concurrency, deduplication, retry policy); the error taxonomy callers use to distinguish a
rebooting Pod from a rejected payload; and a read-only smoke check against real hardware.

## ADDED Requirements

### Requirement: Wire types are vendored, not depended upon

The plugin SHALL carry its own copy of the free-sleep wire contract for device status,
settings, schedules and services. It SHALL NOT declare a package, git, or path dependency on
the free-sleep repository at build time or at runtime.

Each vendored contract SHALL record, in the source file, the upstream repository, version,
commit, and the upstream file path it was copied from, so drift can be audited against a
fixed upstream point.

#### Scenario: No dependency on free-sleep

- **WHEN** the package's declared dependencies, devDependencies, and peerDependencies are
  inspected
- **THEN** none of them resolves to the free-sleep repository, and the build succeeds on a
  machine where free-sleep is not checked out

#### Scenario: Provenance is recorded

- **WHEN** a reader opens the vendored wire-type module
- **THEN** it states the upstream version and commit it was copied from, and names the
  upstream source file for each vendored contract

### Requirement: Reads are parsed leniently, requests are validated strictly

Response parsing SHALL accept unknown properties and SHALL NOT enforce value-range
constraints that the Pod does not enforce on its own responses, so that a newer free-sleep
version or an out-of-range hardware reading cannot fail an otherwise usable read.

Request payload validation SHALL mirror what the Pod enforces: unknown properties SHALL be
rejected locally, and `targetTemperatureF` SHALL be constrained to an integer in 55–110 °F.

#### Scenario: Unknown response field is preserved, not rejected

- **WHEN** a device-status response contains a property the vendored contract does not know
  about
- **THEN** parsing succeeds, every known field is returned with its declared type, and the
  unknown property is not treated as an error

#### Scenario: Out-of-range reading does not fail a read

- **WHEN** a device-status response reports a `targetTemperatureF` outside 55–110
- **THEN** parsing succeeds and returns the reported value unchanged

#### Scenario: A structurally wrong response is an error

- **WHEN** a response is missing a required field, or a field has the wrong JSON type
- **THEN** the read fails with an error distinguishable from a transport failure, and the
  error identifies the offending property path

#### Scenario: An out-of-range write is rejected before it is sent

- **WHEN** a caller requests a target temperature outside 55–110 °F, or a non-integer value
- **THEN** the request fails locally with a validation error and no HTTP request is made

### Requirement: Water level is exposed as its raw string plus a three-state interpretation

`waterLevel` SHALL be typed and carried as the string the Pod returns. The plugin SHALL
additionally expose an interpretation with exactly three outcomes: adequate, low, and
unknown. The string `"true"` SHALL mean adequate, `"false"` SHALL mean low, and any other
value SHALL mean unknown. An unknown value SHALL NOT be reported as low.

#### Scenario: Known values map to adequate and low

- **WHEN** `waterLevel` is `"true"`
- **THEN** the interpretation is adequate
- **WHEN** `waterLevel` is `"false"`
- **THEN** the interpretation is low

#### Scenario: Unexpected value is unknown, not low

- **WHEN** `waterLevel` is any string other than `"true"` or `"false"` — including `""`,
  `"unknown"`, or a value from a future free-sleep version
- **THEN** the interpretation is unknown, the raw string remains available to the caller, and
  the result is not reported as low

### Requirement: Every request carries its own timeout

Each HTTP attempt SHALL be aborted after approximately 8 seconds, chosen to be shorter than
the Pod's own 10-second response timeout and far shorter than its 25-second connection path.
A caller-supplied cancellation signal SHALL abort the request as well, without waiting for
the timeout.

#### Scenario: A hung Pod does not hang the caller

- **WHEN** the Pod accepts a connection but never responds
- **THEN** the attempt is aborted at approximately 8 seconds and the call ultimately rejects
  with a timeout error rather than hanging

#### Scenario: Caller cancellation is honoured

- **WHEN** a caller aborts its own signal while a request is in flight
- **THEN** the call rejects promptly with a cancellation error, and no further attempt or
  retry is made

### Requirement: At most one in-flight request per endpoint

The client SHALL allow at most one HTTP request in flight per API endpoint at a time.
Additional requests to the same endpoint SHALL wait for the in-flight one to settle rather
than being issued concurrently. Requests to different endpoints SHALL NOT block each other.

#### Scenario: Two writes to one endpoint are serialised

- **WHEN** two different write requests to the same endpoint are started at the same time
- **THEN** the Pod observes them one after another, never overlapping, and both callers
  receive their own result

#### Scenario: Different endpoints proceed in parallel

- **WHEN** a device-status read and a settings read are started at the same time
- **THEN** both are in flight concurrently and neither waits for the other

### Requirement: Identical concurrent reads are deduplicated

When a read request is issued while an identical read to the same endpoint is already in
flight, the client SHALL attach the new caller to the in-flight request instead of issuing a
second one. Writes SHALL NEVER be deduplicated: two identical writes are two deliberate
commands and both SHALL be sent.

A deduplicated result SHALL be safe to hand to multiple callers: one caller SHALL NOT be able
to observe another caller's mutation of the returned value.

#### Scenario: Concurrent identical reads produce one request

- **WHEN** three device-status reads are started while the first is still in flight
- **THEN** the Pod receives exactly one device-status request and all three callers resolve
  with equal data

#### Scenario: A read started after the previous one settles is a new request

- **WHEN** a device-status read is issued after an earlier identical read has already
  resolved
- **THEN** a second request is sent to the Pod — results are never cached or replayed

#### Scenario: Identical writes are both sent

- **WHEN** the same write payload is submitted twice
- **THEN** the Pod receives two write requests

#### Scenario: Deduplicated callers cannot interfere

- **WHEN** two callers share a deduplicated read result and one mutates its copy
- **THEN** the other caller's value is unaffected

### Requirement: One retry with backoff, and never on a rejected payload

A failed attempt SHALL be retried at most once, after a short backoff, and only when the
failure is a network-level error or an HTTP 5xx. A 4xx response SHALL NEVER be retried; a
400 in particular means the Pod's strict schema rejected the payload and retrying cannot
help. A locally-aborted caller cancellation SHALL NEVER be retried.

Retrying SHALL be safe for the write endpoints the client exposes, because each underlying
Pod command sets a value rather than applying a delta.

#### Scenario: A 5xx is retried once and then succeeds

- **WHEN** the Pod returns 500 on the first attempt and 200 on the second
- **THEN** the caller receives the successful result and exactly two requests were made

#### Scenario: A persistent failure stops after one retry

- **WHEN** the Pod returns 500 on both attempts
- **THEN** the call rejects with the HTTP error and exactly two requests were made

#### Scenario: A network error is retried

- **WHEN** the connection is refused or reset before a response is received, then succeeds
- **THEN** the caller receives the successful result and exactly two requests were made

#### Scenario: A 400 is never retried

- **WHEN** the Pod rejects a payload with 400
- **THEN** exactly one request is made and the call rejects immediately

#### Scenario: Backoff separates the attempts

- **WHEN** a retryable failure occurs
- **THEN** the second attempt is issued after a non-zero delay, not immediately

### Requirement: Errors are typed by cause

Every failure SHALL surface as a typed error that a caller can branch on without inspecting
message strings, distinguishing at minimum: a request that never reached the Pod (network),
a request that timed out, a payload the Pod rejected as invalid, another HTTP error status,
a response that did not match the expected shape, and a caller cancellation.

A payload-rejection error SHALL carry the HTTP status and the validation detail the Pod
returned, so the offending field can be logged.

#### Scenario: A rebooting Pod is distinguishable from a bad payload

- **WHEN** a request fails because the Pod is unreachable, and separately a request fails
  with 400
- **THEN** the two failures are distinguishable by error type alone, so a caller can treat
  the first as an expected transient state and the second as a defect

#### Scenario: Validation detail is preserved

- **WHEN** the Pod rejects a payload with 400 and a body describing the invalid property
- **THEN** the raised error exposes the status and that detail

### Requirement: No credentials are ever sent

The client SHALL NOT send any authentication material — no `Authorization` header, no
cookies, no API key or token, in any request — and SHALL provide no configuration surface to
add one. The free-sleep API has no authentication; sending credentials to it would only leak
them onto the LAN.

#### Scenario: Requests carry no auth

- **WHEN** any request the client can issue is inspected as received by the server
- **THEN** it contains no `Authorization` header, no `Cookie` header, and no credential in
  the URL

### Requirement: Mutually exclusive duration fields are rejected locally

Because the Pod applies a device-status write in a fixed order in which the explicit
duration is applied last and overwrites the power field's implicit duration, the client
SHALL reject a single device-status write that sets both the power field and the explicit
seconds-remaining field for the same side, failing locally without issuing a request.

#### Scenario: Conflicting fields in one write are refused

- **WHEN** a caller submits one device-status write setting both power and seconds-remaining
  for the same side
- **THEN** the call rejects with a validation error naming the conflict, and no HTTP request
  is made

#### Scenario: Each field alone is accepted

- **WHEN** a caller sets only power, or only seconds-remaining, for a side
- **THEN** the write is sent normally

### Requirement: A read-only smoke check verifies a real Pod

The project SHALL provide a manually-invoked smoke check that takes a Pod host, reads its
status, settings, schedules and services, and reports: whether the Pod was reachable, the
cover and hub version, the raw `waterLevel` string and its interpretation, whether gesture
tap counters are present in the device-status response, and the observed latency of each
request.

The smoke check SHALL perform no writes of any kind.

#### Scenario: Reachable Pod is summarised

- **WHEN** the smoke check is run against a reachable Pod host
- **THEN** it exits successfully and prints the versions, the water level string and its
  interpretation, whether tap counters were present, and per-request latency

#### Scenario: Unreachable Pod fails clearly

- **WHEN** the smoke check is run against a host that is not a Pod, or is offline
- **THEN** it exits non-zero with a message naming the host and the failure cause, rather
  than hanging or printing a stack trace alone

#### Scenario: The smoke check never writes

- **WHEN** the smoke check runs to completion against any host
- **THEN** every request it issued was a read, and no Pod setting, schedule, or device state
  was modified
