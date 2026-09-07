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

## ADDED Requirements

### Requirement: The device-wide lane's settings sub-object is backfilled from a freshly-refreshed observation immediately before dispatch (S4, PR #44 review)

A caller submitting a device-settings field on the device-wide lane SHALL NOT need to supply
every field of the settings sub-object itself to avoid a partial write silently dropping the
fields it omits. Immediately before dispatching a device-wide-lane write that carries any
settings sub-object field, the queue SHALL first attempt a bounded refresh of the
device-status observation, then merge the currently-observed settings sub-object with the
fields this write cycle explicitly supplied — the explicitly-supplied fields SHALL take
precedence over the observed ones for the same field.

This narrows, but does not eliminate, a race in which a settings sub-object field is changed
by something other than this plugin between the observation this write merges against and the
write actually reaching the Pod.

#### Scenario: A caller supplying only the field it changes gets the other fields backfilled

- **WHEN** a device-wide-lane write supplies only one settings sub-object field
- **THEN** the dispatched request's settings sub-object carries that field's new value
  together with the other settings sub-object fields from the current observation, unaltered

#### Scenario: A freshly-observed value, not a value cached before dispatch, is used for the fields a write does not supply

- **WHEN** a settings sub-object field this write does not itself supply changes, due to the
  bounded pre-dispatch refresh, between this write's submission and its dispatch
- **THEN** the dispatched request carries the freshly-observed value for that field, not the
  value that was current at submission time

#### Scenario: A device-wide-lane write carrying no settings sub-object field never triggers the refresh

- **WHEN** a device-wide-lane write carries only the priming-trigger field
- **THEN** no pre-dispatch refresh attempt is made for that write
