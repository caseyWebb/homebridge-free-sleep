## Context

`src/services/thermostat.ts` restricted `TargetHeatingCoolingState` to `[OFF, AUTO]`. HAP
enforces `validValues` on client writes (`Characteristic.validateClientSuppliedValue` throws,
surfaced as `INVALID_VALUE_IN_REQUEST`) before the plugin's `onSet` handler runs, so the plugin
cannot intercept or translate a refused mode — the list itself has to change.

Observed on a paired device (Homebridge 2.4.0, home hub HomePod `AudioAccessory11,1` on OS
27.2.1, 2026-11-26): the left side's tile tap sent `3` (AUTO) and worked; the right side's tile
tap sent `1` (HEAT) every time and was refused, and the Home app showed the whole right side as
not responding without opening its controls. Writing AUTO from the detail view worked, and the
tile then worked too.

## Decisions

**Accept HEAT and COOL as aliases of AUTO.** The Pod has one target temperature per side and
heats or cools toward it on its own (free-sleep `server/src/routes/deviceStatus/updateDeviceStatus.ts`
translates `isOn` into a temperature duration; it has no mode). So any non-OFF mode maps to
`isOn: true` — the same body the AUTO write already submits.

**Keep reporting only OFF or AUTO.** `CurrentHeatingCoolingState` already conveys whether the
Pod is heating or cooling (the sticky deadband). Echoing HEAT/COOL back as the target would
imply the Pod is locked to a direction, which it is not.

**Normalize the stored value to AUTO after an accepted HEAT/COOL write.** HAP stores the
client-supplied value after `onSet` resolves, so `onGet` returning AUTO is not enough — the
characteristic's `.value` (and what subscribed controllers were told) stays HEAT. A 500 ms timer
(the same shape and delay as the existing away-mode tile revert) calls `updateValue(AUTO)` if the
stored value is still HEAT/COOL and the mode shadow still says on. This also retrains the Home
app's remembered mode toward AUTO. The timer is cleared by `stop()`.

Alternative considered: a config key, default off, as `docs/HOMEKIT.md` once suggested.
Rejected — the default would keep the failure that motivated this change.

## Risks / Trade-offs

- The Home app's mode picker shows Heat and Cool; picking either turns the side on and the
  picker returns to Auto about half a second later. Cosmetic.
- Needs confirmation on a paired device: that the Home app accepts the post-write AUTO update
  without re-sending HEAT, and that tile taps after the configuration-number bump send a mode
  this service accepts.
