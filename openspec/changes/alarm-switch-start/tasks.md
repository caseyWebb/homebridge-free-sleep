## 1. Config

- [x] 1.1 Add `AlarmSwitchAlarmFieldsSchema`/`AlarmSwitchAlarmSchema` (fully-specified default)
      and the keys `alarmSwitchStartsAlarm`, `alarmSwitchAlarm` to `src/config.ts`. Verified by
      `test/config.test.ts` ("alarm-switch-start keys": defaults, partial fill-in, every bound
      rejected with its path, non-boolean flag rejected).
- [x] 1.2 Matching `config.schema.json` entries (nested object with `oneOf` for the pattern).
      Verified by the existing top-level parity test plus a new nested-shape parity test.

## 2. Service

- [x] 2.1 `src/services/types.ts`: optional `requestAlarmPoll(untilMs): () => void`.
      `src/platform.ts`: provide it from `PodPoller.requestMode` at `alarmPollIntervalMs`.
      Verified by `test/platform.wiring.test.ts` ("alarm-switch-start: platform wiring": an ON
      write through the real platform posts the alarm with `force` and the tile reads on; the
      default config posts nothing).
- [x] 2.2 `src/services/alarm.ts`: `startAlarm()` on the ON write when the flag is on — awaited
      `postAlarm`, then start overlay (`max(10, duration)` s) and fast-poll request; failure →
      `SERVICE_COMMUNICATION_FAILURE` + revert; `stop()` clears overlay and releases the poll.
      Verified by `test/services/alarmStart.test.ts` (both sides: request shape and config
      overrides; press fires once; fast-poll window `now + duration + 30 s` and release on
      `stop()`; 10 s floor; self-off at the nominal end with nothing observed; raw agreement
      then raw-governed end; OFF after start dismisses and reads off at once; rejected post
      surfaces, warns, no press, no poll, reverts; works without `requestAlarmPoll`; timer
      hygiene) and the default-off path still accept-and-reverts.

## 3. Docs

- [x] 3.1 README feature bullet + two config rows; `docs/HOMEKIT.md` alarm-section bullet;
      `docs/POD-API.md` dismiss-row caveat; `CHANGELOG.md` `[Unreleased]`. Verified by reading.

## 4. Manual verification (real Pod + Home app) — open

- [ ] 4.1 On the Pi, set `alarmSwitchStartsAlarm: true` in the FreeSleep block, restart, rename
      the right side's "Dismiss Alarm" tile to "Alarm" in Home.
- [ ] 4.2 Tap Alarm on: Pod vibrates at 180 s / 100 / double; tile stays on; after ~3 min it turns
      itself off. Tap Alarm on, then off after ~10 s: vibration stops within ~1 s, tile off.
- [ ] 4.3 Rebuild the three Shortcuts automations on the iPhone's Sleep-alarm triggers from Home
      actions only (on; off + Thermostat warmer; off + Thermostat Off) and confirm a dismiss away
      from the home LAN no longer errors.
