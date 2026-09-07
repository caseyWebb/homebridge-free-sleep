# config Specification

## Purpose

Defines the platform's configuration surface — the validated, defaulted, normalized shape
of the config block Homebridge hands the platform, and the Homebridge UI form that
produces it — including which keys this change's platform behavior actually consumes.

## Requirements

### Requirement: `host` is required and un-defaulted

The config schema SHALL treat `host` as a required, non-empty string with no default
value. A config object missing `host`, or providing a non-string or empty-string `host`,
SHALL fail validation with an error that identifies `host` as the offending field.

#### Scenario: Missing host fails validation

- **WHEN** a config object with no `host` key is validated
- **THEN** validation fails, and the error identifies `host` as required

#### Scenario: Wrong-typed or empty host fails validation

- **WHEN** a config object provides `host` as a non-string value, or as an empty string
- **THEN** validation fails, and the error identifies `host`

#### Scenario: Valid host passes validation

- **WHEN** a config object provides a non-empty string `host`
- **THEN** validation succeeds and the parsed config carries that host value

### Requirement: `host` is normalized to lowercase

The config schema SHALL lowercase `host` after trimming it, in addition to trimming
surrounding whitespace. DNS hostnames are case-insensitive, and normalizing on read is a
no-op for a literal IP address; without it, two spellings of the one configured host (for
example `'Pod.local'` and `'pod.local'`) would derive two different HomeKit UUIDs
(`uuidFor`, `src/platform.ts`) for what is meant to be the identical Pod, silently
destroying that Pod's HomeKit identity.

#### Scenario: Differently-cased host spellings normalize identically

- **WHEN** a config object's `host` is `'Pod.local'` and, separately, another config
  object's `host` is `'pod.local'`
- **THEN** both parse to the identical `host` value, and identity derived from it (such as
  a HomeKit accessory UUID) is identical between the two

### Requirement: `sides` defaults to `'both'` and rejects any other value

The config schema SHALL accept `sides` as one of exactly `'both'`, `'left'`, or `'right'`.
When `sides` is omitted, the parsed config SHALL default it to `'both'`. Any other value
SHALL fail validation with an error naming `sides` and its allowed values.

#### Scenario: Omitted sides defaults to both

- **WHEN** a config object with a valid `host` omits `sides`
- **THEN** validation succeeds and the parsed config's `sides` is `'both'`

#### Scenario: Each valid value is accepted

- **WHEN** `sides` is `'both'`, `'left'`, or `'right'`
- **THEN** validation succeeds and the parsed config's `sides` equals the given value

#### Scenario: An invalid sides value is rejected

- **WHEN** `sides` is any value other than `'both'`, `'left'`, or `'right'` — including a
  wrong-case variant such as `'Both'`, or an empty string
- **THEN** validation fails, and the error names `sides` and lists the allowed values

### Requirement: Reserved keys are fully defaulted and genuinely validated, even though unused this change

The config schema SHALL define `pollIntervals` (overrides), `writeSettleMs`,
`noResponseAfterMs`, `occupancySource`, `waterLowSensorType`, and `awayModeWritePolicy`, each
with a documented default. A config object that omits all of them SHALL parse to a
fully-defaulted object with no missing or undefined field among them. A wrong-typed or
out-of-range value for any one of them SHALL fail validation identifying that key, exactly as
a consumed key would — these keys SHALL NOT be accepted as unchecked or arbitrary values.

`pollIntervals.alarmPollIntervalMs` is no longer among the values this requirement's name
describes as "unused this change": its parsed value SHALL govern the polling interval used
during a scheduled alarm window. Every other field of `pollIntervals`, and every other key named
above, remains reserved and unconsumed, unchanged from before this requirement's modification.

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

- **WHEN** a reserved key other than `pollIntervals.alarmPollIntervalMs` is given a valid,
  non-default value
- **THEN** validation succeeds, the parsed config carries that value unchanged, and no
  accessory topology, identity, or restore behavior in this change differs as a result

#### Scenario: `alarmPollIntervalMs` is preserved and now acted on

- **WHEN** `pollIntervals.alarmPollIntervalMs` is given a valid, non-default value
- **THEN** validation succeeds, the parsed config carries that value, and the polling interval
  used during a scheduled alarm window is governed by that value rather than by the default

#### Scenario: `awayModeWritePolicy` is preserved and now acted on

- **WHEN** `awayModeWritePolicy` is given a valid, non-default value (`'block'`)
- **THEN** validation succeeds, the parsed config carries that value, and a side write
  attempted while either side is in away mode is governed by that value rather than by the
  default `'mirror'` behavior

#### Scenario: `occupancySource` is preserved and now acted on

- **WHEN** `occupancySource` is given a valid, non-default value (`'presence'` or `'vitals'`)
- **THEN** validation succeeds, the parsed config carries that value, and each enabled side
  accessory publishes an occupancy sensor driven by that source instead of publishing none

#### Scenario: Changing this key's shape cost nothing, because nothing read it before now

- **WHEN** comparing the config schema's `awayModeWritePolicy` enum and default as they exist
  now against any earlier, pre-implementation description of the same key
- **THEN** no migration of a deployed config is required, because no shipped behavior ever
  branched on this key's value before this change

#### Scenario: The default value changes nothing, because nothing read it before now

- **WHEN** comparing accessory topology under the default `occupancySource: 'none'` as it
  behaves now against how it behaved before this change shipped
- **THEN** the two are identical — no migration of a deployed config is required, because the
  default value produces the same "no occupancy sensor" outcome the key's prior, unconsumed
  state always produced

### Requirement: The Homebridge UI's `pluginAlias` matches the platform's registered name

`config.schema.json`'s `pluginAlias` SHALL be identical to the identifier the plugin
registers its platform under, so a user's `"platform"` value in Homebridge's `config.json`
and the Homebridge UI's generated form agree on which config block belongs to this plugin.

#### Scenario: pluginAlias matches the registered platform name

- **WHEN** `config.schema.json`'s `pluginAlias` is compared with the name the plugin passes
  to its platform registration call
- **THEN** the two values are identical

### Requirement: The Homebridge UI form exposes exactly the schema's keys

Every key defined in the config schema SHALL appear as a field in `config.schema.json`'s
generated form, with a matching type and, where the schema defines one, a matching default.
`config.schema.json` SHALL NOT expose a field for any key the schema does not define.

#### Scenario: Every schema key has a UI field

- **WHEN** the set of keys in the config schema is compared against the set of fields in
  `config.schema.json`'s form
- **THEN** every schema key has a corresponding form field of a matching type

#### Scenario: No undocumented UI field exists

- **WHEN** `config.schema.json`'s form fields are compared against the config schema
- **THEN** no field exists in the form that the schema does not also define

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

### Requirement: `awayModeSwitch`, `skipAlarmSwitch`, and `awayModeTurnsSideOff` are validated, defaulted, and consumed

The config schema SHALL define `awayModeSwitch` (boolean, default `true`), `skipAlarmSwitch`
(boolean, default `true`), and `awayModeTurnsSideOff` (boolean, default `false`). A config
object that omits any of them SHALL parse with that key defaulted; a wrong-typed value for any
of them SHALL fail validation identifying that key. Unlike this project's other reserved keys,
these three are consumed starting with this change: `awayModeSwitch` and `skipAlarmSwitch`
each gate whether their respective per-side switch is published at all, and
`awayModeTurnsSideOff` governs the sequencing the `away-mode-switch` capability's own
"Enabling away mode can optionally turn the side off first" requirement describes.

#### Scenario: All three keys default when omitted

- **WHEN** a config object with a valid `host` omits `awayModeSwitch`, `skipAlarmSwitch`, and
  `awayModeTurnsSideOff`
- **THEN** validation succeeds and the parsed config has `awayModeSwitch: true`,
  `skipAlarmSwitch: true`, and `awayModeTurnsSideOff: false`

#### Scenario: A wrong-typed value for any of the three keys is rejected

- **WHEN** `awayModeSwitch`, `skipAlarmSwitch`, or `awayModeTurnsSideOff` is given a non-boolean
  value
- **THEN** validation fails, and the error identifies that specific key

#### Scenario: Disabling a switch's config flag suppresses that accessory's service

- **WHEN** `awayModeSwitch` is `false` (respectively, `skipAlarmSwitch` is `false`)
- **THEN** the corresponding per-side switch service is not published, and a previously
  published one is pruned on restore

#### Scenario: awayModeTurnsSideOff is independent of the switches' own enable flags

- **WHEN** `awayModeTurnsSideOff` is `true` and `awayModeSwitch` is also `true`
- **THEN** enabling a side's Away Mode switch turns that side off first, exactly as the
  `away-mode-switch` capability's own requirement describes; `awayModeTurnsSideOff` has no
  effect when `awayModeSwitch` is `false`, since there is then no switch to toggle

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
