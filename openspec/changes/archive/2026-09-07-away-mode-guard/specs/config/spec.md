## MODIFIED Requirements

### Requirement: Reserved keys are fully defaulted and genuinely validated, even though unused this change

The config schema SHALL define `pollIntervals` (overrides), `writeSettleMs`,
`noResponseAfterMs`, `occupancySource`, `waterLowSensorType`, `keepAlive`, and
`awayModeWritePolicy`, each with a documented default. A config object that omits all of
them SHALL parse to a fully-defaulted object with no missing or undefined field among
them. A wrong-typed or out-of-range value for any one of them SHALL fail validation
identifying that key, exactly as a consumed key would — these keys SHALL NOT be accepted
as unchecked or arbitrary values.

`awayModeWritePolicy` is no longer among the keys this requirement's name describes as
"unused this change": it SHALL be one of exactly `'mirror'` or `'block'`, defaulting to
`'mirror'` when omitted, and its parsed value SHALL govern how the away-mode guard treats a
side write attempted while either side is in away mode. `pollIntervals`, `writeSettleMs`,
`noResponseAfterMs`, `occupancySource`, `waterLowSensorType`, and `keepAlive` remain reserved
and unconsumed, unchanged from before this requirement's modification.

#### Scenario: All reserved keys default when omitted

- **WHEN** a config object with a valid `host` omits every reserved key
- **THEN** validation succeeds and the parsed config has a defined, documented default
  value for each of `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`,
  `occupancySource`, `waterLowSensorType`, `keepAlive`, and `awayModeWritePolicy`

#### Scenario: A reserved key with an invalid value is rejected

- **WHEN** any one reserved key is given a value outside its declared type, range, or enum
  (for example, a negative `writeSettleMs`, an `occupancySource` value not in its defined
  set, or an `awayModeWritePolicy` value other than `'mirror'` or `'block'`)
- **THEN** validation fails, and the error identifies that specific key

#### Scenario: A reserved key with a valid value is preserved but not acted on

- **WHEN** `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`, `occupancySource`,
  `waterLowSensorType`, or `keepAlive` is given a valid, non-default value
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
