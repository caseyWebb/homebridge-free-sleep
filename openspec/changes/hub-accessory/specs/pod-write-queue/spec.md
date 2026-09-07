## Context (delta rationale, not part of the synced spec)

`pod-write-queue`'s shipped spec already generalizes debounce/merge/mutex behavior across "the
left side, the right side, the device-wide settings carried on the status endpoint, and the
persisted settings endpoint" as independent lanes sharing one debounce value. This change adds
a second field this plugin can write on the device-wide lane (a priming trigger, alongside the
existing device-settings fields) and — because that lane's one real-world consumer today (LED
brightness) needs a stricter debounce than the shared default the side lanes use — gives that
one lane its own, independently configurable debounce. Both are narrow amendments to the
existing "Writes are debounced per lane" requirement; nothing about merge order, the maximum
wait, the mutex, or the duration reduction changes.

## MODIFIED Requirements

### Requirement: Writes are debounced per lane and merged field by field

A submitted write SHALL NOT be dispatched immediately. It SHALL be held for a debounce
interval, during which further writes to the same lane merge into it: a field present in a
later write SHALL replace the same field from an earlier one, and fields only present in the
earlier write SHALL be retained. The debounce interval SHALL be configurable.

The lanes SHALL be independent of one another: the left side, the right side, the device-wide
lane (carrying both the device-settings fields and a priming-trigger field), and the
persisted-settings endpoint. A write to one lane SHALL NOT delay or merge with a write to
another.

The device-wide lane's debounce interval SHALL be independently configurable from the debounce
interval applied to every other lane, and SHALL default to a longer value than the other
lanes' shared default — so that a feature writing frequently on the device-wide lane can be
given a stricter debounce without changing the responsiveness of a side write.

#### Scenario: A rapid pair becomes one merged write

- **WHEN** a power-state write and a target-temperature write for the same side are submitted
  ten milliseconds apart
- **THEN** the Pod receives exactly one request, whose body carries both fields for that side

#### Scenario: The later value wins

- **WHEN** three target temperatures for the same side are submitted within the debounce window
- **THEN** the Pod receives one request carrying the last of the three

#### Scenario: Lanes do not merge

- **WHEN** a write to the left side and a write to the right side are submitted together
- **THEN** each is dispatched for its own side, and neither is delayed by the other's window

#### Scenario: A priming trigger and a device-settings write merge on the same lane

- **WHEN** a priming trigger and a device-settings write are submitted within the device-wide
  lane's debounce window of each other
- **THEN** the Pod receives one request carrying both the priming trigger and the
  device-settings fields

#### Scenario: The device-wide lane's debounce is independent of the side lanes' debounce

- **WHEN** the device-wide lane's debounce interval is configured to a value different from
  the side lanes' shared debounce interval
- **THEN** a device-wide-lane write is held for the device-wide lane's own configured
  interval, and a side write's debounce timing is unaffected
