## MODIFIED Requirements

### Requirement: Wire types are vendored, not depended upon

The plugin SHALL carry its own copy of the free-sleep wire contract for device status,
settings, schedules, services, and subsystem health status. It SHALL NOT declare a package,
git, or path dependency on the free-sleep repository at build time or at runtime.

Each vendored contract SHALL record, in the source file, the upstream repository, version,
commit, and the upstream file path it was copied from, so drift can be audited against a
fixed upstream point. The alarm-trigger request shape SHALL likewise be vendored as a
request-only contract with the same provenance recording, even though the plugin never reads
a response body shaped like it.

#### Scenario: No dependency on free-sleep

- **WHEN** the package's declared dependencies, devDependencies, and peerDependencies are
  inspected
- **THEN** none of them resolves to the free-sleep repository, and the build succeeds on a
  machine where free-sleep is not checked out

#### Scenario: Provenance is recorded

- **WHEN** a reader opens the vendored wire-type module
- **THEN** it states the upstream version and commit it was copied from, and names the
  upstream source file for each vendored contract, including the subsystem-health contract
  and the alarm-trigger request contract

## ADDED Requirements

### Requirement: Subsystem health can be read

The client SHALL expose a method that reads the Pod's self-reported subsystem health and
parses it against the vendored contract, following the same lenient-read rules every other
read follows (unknown properties preserved rather than rejected, no value-range constraint
the Pod does not itself enforce).

#### Scenario: A subsystem-health read succeeds

- **WHEN** the subsystem-health endpoint responds with a well-formed body
- **THEN** the read resolves with every subsystem's reported name, status, and message

#### Scenario: An unexpected subsystem key is preserved, not rejected

- **WHEN** the subsystem-health response contains a subsystem key the vendored contract does
  not explicitly enumerate as always-present
- **THEN** parsing still succeeds for every subsystem the contract does know about

### Requirement: An alarm trigger can be sent, and is never retried

The client SHALL expose a method that sends an immediate alarm-trigger request, validated
locally against a strict request contract before any request is issued. Unlike every other
write this client exposes, a failed alarm-trigger attempt SHALL NOT be retried under any
circumstance — not on a network-level error, and not on an HTTP 5xx — because the underlying
Pod operation is not safe to repeat: a second attempt landing while the first's effect is
still in progress risks triggering the physical alarm twice.

The alarm-trigger endpoint SHALL still be subject to the same at-most-one-in-flight-per-
endpoint serialization every other endpoint gets.

#### Scenario: A successful trigger sends exactly one request

- **WHEN** an alarm trigger is sent and the Pod responds successfully
- **THEN** exactly one request was made

#### Scenario: A failed trigger is not retried

- **WHEN** an alarm trigger's request fails with a network-level error, or with an HTTP 5xx
- **THEN** the call rejects after exactly one attempt, with no second attempt made

#### Scenario: An invalid trigger is rejected locally

- **WHEN** an alarm trigger is requested with a value outside the contract's bounds
- **THEN** the call rejects locally with a validation error, and no request is made

#### Scenario: Two alarm triggers to the same endpoint are still serialized

- **WHEN** two alarm-trigger requests are issued at the same time
- **THEN** the Pod observes them one after another, never overlapping
