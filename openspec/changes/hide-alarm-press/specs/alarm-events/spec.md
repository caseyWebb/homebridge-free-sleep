## ADDED Requirements

### Requirement: The alarm-press button is published only when `alarmPressEvent` is on

With `alarmEvents` on, the per-side alarm-press `StatelessProgrammableSwitch` SHALL be published
only when `alarmPressEvent` is `true` (the default). When `false`, no press service SHALL exist
on either side accessory, a cached one SHALL be pruned on restore, and no `SINGLE_PRESS` SHALL
ever be fired; the dismiss switch and the alarm fast-poll scheduler SHALL be unaffected.

#### Scenario: Hidden

- **WHEN** `alarmPressEvent` is `false` and the Pod is observed starting to vibrate
- **THEN** no press event fires and the dismiss switch still turns on

#### Scenario: Pruned on restore

- **WHEN** a cached side accessory carrying the button is restored with `alarmPressEvent: false`
- **THEN** the button is removed and the dismiss switch remains
