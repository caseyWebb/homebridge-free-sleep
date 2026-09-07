## MODIFIED Requirements

### Requirement: Reserved keys are fully defaulted and genuinely validated, even though unused this change

The config schema SHALL define `pollIntervals` (overrides), `writeSettleMs`,
`noResponseAfterMs`, and `occupancySource`, each with a documented default. A config object
that omits all of them SHALL parse to a fully-defaulted object with no missing or undefined
field among them. A wrong-typed or out-of-range value for any one of them SHALL fail
validation identifying that key, exactly as a consumed key would — these keys SHALL NOT be
accepted as unchecked or arbitrary values.

`waterLowSensorType` and `awayModeWritePolicy` are no longer among the keys this
requirement's name describes as "unused this change" — `awayModeWritePolicy` since
`away-mode-guard`, `waterLowSensorType` since this change (see the new "`waterLowSensorType`
is consumed" requirement below). `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`, and
`occupancySource` remain reserved and unconsumed, unchanged from before this requirement's
modification.

#### Scenario: All reserved keys default when omitted

- **WHEN** a config object with a valid `host` omits every reserved key
- **THEN** validation succeeds and the parsed config has a defined, documented default value
  for each of `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`, and `occupancySource`

#### Scenario: A reserved key with an invalid value is rejected

- **WHEN** any one reserved key is given a value outside its declared type, range, or enum
  (for example, a negative `writeSettleMs`, or an `occupancySource` value not in its defined
  set)
- **THEN** validation fails, and the error identifies that specific key

#### Scenario: A reserved key with a valid value is preserved but not acted on

- **WHEN** `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`, or `occupancySource` is
  given a valid, non-default value
- **THEN** validation succeeds, the parsed config carries that value unchanged, and no
  accessory topology, identity, or restore behavior in this change differs as a result

#### Scenario: `awayModeWritePolicy` is preserved and now acted on

- **WHEN** `awayModeWritePolicy` is given a valid, non-default value (`'block'`)
- **THEN** validation succeeds, the parsed config carries that value, and a side write
  attempted while either side is in away mode is governed by that value rather than by the
  default `'mirror'` behavior

#### Scenario: Changing this key's shape cost nothing, because nothing read it before now

- **WHEN** comparing the config schema's `awayModeWritePolicy` enum and default as they exist
  now against any earlier, pre-implementation description of the same key
- **THEN** no migration of a deployed config is required, because no shipped behavior ever
  branched on this key's value before this change

#### Scenario: `occupancySource` is preserved and now acted on

- **WHEN** `occupancySource` is given a valid, non-default value (`'presence'` or `'vitals'`)
- **THEN** validation succeeds, the parsed config carries that value, and each enabled side
  accessory publishes an occupancy sensor driven by that source instead of publishing none

#### Scenario: The default value changes nothing, because nothing read it before now

- **WHEN** comparing accessory topology under the default `occupancySource: 'none'` as it
  behaves now against how it behaved before this change shipped
- **THEN** the two are identical — no migration of a deployed config is required, because the
  default value produces the same "no occupancy sensor" outcome the key's prior, unconsumed
  state always produced

## ADDED Requirements

### Requirement: `waterLowSensorType` is consumed, and stays a two-value enum

The config schema SHALL accept `waterLowSensorType` as one of exactly `'contact'` or
`'leak'`, defaulting to `'contact'` when omitted — unchanged in shape from before this
change. Its parsed value SHALL now govern which HomeKit service type the hub's water-level
sensor is published as. No third value is accepted.

#### Scenario: The default selects the contact sensor

- **WHEN** `waterLowSensorType` is omitted
- **THEN** validation succeeds, the parsed value is `'contact'`, and the hub's water-level
  sensor is published as a contact sensor

#### Scenario: `'leak'` selects the leak sensor

- **WHEN** `waterLowSensorType` is `'leak'`
- **THEN** validation succeeds and the hub's water-level sensor is published as a leak sensor

#### Scenario: A third value is still rejected

- **WHEN** `waterLowSensorType` is any value other than `'contact'` or `'leak'`
- **THEN** validation fails, and the error names `waterLowSensorType` and lists exactly the
  two allowed values

### Requirement: Four new hub-service keys default to disabled and are each independently validated

The config schema SHALL define four new boolean keys — one each gating the prime switch, the
LED lightbulb, the test-alarm switch, and the server-fault sensor — every one defaulting to
`false` when omitted. A wrong-typed value for any one of them SHALL fail validation
identifying that key.

#### Scenario: All four default to disabled

- **WHEN** a config object with a valid `host` omits all four keys
- **THEN** validation succeeds and the parsed config has each of the four keys set to `false`

#### Scenario: Each key can be independently enabled

- **WHEN** exactly one of the four keys is set to `true` and the other three are omitted
- **THEN** validation succeeds, the parsed config reflects that one key as `true` and the
  other three as their default `false`

#### Scenario: A wrong-typed value is rejected

- **WHEN** any one of the four keys is given a non-boolean value
- **THEN** validation fails, and the error identifies that specific key

### Requirement: The device-lane write debounce is independently configurable within `pollIntervals`

The config schema's `pollIntervals` override object SHALL accept an additional field
governing the write debounce applied specifically to device-wide settings writes (as opposed
to the debounce applied to a per-side write), defaulting to 500 milliseconds and rejecting a
configured value below 500 milliseconds.

#### Scenario: The default applies when omitted

- **WHEN** `pollIntervals` omits the device-lane debounce field
- **THEN** validation succeeds and the parsed value for that field is 500 milliseconds

#### Scenario: A below-minimum value is rejected

- **WHEN** the device-lane debounce field is configured below 500 milliseconds
- **THEN** validation fails, and the error identifies that field
