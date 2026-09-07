## Context (delta rationale, not part of the synced spec)

Mirrors the mechanical shape of `keep-alive`'s and `away-mode-guard`'s own moves of a key out of
the reserved bucket: `occupancySource`'s schema shape (`z.enum(['none', 'presence',
'vitals']).default('none')`) is completely unchanged by this delta — only which requirement
describes it as acted upon changes.

## MODIFIED Requirements

### Requirement: Reserved keys are fully defaulted and genuinely validated, even though unused this change

The config schema SHALL define `pollIntervals` (overrides), `writeSettleMs`,
`noResponseAfterMs`, `waterLowSensorType`, `keepAlive`, and `awayModeWritePolicy`, each with a
documented default. A config object that omits all of them SHALL parse to a fully-defaulted
object with no missing or undefined field among them. A wrong-typed or out-of-range value for
any one of them SHALL fail validation identifying that key, exactly as a consumed key would —
these keys SHALL NOT be accepted as unchecked or arbitrary values.

`occupancySource` is no longer among the keys this requirement's name describes as "unused this
change": it SHALL be one of exactly `'none'`, `'presence'`, or `'vitals'`, defaulting to
`'none'` when omitted, and its parsed value SHALL govern whether and how each side accessory
publishes an occupancy sensor. `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`,
`waterLowSensorType`, `keepAlive`, and `awayModeWritePolicy` remain reserved and unconsumed,
unchanged from before this requirement's modification.

#### Scenario: All reserved keys default when omitted

- **WHEN** a config object with a valid `host` omits every reserved key
- **THEN** validation succeeds and the parsed config has a defined, documented default value
  for each of `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`, `occupancySource`,
  `waterLowSensorType`, `keepAlive`, and `awayModeWritePolicy`

#### Scenario: A reserved key with an invalid value is rejected

- **WHEN** any one reserved key is given a value outside its declared type, range, or enum (for
  example, a negative `writeSettleMs`, or a `waterLowSensorType` value not in its defined set)
- **THEN** validation fails, and the error identifies that specific key

#### Scenario: A reserved key with a valid value is preserved but not acted on

- **WHEN** `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`, `waterLowSensorType`,
  `keepAlive`, or `awayModeWritePolicy` is given a valid, non-default value
- **THEN** validation succeeds, the parsed config carries that value unchanged, and no
  accessory topology, identity, or restore behavior in this change differs as a result

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
