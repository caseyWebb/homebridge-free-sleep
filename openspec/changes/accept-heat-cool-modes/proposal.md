## Why

On 2026-11-26 both bed sides showed "This accessory is not responding" in the Home app, before
any controls appeared, while their temperatures kept updating. A HAP request log showed the
cause: tapping a thermostat tile makes the Home app re-send the mode it last remembered for that
accessory, and for the affected side that was **heat** (`TargetHeatingCoolingState = 1`),
remembered from an older accessory database. `thermostat-service` declares the mode's valid
values as `[OFF, AUTO]`, so HAP refused every tap with `INVALID_VALUE_IN_REQUEST` before `onSet`
ran, and the Home app turned that refusal into "not responding" for the whole side. Choosing
Auto explicitly in the detail view recovered it by hand; nothing on the plugin side could.

`docs/HOMEKIT.md` had anticipated a narrower version of this (Siri saying "set the bed to heat")
and judged it not worth widening the list. The tile-tap failure changes that trade-off.

## What Changes

- `TargetHeatingCoolingState` declares `[OFF, HEAT, COOL, AUTO]` (off still first).
- A heat or cool write is treated exactly like automatic: `isOn: true` for that side.
- Reads keep reporting only off or automatic, and ~500 ms after an accepted heat/cool write the
  stored value is replaced with automatic, so the mode the Home app remembers converges on
  automatic.
- `docs/HOMEKIT.md`'s section on the mode list is rewritten around the observed failure.

## Non-goals

- No new config key: refusing heat/cool has no benefit worth opting into, and its failure mode
  is a side that cannot be controlled from its tile.
- No per-mode behaviour on the Pod (heat-only / cool-only): free-sleep has one setpoint per
  side and no mode concept.
- Not addressing why the Home app's accessory database was stale.

## Impact

- free-sleep endpoints: `POST /api/deviceStatus` only, with the same `{ <side>: { isOn } }`
  body the automatic write already sends. No settings or schedules write; nothing expensive.
- The published accessory database changes (new valid values), so the bridge's HAP
  configuration number increments on the first launch with this change and controllers re-fetch
  it.
- The Home app's mode picker shows Heat and Cool; choosing one turns the side on and the picker
  snaps back to Auto.
