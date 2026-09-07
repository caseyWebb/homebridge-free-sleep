## ADDED Requirements

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
