## ADDED Requirements

### Requirement: `alarmPressEvent` is validated, defaulted, and consumed

`alarmPressEvent` SHALL be a boolean defaulting to `true`, rejected with its own path when
mistyped, and present in `config.schema.json`.

#### Scenario: Default

- **WHEN** config omits `alarmPressEvent`
- **THEN** it parses as `true`
