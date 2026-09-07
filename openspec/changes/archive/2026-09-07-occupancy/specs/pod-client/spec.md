## ADDED Requirements

### Requirement: The client reads presence and vitals, and writes neither

`PodClient` SHALL offer a read of the presence endpoint and a read of the vitals endpoint,
each following the same timeout, per-endpoint serialisation, in-flight GET deduplication, and
lenient response parsing every other read already uses. The vitals read SHALL accept optional
side and time-range filters, applied as query parameters only when given. `PodClient` SHALL
NOT offer any write to either endpoint.

#### Scenario: Presence reads the whole document

- **WHEN** a presence read is made against a reachable Pod
- **THEN** it resolves with both sides' presence data, parsed leniently

#### Scenario: Vitals reads accept optional filters

- **WHEN** a vitals read is made with a side filter, a time range, both, or neither
- **THEN** exactly the given filters are sent as query parameters, and an omitted filter is not
  sent at all

#### Scenario: No write exists for either endpoint

- **WHEN** the client's public surface is inspected
- **THEN** it offers no method that issues a write to the presence or vitals endpoint

### Requirement: Vitals rows are parsed without upstream's insert-side value bounds

The vitals response schema SHALL accept any numeric value, including out-of-range and null, for
heart rate, heart-rate variability, and breathing rate, and SHALL NOT reject a row for a value
outside any physiological range. It SHALL preserve each field's wire name exactly, without
relabeling.

This mirrors the project's established rule that a value the Pod itself never re-validates on
read must still parse — confirmed here by a real capture containing heart-rate-variability and
breathing-rate values of zero, which fall outside the range enforced only on the endpoint's own
insert path.

#### Scenario: A real capture with unvalidated fields parses cleanly

- **WHEN** a vitals response contains rows with heart-rate-variability or breathing-rate values
  of zero
- **THEN** parsing succeeds and those values are preserved unchanged

#### Scenario: A null vital value parses cleanly

- **WHEN** a vitals row reports a null value for heart rate, heart-rate variability, or
  breathing rate
- **THEN** parsing succeeds and that field is preserved as null, not coerced or rejected
