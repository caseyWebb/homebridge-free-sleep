## Context

`AlarmService` (`src/services/alarm.ts`) owns both the press service and the dismiss switch
because they watch the same field. `FreeSleepPlatform.enabledServiceKeysFor` is the single prune
table: a cached service whose `(UUID, subtype)` is absent is removed on restore
(`pruneServices`), before `constructServicesFor` runs.

## Decisions

### 1. Gate inside `AlarmService`, not with a second class

Splitting the class would duplicate the rising-edge logic the `alarm-events` design deliberately
kept in one place. Instead `pressService` becomes `Service | undefined`: the constructor builds
it only when `config.alarmPressEvent` is `true`, and `handleChange`'s press branch returns early
when it is absent. Every other behaviour (B1 seed, B2 guard, dismiss writes, start mode) is
unchanged.

### 2. Prune via the existing table

Adding the subtype to `enabledServiceKeysFor` only when `alarmPressEvent` is on is all the
restore path needs; `pruneServices` already persists the removal (`updatePlatformAccessories`).
Re-enabling later re-adds the service through the normal `getServiceById ?? addService` path.

### 3. Default `true`

Existing installs keep their button and any automations built on it. No Pod behaviour is
involved, so nothing needs confirming on a real device beyond the Home app dropping the tile.
