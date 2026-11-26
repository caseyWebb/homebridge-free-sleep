## 1. Thermostat mode aliases

- [x] 1.1 Declare `TargetHeatingCoolingState` valid values `[OFF, HEAT, COOL, AUTO]`, off first
  — verified by the `properties declared at construction` unit test and a `handleSetRequest`
  test showing HAP accepts HEAT and COOL.
- [x] 1.2 Map any non-OFF mode write to `isOn: true` — verified by the `HEAT`/`COOL` cases in
  `writes map to minimal patches (4.1)`.
- [x] 1.3 Replace a stored HEAT/COOL with AUTO ~500 ms after an accepted write, skipped once the
  side is off, cleared by `stop()` — verified by the `HEAT/COOL aliases are normalized to AUTO`
  unit tests.
- [x] 1.4 Rewrite `docs/HOMEKIT.md`'s mode-list section — verified by reading it.

## 2. Verification on hardware

- [ ] 2.1 Deploy to the Pi; confirm in the Homebridge log that the bridge's configuration number
  increments and the home hub re-fetches `/accessories` — manual check.
- [ ] 2.2 In the Home app, choose Heat for one side: the side turns on (Pod log shows an
  `isOn: true` write), and the picker returns to Auto — manual check against the Pod.
- [ ] 2.3 Tile tap off/on for both sides works — manual check in the Home app.
