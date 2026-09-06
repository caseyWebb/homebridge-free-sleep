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
`noResponseAfterMs`, `occupancySource`, `waterLowSensorType`, `keepAlive`, and
`awayModeWritePolicy`, each with a documented default. A config object that omits all of
them SHALL parse to a fully-defaulted object with no missing or undefined field among
them. A wrong-typed or out-of-range value for any one of them SHALL fail validation
identifying that key, exactly as a consumed key would — these keys SHALL NOT be accepted
as unchecked or arbitrary values.

#### Scenario: All reserved keys default when omitted

- **WHEN** a config object with a valid `host` omits every reserved key
- **THEN** validation succeeds and the parsed config has a defined, documented default
  value for each of `pollIntervals`, `writeSettleMs`, `noResponseAfterMs`,
  `occupancySource`, `waterLowSensorType`, `keepAlive`, and `awayModeWritePolicy`

#### Scenario: A reserved key with an invalid value is rejected

- **WHEN** any one reserved key is given a value outside its declared type, range, or enum
  (for example, a negative `writeSettleMs`, or an `occupancySource` value not in its
  defined set)
- **THEN** validation fails, and the error identifies that specific key

#### Scenario: A reserved key with a valid value is preserved but not acted on

- **WHEN** a reserved key is given a valid, non-default value
- **THEN** validation succeeds, the parsed config carries that value unchanged, and no
  accessory topology, identity, or restore behavior in this change differs as a result

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
