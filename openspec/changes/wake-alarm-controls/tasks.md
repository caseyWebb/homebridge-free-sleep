## 1. Config

- [x] 1.1 Add `WakeAlarmFieldsSchema`/`WakeAlarmSchema` (fully-specified default) and the four
      keys `wakeAlarmSwitch`, `wakeAlarm`, `snoozeSwitch`, `snoozeTemperatureDeltaF` to
      `src/config.ts`. Verified by `test/config.test.ts` ("wake-alarm-controls keys": defaults,
      partial `wakeAlarm` fill-in, every bound rejected with the right path, non-zero delta).
- [x] 1.2 Add matching `config.schema.json` entries (nested `wakeAlarm` with `oneOf` for the
      pattern). Verified by the existing top-level parity test plus a new
      `wakeAlarm.properties` ↔ `WakeAlarmFieldsSchema.shape` parity test.

## 2. Wake Alarm switch

- [x] 2.1 `src/services/wakeAlarm.ts`: per-side momentary `Switch` (`wakeAlarm` subtype,
      `ConfiguredName` "Wake Alarm"), ON → `postAlarm` with `config.wakeAlarm` + `force: true`,
      rejection → `SERVICE_COMMUNICATION_FAILURE` + `warn`, ~1 s self-reset, `stop()`. Verified
      by `test/services/wakeAlarm.test.ts` (construction/restore, defaults and overrides posted,
      other side never fired, failure surfaced, self-reset on both outcomes, `stop()` clears).

## 3. Snooze switch

- [x] 3.1 `src/services/snooze.ts`: pure `snoozePatch(current, delta)` + per-side momentary
      `Switch` (`snooze` subtype, `ConfiguredName` "Snooze"), ON → one `submitSide`, error
      mapping, ~1 s self-reset, `stop()`. Verified by `test/services/snooze.test.ts`
      (`snoozePatch` stacking/clamping/rounding/no-target; peeled dismiss + remainder on the
      wire; configured delta; two presses stack on the effective target; other side untouched;
      no-target degrades to dismiss + warning; failure → `SERVICE_COMMUNICATION_FAILURE`;
      `'block'` + partner away → dismiss lands, bump refused as `NOT_ALLOWED_IN_CURRENT_STATE`;
      self-reset on both outcomes; `stop()` clears).

## 4. Platform wiring

- [x] 4.1 `src/platform.ts`: imports, `enabledServiceKeysFor` side entries, per-side maps,
      construction in `constructServicesFor`, `stop()` on shutdown; `serviceName.ts` labels.
      Verified by `test/platform.wiring.test.ts` ("wake-alarm-controls": neither by default,
      each independently, hub untouched, `sides: 'right'` only, prune on true→false, restore
      without duplication on false→true, shutdown clears both reset timers).

## 5. Docs

- [x] 5.1 README feature bullet + config-table rows; `docs/HOMEKIT.md` new section + two
      `ConfiguredName` rows; `docs/POD-API.md` dismiss-row caveat (upstream #54 / the fork);
      `CHANGELOG.md` `[Unreleased]`. Verified by reading.

## 6. Manual verification (real Pod + Home app) — open

- [ ] 6.1 Enable both switches in the Pi's Homebridge config, confirm both tiles appear under
      the right-side accessory with the labels "Wake Alarm" and "Snooze".
- [ ] 6.2 Tap Wake Alarm: Pod vibrates at the configured parameters; "Dismiss Alarm" turns on
      within one alarm-poll interval. Tap Snooze: vibration stops within ~1 s, Thermostat target
      rises by 10 °F. Tap Dismiss Alarm + set Thermostat Off: vibration stops, side turns off.
- [ ] 6.3 Rebuild the three Shortcuts automations on the iPhone's Sleep alarm triggers using
      "Control Home" actions only, and confirm a dismiss away from the home LAN no longer errors.
