## ADDED Requirements

### Requirement: `alarmSwitchStartsAlarm` and `alarmSwitchAlarm` are validated, defaulted, and consumed

`alarmSwitchStartsAlarm` SHALL be a boolean defaulting to `false`. `alarmSwitchAlarm` SHALL be
an object whose `duration` (integer 1–180, default 180), `vibrationIntensity` (integer 1–100,
default 100) and `vibrationPattern` (`'double'` | `'rise'`, default `'double'`) are each
individually defaulted, so a partial object is completed rather than rejected, and whose
omission yields the fully-populated default. Each out-of-range or mistyped value SHALL be
rejected naming its own path. Both keys SHALL appear in `config.schema.json`, including
`alarmSwitchAlarm`'s nested properties.

#### Scenario: Partial alarm object

- **WHEN** config contains `alarmSwitchAlarm: { duration: 30 }`
- **THEN** the parsed value is `{ duration: 30, vibrationIntensity: 100, vibrationPattern:
  'double' }`

#### Scenario: Out-of-range intensity

- **WHEN** config contains `alarmSwitchAlarm: { vibrationIntensity: 101 }`
- **THEN** parsing fails with an issue at `alarmSwitchAlarm.vibrationIntensity`
