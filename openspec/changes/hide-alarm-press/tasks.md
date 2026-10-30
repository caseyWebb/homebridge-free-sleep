## 1. Implementation

- [x] 1.1 `src/config.ts`: `alarmPressEvent` boolean, default `true`; `config.schema.json`
      entry. Verified by `test/config.test.ts` (default, non-boolean rejected, UI parity).
- [x] 1.2 `src/services/alarm.ts`: optional press service; no `SINGLE_PRESS` when hidden.
      Verified by `test/services/alarmStart.test.ts` ("alarmPressEvent: false": no
      `StatelessProgrammableSwitch` on the accessory, a start fires no press, the dismiss switch
      still works).
- [x] 1.3 `src/platform.ts`: subtype omitted from the prune table when hidden. Verified by
      `test/platform.wiring.test.ts` ("hide-alarm-press": `true -> false` prunes the button on
      restore and leaves the dismiss switch; default keeps it).
- [x] 1.4 README row, `docs/HOMEKIT.md` bullet, `CHANGELOG.md`. Verified by reading.

## 2. Manual

- [ ] 2.1 On the Pi, set `alarmPressEvent: false`, restart, confirm the "Alarm" button tile is
      gone from both side accessories in the Home app and the Alarm switch still toggles.
