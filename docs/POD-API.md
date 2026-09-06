# free-sleep Pod API — verified notes

Everything here was read out of [`free-sleep`](https://github.com/throwaway31265/free-sleep)
at version **2.1.5** (commit `dc0c710`, 2026-05-14). Paths are relative to that repo.

Re-verify against your own Pod before trusting any of it — and if you change a claim here,
cite the file you read.

The API lives at `http://<pod-ip>:3000/api/` and has **no authentication of any kind**.
CORS is the only origin check and it explicitly allows requests with no `Origin` header
(`server/src/setup/middleware.ts`), so any script on the LAN has full control. Keep port
3000 off the WAN.

---

## Endpoints we use

### `GET /api/deviceStatus`

**Expensive.** Every call is a live round-trip to the hardware over a Unix domain socket
(`server/src/routes/deviceStatus/deviceStatus.ts` → `franken.getDeviceStatus()`). Requests
are serialised through a queue with a 10 s response timeout and a 25 s connection timeout
(`server/src/8sleep/frankenServer.ts`).

```jsonc
{
  "left":  { "currentTemperatureLevel": -43, "currentTemperatureF": 71,
             "targetTemperatureF": 64, "secondsRemaining": 0,
             "isOn": false, "isAlarmVibrating": false },
  "right": { /* same shape */ },
  "waterLevel": "true",          // STRING, not bool
  "isPriming": false,
  "settings": { "v": 1, "gainLeft": 400, "gainRight": 400, "ledBrightness": 0 },
  "coverVersion": "Pod 3", "hubVersion": "Pod 3",
  "freeSleep": { "version": "2.1.5", "branch": "main" },
  "wifiStrength": 52
}
```

Notes, all from `server/src/8sleep/loadDeviceStatus.ts` unless stated:

- `isOn` is **derived**, not reported: `secondsRemaining > 0`.
- `currentTemperatureF` comes from a −100..100 hardware "level":
  `level === 0 ? 83 : round(82.5 ± (|level|/100) * 27.5)`.
- `isAlarmVibrating` does **not** come from the device. It is an in-memory flag set by
  `executeAlarm` and cleared by a `setTimeout` (`server/src/jobs/alarmScheduler.ts`), so it
  is lost on restart.
- `waterLevel` is the string `"true"` or `"false"`. **`"false"` means the tank is low or
  empty** (`app/src/pages/ControlTempPage/WaterNotification.tsx`). free-sleep itself warns
  on any other value, so treat anything unexpected as unknown rather than as "low".
- `taps` (`doubleTap`/`tripleTap`/`quadTap` counters, Pod 4/5 only) is **never present in
  the HTTP response**. `Franken.getDeviceStatus(getGestures = false)` defaults gestures off
  (`server/src/8sleep/frankenServer.ts:89`) and the route calls it with no argument. Only the
  in-process `FrankenMonitor` requests them.
- `wifiStrength` is refreshed by an `nmcli` shell-out on a 10 s interval in `server.ts`.

### `POST /api/deviceStatus` → `204`

Deep partial of the read shape. Semantics from
`server/src/routes/deviceStatus/updateDeviceStatus.ts`:

| Field | Behaviour |
|---|---|
| `targetTemperatureF` | Integer **55–110 °F** (zod-validated). Converted to a level as `round((F - 82.5) / 27.5 * 100)`. |
| `isOn: true` | Sets the heat duration to `'43200'` — **12 hours**, then the side turns itself off. |
| `isOn: false` | Sets duration to `'0'`. |
| `secondsRemaining` | Sets an arbitrary duration. This is the hook for a keep-alive. |
| `isAlarmVibrating: false` | Sends `ALARM_CLEAR`. `true` is unsupported and logged as such. |
| `isPriming: true` | Sends `PRIME`. |
| `settings` | Key-remapped (`ledBrightness`→`lb`, `gainLeft`→`gl`, `gainRight`→`gr`), CBOR-encoded, sent as `SET_SETTINGS`. |

**Away-mode coupling.** `const controlBothSides = settings.left.awayMode || settings.right.awayMode;`
— if *either* side is in away mode, a write addressed to one side is applied to **both**.

**Settings must be posted whole.** `updateSettings` CBOR-encodes exactly the keys it is
given, so posting a bare `{ledBrightness: 30}` risks dropping `v` and the piezo gains that
the biometrics pipeline depends on. free-sleep's own UI merges into a clone of the current
settings and posts the entire object
(`app/src/pages/SettingsPage/DeviceSettingsSection/LedBrightnessSlider.tsx`).

### `GET|POST /api/settings`

Cheap LowDB JSON read. **Writes are expensive** — see the job-rebuild warning below.

```jsonc
{ "id": "<uuid>", "timeZone": "America/Los_Angeles",
  "temperatureFormat": "fahrenheit", "rebootDaily": false,
  "primePodDaily": { "enabled": false, "time": "14:00" },
  "left":  { "name": "...", "awayMode": false,
             "scheduleOverrides": {
               "temperatureSchedules": { "disabled": false, "expiresAt": "" },
               "alarm": { "disabled": false, "timeOverride": "", "expiresAt": "" } },
             "taps": { /* doubleTap|tripleTap|quadTap gesture config */ } },
  "right": { /* same */ } }
```

POST is a deep partial `_.merge`; `id` is stripped.

- **`awayMode` is the real per-side "pause everything" switch.** `powerScheduler.ts:18,91`,
  `temperatureScheduler.ts:45` and `alarmScheduler.ts:127` all return early when it is set.
- **`scheduleOverrides.alarm` skips alarms via `expiresAt`, not `disabled`.** The recurring
  alarm job checks only whether `expiresAt` is in the future and skips if so
  (`alarmScheduler.ts:148-153`). `disabled` is read solely by `scheduleAlarmOverride`, which
  implements the separate "move tonight's alarm to a different time" feature.
- **`scheduleOverrides.temperatureSchedules` is dead config.** It appears only in
  `server/src/db/settings.ts` (defaults), `server/src/db/settingsSchema.ts` (the type) and
  the app's mock data. No job reads it. Anything bound to it silently does nothing.

### `GET|POST /api/schedules`

Per side, per weekday. **Writes are expensive.** We read it only to know when the next alarm
is due.

```jsonc
{ "left": { "monday": {
    "temperatures": { "22:00": 70, "02:00": 68 },   // "HH:mm" -> integer °F
    "power": { "on": "21:00", "off": "07:00", "onTemperature": 75, "enabled": true },
    "alarm": { "time": "06:45", "vibrationIntensity": 60, "vibrationPattern": "rise",
               "duration": 60, "enabled": true, "alarmTemperature": 80 } },
    /* ...rest of week */ }, "right": { /* ... */ } }
```

`vibrationPattern` is `'double' | 'rise'`; `duration` is **0–180 seconds** (floored at 10 at
execution time); `vibrationIntensity` is 1–100.

### `POST /api/alarm`

Fires an alarm immediately. `{ side, vibrationIntensity, vibrationPattern, duration, force? }`.
Without `force`, `executeAlarm` silently no-ops when the side is off or in away mode
(`server/src/jobs/alarmScheduler.ts:17-34`). Returns `200` with the whole schedules DB.

### `GET|POST /api/metrics/presence`

In-memory only, resets on server restart (`server/src/routes/metrics/presence.ts`).

```jsonc
{ "left": { "present": false, "lastUpdatedAt": "2026-09-06T03:12:00-07:00" },
  "right": { "present": true,  "lastUpdatedAt": "..." } }
```

**This is populated in near-real time** — but only by the Python biometrics stream.
`BiometricProcessor._update_presence_api` POSTs transitions to
`http://127.0.0.1:3000/api/metrics/presence` as it detects them from the piezo signal
(`biometrics/stream/biometric_processor.py`). So occupancy requires:

1. biometrics enabled (`scripts/enable_biometrics.sh`, service `free-sleep-stream`), and
2. the Pod firewalled off from Eight Sleep's cloud, since the `.RAW` sensor files only exist
   in that case.

After the Pod's daily reboot it reports `present: false` until the next real transition —
that is "unknown", not "bed is empty".

### `GET /api/metrics/vitals?side&startTime&endTime`

SQLite rows `{ side, timestamp, heart_rate, hrv, breathing_rate }`, written every 60 s by the
Python stream. Same biometrics prerequisites as presence. Upstream only considers **heart
rate** validated; HRV and breathing rate are explicitly unvalidated (`README.md`).

### `GET /api/services`

`{ biometrics: { enabled, jobs: {...} }, sentryLogging: { enabled } }`. We read
`biometrics.enabled` to decide whether presence/vitals are worth polling.

### `GET /api/serverStatus`

Per-subsystem health. Useful for diagnostics and for distinguishing "Pod rebooting" from
"free-sleep is broken".

---

## Endpoints we deliberately do not use

- **`POST /api/jobs`** — `['reboot', 'update', 'analyzeSleep*', 'biometricsCalibration*']`.
  A stray HomeKit automation must not be able to reboot or self-update the bed.
- **`POST /api/execute`** — raw passthrough to the hardware command table. Validates only
  that `command` is a known key; `arg` is unvalidated.
- **`GET /api/logs/:filename`** — SSE, but logs only. The only streaming endpoint that exists.

---

## The four things that shape the whole plugin

1. **`GET /api/deviceStatus` is expensive.** Homebridge fires `onGet` for every
   characteristic when the Home app opens. With two sides and a dozen services that is dozens
   of calls. So: one shared poller, one cached snapshot, and `onGet` handlers that read the
   cache synchronously and never fetch. Push changes with `updateCharacteristic`.

2. **Settings and schedule writes rebuild every job on the Pod.** `jobScheduler.ts` chokidar-
   watches the LowDB folder and, on any change to `settingsDB.json` or `schedulesDB.json`,
   cancels every `node-schedule` job and recreates them all. So settings writes must be rare
   and user-initiated — never a side effect of polling or reconciliation.

3. **"On" is a 12-hour timer.** `isOn: true` writes a 43200 s duration. Without a keep-alive
   that re-posts `secondsRemaining`, a side HomeKit believes is on will quietly turn itself
   off overnight.

4. **The Pod reboots daily** (`settings.rebootDaily`, plus a reboot job scheduled 1 h before
   the daily prime in `server/src/jobs/primeScheduler.ts`). Losing the connection is a normal
   state to be handled with backoff and HAP "No Response", not an error path.

## Useful upstream bits

- `server/API.md` — endpoint docs. Slightly stale; the zod schemas are authoritative.
- `server/src/routes/deviceStatus/deviceStatusSchema.ts`, `server/src/db/settingsSchema.ts`,
  `server/src/db/schedulesSchema.ts` — the real contracts.
- `app/src/mocks/mockData.ts` + `app/src/mocks/handlers.ts` — a 599-line **stateful in-memory
  Pod mock** with MSW handlers covering every endpoint. Worth vendoring as our test double
  rather than hand-writing one.
- `AGENTS.md` — upstream's own orientation doc.
