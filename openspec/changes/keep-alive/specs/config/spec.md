## MODIFIED Requirements

### Requirement: Reserved keys are fully defaulted and genuinely validated, even though unused this change

The config schema SHALL define `pollIntervals` (overrides), `writeSettleMs`,
`noResponseAfterMs`, `occupancySource`, `waterLowSensorType`, and `awayModeWritePolicy`, each
with a documented default. A config object that omits all of them SHALL parse to a
fully-defaulted object with no missing or undefined field among them. A wrong-typed or
out-of-range value for any one of them SHALL fail validation identifying that key, exactly as
a consumed key would — these keys SHALL NOT be accepted as unchecked or arbitrary values.

#### Scenario: All reserved keys default when omitted

- **WHEN** a config object with a valid `host` omits every reserved key
- **THEN** validation succeeds and the parsed config has a defined, documented default
  value for each of `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`,
  `occupancySource`, `waterLowSensorType`, and `awayModeWritePolicy`

#### Scenario: A reserved key with an invalid value is rejected

- **WHEN** any one reserved key is given a value outside its declared type, range, or enum
  (for example, a negative `writeSettleMs`, or an `occupancySource` value not in its
  defined set)
- **THEN** validation fails, and the error identifies that specific key

#### Scenario: A reserved key with a valid value is preserved but not acted on

- **WHEN** a reserved key is given a valid, non-default value
- **THEN** validation succeeds, the parsed config carries that value unchanged, and no
  accessory topology, identity, or restore behavior in this change differs as a result

## ADDED Requirements

### Requirement: `keepAlive`, `keepAliveMs`, and `keepAliveThresholdMs` are defaulted and validated

The config schema SHALL accept `keepAlive` as a boolean, defaulting to `true` when omitted.
It SHALL accept `keepAliveMs` and `keepAliveThresholdMs` as positive integers, each with a
documented default and a minimum bound, and SHALL reject a configuration where
`keepAliveThresholdMs` is not strictly less than `keepAliveMs` — a threshold at or above the
duration itself would either never fire or fire immediately on every re-arm. A config object
that omits any of the three SHALL parse to the documented default for the omitted key(s).

Unlike the keys named in "Reserved keys are fully defaulted...", `keepAlive` (and the two
duration keys it gates) are consumed starting with this change: a `keepAlive` of `false`
disables the keep-alive behavior entirely, and `keepAliveMs`/`keepAliveThresholdMs` configure
it when enabled.

#### Scenario: All three default when omitted

- **WHEN** a config object with a valid `host` omits `keepAlive`, `keepAliveMs`, and
  `keepAliveThresholdMs`
- **THEN** validation succeeds and the parsed config defaults `keepAlive` to `true`,
  `keepAliveMs` to a positive value representing 12 hours, and `keepAliveThresholdMs` to a
  positive value representing 30 minutes

#### Scenario: A non-boolean keepAlive is rejected

- **WHEN** `keepAlive` is given a non-boolean value
- **THEN** validation fails, and the error identifies `keepAlive`

#### Scenario: A threshold at or above the duration is rejected

- **WHEN** `keepAliveThresholdMs` is given a value greater than or equal to `keepAliveMs`
- **THEN** validation fails, and the error identifies the conflict between the two keys

#### Scenario: A below-minimum duration or threshold is rejected

- **WHEN** `keepAliveMs` or `keepAliveThresholdMs` is given a positive value below its
  documented minimum
- **THEN** validation fails, and the error identifies that specific key

#### Scenario: Valid, non-default values are preserved

- **WHEN** `keepAlive`, `keepAliveMs`, and `keepAliveThresholdMs` are each given a valid
  value satisfying the above
- **THEN** validation succeeds and the parsed config carries each value unchanged
