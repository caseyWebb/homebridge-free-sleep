## ADDED Requirements

### Requirement: `wakeAlarmSwitch`, `wakeAlarm`, `snoozeSwitch`, and `snoozeTemperatureDeltaF` are validated, defaulted, and consumed

`wakeAlarmSwitch` and `snoozeSwitch` SHALL be booleans defaulting to `false`. `wakeAlarm` SHALL
be an object whose `duration` (integer 1–180, default 180), `vibrationIntensity` (integer
1–100, default 100) and `vibrationPattern` (`'double'` | `'rise'`, default `'double'`) are each
individually defaulted, so a partial object is completed rather than rejected, and whose
omission yields the fully-populated default. `snoozeTemperatureDeltaF` SHALL be an integer in
−55..55, not 0, defaulting to 10. Each out-of-range or mistyped value SHALL be rejected naming
its own path. All four SHALL appear in `config.schema.json`, including `wakeAlarm`'s nested
properties.

#### Scenario: Partial alarm object

- **WHEN** config contains `wakeAlarm: { duration: 30 }`
- **THEN** the parsed `wakeAlarm` is `{ duration: 30, vibrationIntensity: 100, vibrationPattern:
  'double' }`

#### Scenario: Zero delta

- **WHEN** config contains `snoozeTemperatureDeltaF: 0`
- **THEN** parsing fails with an issue at `snoozeTemperatureDeltaF`
