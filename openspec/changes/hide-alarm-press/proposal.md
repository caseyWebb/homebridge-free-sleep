## Why

Each side accessory publishes an "Alarm" `StatelessProgrammableSwitch` so a HomeKit automation
can react to the bed starting to vibrate. In the Home app it renders as a button-shaped tile
that cannot be tapped, and a household whose wake-up is driven the other way round — the
iPhone's Sleep alarm starting the bed via the two-way Alarm switch (`alarm-switch-start`) —
triggers nothing from it. Today it can only be removed together with the Dismiss Alarm switch
and the alarm fast-poll scheduler (`alarmEvents: false`), which removes the controls that are
actually in use.

## What Changes

- New config key **`alarmPressEvent`** (boolean, default `true`). When `false`, `AlarmService`
  constructs no press service and fires no `SINGLE_PRESS`; `enabledServiceKeysFor` omits the
  `alarm-press` subtype so a cached button is pruned on restore. The dismiss switch, its
  two-way start mode, and `AlarmWindowScheduler` are untouched and still gated by `alarmEvents`.
- `config.schema.json`, README, `docs/HOMEKIT.md`, `CHANGELOG.md` updated.

## Endpoints touched

None. No Pod request changes; polling is unaffected.

## Capabilities

### Modified Capabilities
- `alarm-events`: the press service is published only when `alarmPressEvent` is `true`.
- `config`: adds `alarmPressEvent` as a consumed key.

## Non-goals

- No change to the dismiss switch, the fast-poll scheduler, or `alarmEvents`' own semantics.
- No new HAP service or subtype.
