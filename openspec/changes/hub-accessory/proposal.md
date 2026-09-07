## Why

The hub accessory (`Pod`) today publishes only the connection sensor (`thermostat-and-offline`,
#9/#11). Issue #20 asks for the rest of docs/HOMEKIT.md's hub-only service table: a water-low
sensor, a prime switch, an LED brightness lightbulb, a manual test-alarm switch, and a
server-fault sensor. None of these touch the per-side thermostat; all of them are read from data
the plugin already polls (`waterLevel`, `isPriming`, `settings.ledBrightness`) or from two Pod
endpoints this plugin has never called before (`POST /api/alarm`, `GET /api/serverStatus`).
Four of the five are loud, rare, or one-way operations (docs/HOMEKIT.md's table: LED pollutes
the Home app's Lights category and responds to "turn off all the lights"; Prime is loud and
runs for minutes with no stop command; Test Alarm can fire a bed vibration at 3 a.m.; Server
Fault is diagnostic-only) — each ships **off by default**, opt-in per config key. The water-low
sensor ships **on by default**, unconditionally, the same way the connection sensor already
does, because a dry/low tank is exactly the kind of thing a user wants a notification for
without having to discover a config flag first.

## What Changes

- Add a "Pod Water Low" `ContactSensor` to the hub, always published. Driven by
  `interpretWaterLevel(waterLevel)` (`src/pod/types.ts`, already shipped): `'ok'` → contact
  detected, `'low'` → contact not detected, `'unknown'` → hold the last reported contact state
  and raise `StatusFault`. `waterLowSensorType: 'contact' | 'leak'` (`src/config.ts`, shipped as
  a reserved, no-effect key by `platform-foundation`) **goes live**: `'leak'` publishes a
  `LeakSensor` instead, same derivation. **Decision**: issue #20's body also names a third
  `'none'` value; this change does not add it — see design.md's first resolution.
- Add a "Pod Prime" `Switch` to the hub, config-gated (new key `primeSwitch`, default `false`).
  `On` write submits `{isPriming: true}`; `On` reads and pushes reflect the already-shipped
  `EffectiveSnapshot.isPriming` (`src/pod/snapshot.ts`) once `src/platform.ts`'s
  `handleSnapshotChanges` starts routing the already-existing `'isPriming'` `DeviceChangeField`
  to it. Writing `Off` is refused (the Pod has no stop command) rather than sent and reverted.
  **Requires a `src/pod/writeQueue.ts` change**: the `device` lane's dispatch currently always
  wraps its patch as `{settings: patch}`; it must widen to also carry a bare top-level
  `isPriming` field. See design.md for the exact shape.
- Add a "Pod LED" `Lightbulb` (`On` + `Brightness`) to the hub, config-gated (new key
  `ledLightbulb`, default `false`). `Brightness` maps 1:1 to `settings.ledBrightness` (0–100, no
  `setProps` scaling). Every write read-modify-writes the full four-key `settings` object
  (`v`, `gainLeft`, `gainRight`, `ledBrightness`) through the existing `device` lane /
  `WriteQueue.submitDeviceSettings` / `PodClient.postDeviceStatus` path — confirmed cheap (a
  `SET_SETTINGS` device command over the socket, not the LowDB-backed, job-rebuilding
  `POST /api/settings`). `On=true` with no prior `Brightness` write restores
  `accessory.context.lastNonZeroBrightness ?? 100`. The device lane's debounce is widened to a
  new, dedicated minimum for this lane specifically (500 ms+, per issue #10's own note on this
  feature) — see design.md.
- Add two per-side "Test Alarm Left"/"Test Alarm Right" `Switch`es to the hub, config-gated
  (new key `testAlarmSwitch`, default `false`, gating both), momentary/stateless. **Revised (G0,
  tech-lead ruling, PR #44 review)** from an original single both-sides switch: a hub-level
  trigger firing on both sides risked vibrating a sleeping partner's side as a side effect of
  testing the other. `On` write calls a new `PodClient.postAlarm` method (`POST /api/alarm`,
  `{side, vibrationIntensity, vibrationPattern, duration, force: true}`) for that switch's own
  side only; each switch's own tile reverts to `Off` roughly a second later regardless of the
  write's outcome — there is no reliable, timely way to confirm the physical alarm fired (see
  design.md). This is a genuinely new, non-idempotent write: `PodClient` must not apply its
  existing retry-on-network-error/5xx policy to it.
- Add a "Pod Server Fault" `ContactSensor` to the hub, config-gated (new key
  `serverFaultSensor`, default `false`). Backed by a new `GET /api/serverStatus` poll (new
  `PodClient.getServerStatus`, new `SnapshotStore` raw slot, new poller endpoint class on the
  existing slow cadence) and a derived "any subsystem reports `'failed'`" boolean.
- `src/platform.ts`: `enabledServiceKeysFor('hub', …)` and `constructServicesFor('hub', …)` grow
  to include the water-low sensor unconditionally and the other four behind their new config
  keys; `handleSnapshotChanges` routes `isPriming`, `waterLevelState`, and the new server-fault
  field to their services.
- `src/config.ts` / `config.schema.json`: four new boolean keys (`primeSwitch`, `ledLightbulb`,
  `testAlarmSwitch`, `serverFaultSensor`, all defaulting to `false`); `waterLowSensorType`'s
  doc comment and UI title move from "reserved, no effect yet" to describing live behavior
  (mirrors `away-mode-guard`'s precedent for `awayModeWritePolicy`). One new advanced timing key
  for the LED lane's debounce (see design.md for its exact home).
- `test/mockPod.ts`: `POST /api/alarm` and `GET /api/serverStatus` handlers, a
  `test/fixtures/serverStatus.json` fixture (all-healthy default), and `isPriming` write
  semantics matching upstream's own no-op-on-`false` behavior.

## Capabilities

### New Capabilities
- `hub-accessory`: the five services this change adds to the hub accessory — their HomeKit
  shape, default exposure, read derivation, and write behavior.

### Modified Capabilities
- `platform`: the hub's enabled-service set is no longer fixed by role alone — it now depends on
  four new config keys, and the restore/prune requirement gains four new prunable services.
- `config`: `waterLowSensorType` moves from reserved-and-unused to consumed; four new keys
  (`primeSwitch`, `ledLightbulb`, `testAlarmSwitch`, `serverFaultSensor`) are added, each
  defaulted and validated like every other key this schema defines.
- `pod-client`: two new endpoints (`GET /api/serverStatus`, `POST /api/alarm`), a new vendored
  `ServerStatus`/`AlarmRequest` contract, and a new requirement that a specific write
  (`postAlarm`) is never retried.
- `pod-poller`: a fifth polled endpoint class (`serverStatus`), on the existing slow cadence.
- `pod-snapshot`: a new watched device-level field (server-fault, derived from `serverStatus`).
- `pod-write-queue`: the `device` lane widens to carry a bare `isPriming` field alongside
  `settings`, and gains a per-lane debounce override distinct from the shared default.
- `pod-test-double`: the mock gains `POST /api/alarm` and `GET /api/serverStatus` handlers and a
  fifth fixture.

## Impact

- **New files**: `src/services/waterLow.ts`, `src/services/prime.ts`, `src/services/led.ts`,
  `src/services/testAlarm.ts`, `src/services/serverFault.ts`; `test/fixtures/serverStatus.json`.
- **Modified**: `src/platform.ts`, `src/config.ts`, `config.schema.json`, `src/pod/types.ts`,
  `src/pod/client.ts`, `src/pod/writeQueue.ts`, `src/pod/snapshot.ts`, `src/pod/poller.ts`,
  `src/services/types.ts`, `test/mockPod.ts`.
- **Endpoints touched**: `GET /api/deviceStatus` (existing, already-polled — no new poll cadence;
  reads `waterLevel`, `isPriming`, `settings.ledBrightness`), `POST /api/deviceStatus` (existing
  endpoint, new payload shapes — a bare `isPriming` field and a full `settings` object — both are
  device commands over the socket, **not** a LowDB write, so neither triggers the Pod's job
  rebuild), `POST /api/alarm` (**new** to this plugin; cheap, fire-and-forget, **non-idempotent**
  — no retry), `GET /api/serverStatus` (**new** to this plugin; not free — a real SQLite
  round-trip on every call upstream — polled on the existing ~5-minute slow cadence, never the
  ~30 s device-status cadence). **No `POST /api/settings` or `POST /api/schedules` write is
  introduced anywhere in this change** — nothing here rebuilds the Pod's scheduled jobs.
- **Tests**: no live Pod writes; everything runs against `test/mockPod.ts` plus fake-timer unit
  tests, matching every prior change's testing convention.

## Non-goals

- No scheduled-alarm changes. "Test Alarm" is a manual, user-initiated trigger; the *scheduled*
  alarm feature (docs/HOMEKIT.md's "Alarm ringing" section — a `StatelessProgrammableSwitch` plus
  a "Dismiss Alarm" `Switch`, tracked separately, #16) is untouched by this change.
- No occupancy (`occupancySource`, #19) and no heart-rate/HRV/breathing vitals — both explicitly
  out of scope per docs/HOMEKIT.md ("nothing in v1").
- No change to `wifiStrength` handling — it remains logged only, per its existing documentation
  (`docs/POD-API.md`, `docs/HOMEKIT.md`): a boot-time constant from a client's perspective, never
  worth building a characteristic on.
- No change to the per-side `Thermostat` or the existing "Pod Connection" `ContactSensor` beyond
  the platform-wiring extension points (`enabledServiceKeysFor`, `constructServicesFor`,
  `handleSnapshotChanges`) every hub service already shares.
- No attempt to make `POST /api/alarm` idempotent, retried, or synchronously confirmable. The
  route is fire-and-forget upstream (`server/src/routes/alarm/alarm.ts`: `void executeAlarm(...)`
  before responding) — this change treats that as a hard constraint, not something to paper over
  with client-side retries or a fabricated confirmation signal.
- No widening of `waterLowSensorType`'s enum to add a `'none'` value, despite issue #20's body
  naming one — see design.md's first resolution.
