## Context

See proposal.md for motivation. This section only covers the shipped state the design builds
on, and the two upstream facts every decision below depends on.

**Already shipped, reused as-is:**
- `src/pod/snapshot.ts`'s `SnapshotStore`: a layered raw/overlay/effective model, a fixed
  enumeration of watched fields (`SideChangeField`/`DeviceChangeField`), an `OverlayableField`
  union (`'targetTemperatureF' | 'isOn' | 'isAlarmVibrating' | 'awayMode'`) keyed
  `${Side}:${OverlayableField}` — every overlay entry today is a **per-side** pin.
  `EffectiveSnapshot.isPriming` and the `'isPriming'` `DeviceChangeField` are already fully
  wired through `commit`/`diffWatched` (`openspec/specs/pod-snapshot/spec.md`'s "Watched fields"
  requirement already lists "priming state" as a device-level watched field) — only
  `src/platform.ts`'s `handleSnapshotChanges` doesn't route it to a service yet.
- `src/pod/poller.ts`'s `PodPoller`: a registry of endpoint-class descriptors
  (`registerClass`), each with its own base interval, `read`, `apply`, optional `recordFailure`
  and `enabled` predicate — `openspec/specs/pod-poller/spec.md` already describes this as
  "extensible... without altering the scheduling, jitter, backoff, or in-flight machinery."
  `handlePriming()` already puts the `deviceStatus` class into a `fastPollIntervalMs` (default
  5000 ms) fast-poll mode for as long as `snapshot.get().isPriming === true`.
- `src/pod/writeQueue.ts`'s `WriteQueue`: four lanes (`left`, `right`, `device`, `settings`),
  one shared `writeDebounceMs` (default 400, floor 100) applied identically to every lane in
  `submit()`, a `device` lane whose only shape today is `DevicePatch = Partial<{v, gainLeft,
  gainRight, ledBrightness}>`, dispatched unconditionally as `body = { settings: patch }`
  (`dispatch()`'s `lane === 'device'` branch). `settleWrite`'s `fastPollLane` is
  `'deviceStatus'` for every lane except `settings` — so a successful `device`-lane dispatch
  already requests the poller's `fastPollIntervalMs` window, exactly like a side write does.
- `src/services/connection.ts`: the `ContactSensor` pattern this change reuses five times —
  `ensureCharacteristic` for optional characteristics, `getServiceById`/`addService` with a
  subtype constant, a `wireReads()`/`refresh()` split, and the polarity convention "contact
  detected = the good state" (`docs/HOMEKIT.md`'s "Connection sensor: polarity... locked").
- `away-mode-guard`'s already-shipped precedent for "refuse a write client-side, never send it,
  then correct the tile ~500 ms later": `AwayModeBlockedError` (thrown before
  `writeQueue.submitSide` is even called) mapped to `HapStatusError(NOT_ALLOWED_IN_CURRENT_
  STATE)` in `src/services/thermostat.ts`'s `onSet` catch clauses, plus a retained,
  clearable `scheduleAwayModeRevert` timer.

**Upstream facts (`~/Code/free-sleep`, v2.1.5, `dc0c710`) this design turns on:**
- `updateDeviceStatus` (`server/src/routes/deviceStatus/updateDeviceStatus.ts`) only ever sends
  `PRIME` when `deviceStatus.isPriming` is truthy: `if (deviceStatus.isPriming) await
  executeFunction('PRIME');` — there is no `else` branch and no stop command. A `{isPriming:
  false}` patch is a **total no-op** upstream (parses, 204s, changes nothing) — this is a third
  instance of the same truthiness-guard pattern `docs/POD-API.md` already documents twice for
  `updateSide`.
- `updateSettings` (same file) CBOR-encodes exactly the keys it is given
  (`cbor.encode(_.mapKeys(settings, ...))`) and sends `SET_SETTINGS` — a device command over the
  Franken socket, not a `settingsDB.json` write. `docs/POD-API.md`'s "Settings must be posted
  whole" already documents this; this change is the first caller.
- `executeAlarm` (`server/src/jobs/alarmScheduler.ts`) silently returns — no error, no HTTP
  signal — when `settingsDB.data[side].awayMode` is true or the side is off, unless `force` is
  set. The route (`server/src/routes/alarm/alarm.ts`) calls `void executeAlarm(alarmJob)` and
  responds `200` **before** that promise settles: the HTTP response carries no information about
  whether the alarm actually ran. On the happy path, `executeAlarm` sets
  `memoryDB.data[side].isAlarmVibrating = true` and clears it after
  `Math.max(10, duration) * 1000` ms — so any successful trigger vibrates for **at least 10 real
  seconds**, regardless of the `duration` this plugin sends.
- `GET /api/serverStatus` (`server/src/routes/serverStatus/serverStatus.ts`) returns
  `serverStatus.toJSON()`, an in-memory singleton (`server/src/serverStatus.ts`) whose
  `toJSON()` does real work on every call: `updateDB()` runs `SELECT 1` +
  `PRAGMA quick_check` against SQLite (and can itself flip `database.status` to `'failed'`),
  `updateServices()` reads `servicesDB` and can flag a stale biometrics stream, then
  `updateSystemDate()` runs synchronously. Every other subsystem's status
  (`alarmSchedule`, `primeSchedule`, `powerSchedule`, `temperatureSchedule`, `jobs`,
  `frankenMonitor`, `franken`, `express`, `logger`, `rebootSchedule`) is set directly by its own
  job module on success/failure (`server/src/jobs/*.ts`, `server/src/8sleep/frankenMonitor.ts`,
  `server/src/server.ts`) — this is genuinely observed health data, continuously updated,
  not something this plugin has to fabricate a proxy for.

## Goals / Non-Goals

**Goals:**
- Ship all five hub services from docs/HOMEKIT.md's table with their documented default
  exposure, reusing every existing extension point (`enabledServiceKeysFor`,
  `constructServicesFor`, `handleSnapshotChanges`, the `SnapshotStore`/`WriteQueue`/`PodPoller`
  registries) rather than inventing a parallel mechanism.
- Extend `WriteQueue`, `SnapshotStore`, `PodPoller`, and `PodClient` only as far as this
  change's five services actually need, in a shape later changes can reuse without another
  structural change (e.g. a future device-scope overlay, if one is ever needed, generalizes
  cleanly from what this change adds).

**Non-Goals:**
- No optimistic overlay for any field this change writes (`isPriming`, `settings.*`). See
  Decision 2.
- No attempt to make the scheduled-alarm feature's polling (docs/HOMEKIT.md's "Scheduled
  fast-poll is mandatory" for #16) exist yet — that remains a separate, later change.
- No generalization of `SnapshotStore`'s per-side overlay keying to a device scope. Decision 2
  explains why this change doesn't need it and leaves the generalization to whichever future
  change actually needs sub-second device-scope write feedback.

## Decisions

### 1. `waterLowSensorType` stays a 2-value enum; the water-low sensor is unconditional

Issue #20's body names a third `waterLowSensorType: 'none'` value ("disable the sensor
entirely"). `src/config.ts` already ships this key as `z.enum(['contact', 'leak'])
.default('contact')` (`platform-foundation`, reconciled and shipped before this change existed).

**Resolution: keep the shipped 2-value enum.** The water-low `ContactSensor`/`LeakSensor` is
published unconditionally, whenever the hub accessory exists — the same way "Pod Connection" is
unconditional today (`src/platform.ts`'s `enabledServiceKeysFor('hub', ...)` already has no
config gate on it). `waterLowSensorType` chooses *which* HomeKit service type represents it, not
*whether* it exists.

Alternatives considered:
- **Widen the enum to `'contact' | 'leak' | 'none'`.** Rejected: it would be the first
  already-shipped, already-validated config key this project widens after release, and
  `src/config.ts`'s own module doc frames every reserved key's shape as a promise ("later
  changes add *behavior* behind an already-stable key, never a new key" — the inverse promise,
  not touching the *shape*, is implied by the same discipline). A user who wants no water-low
  notification at all can already achieve it in the Home app itself (hide the tile, or ignore
  it) without a config round-trip through Homebridge.
- **Add a separate `waterLowSensor: boolean` gate alongside the existing enum**, mirroring the
  other four new keys. Rejected for consistency with the *already-shipped* framing: the
  connection sensor — the hub's only other unconditional service — has no such gate either, and
  introducing one only for water-low would make the hub's "which services are always on" set
  inconsistent for no functional gain (docs/HOMEKIT.md's table lists water-low as "default on,"
  same category as connection, not "default off, opt-in" like the other four).

### 2. `isPriming` and LED `settings.*` get no optimistic overlay this change

Both are top-level/device-scope fields; `SnapshotStore`'s `OverlayableField` union and
`overlayKey(side, field)` scheme are per-**side** only (`src/pod/snapshot.ts`). Making either
field overlayable means generalizing that scheme to a device scope — a real structural change,
not a two-line addition (a new `OverlayKey` shape, a new `computeEffective` branch untied to
`computeSide`, a new commit/diff path).

**Resolution: don't generalize the overlay scheme in this change.** Rely instead on what's
already shipped and shared by every lane: `writeQueue.dispatch()`'s `fastPollLane` is
`'deviceStatus'` for the `device` lane exactly as it is for `left`/`right`, so a successful
Prime or LED write already triggers `poller.requestMode('deviceStatus', { intervalMs:
fastPollIntervalMs, ... })` — a ~5 s (default) confirming-poll window, not the ~30 s base
interval. This is evaluated differently per field:

- **`isPriming`**: acceptable outright. Issue #20 itself frames priming as "loud... runs for
  minutes" — a ~5 s worst-case gap between the write succeeding and the "Pod Prime" tile
  flipping to `On` is immaterial against a multi-minute operation, and `handlePriming()`
  (already shipped) then holds the poller in fast-poll for the operation's entire remaining
  duration, so the eventual `Off` transition (when the hardware finishes) is caught within the
  same ~5 s window too.
- **LED `Brightness`**: a real, accepted trade-off, not a non-issue. A brightness drag debounces
  at 500 ms+ (Decision 4) and then waits up to the same ~5 s fast-poll window before the Home
  app's slider visibly settles at the written value — unlike `TargetTemperature`'s instant
  optimistic feedback. This is worse UX than the thermostat's, but: (a) issue #20's own text for
  LED asks only for coalescing `On`+`Brightness` and a harder debounce, never optimistic
  feedback; (b) a `Lightbulb` slider settling within ~5 s reads as "the app is a little slow,"
  not as a stuck or reverted control, because nothing pushes a *disagreeing* value in the
  interim (the tile simply doesn't move until the poll confirms it) — no jitter, no snap-back.
  If this turns out to matter in practice, the fix is the same device-scope overlay
  generalization `isPriming` also stops short of; building it once, generically, for whichever
  field asks for it first is better than building two bespoke device-scope overlay paths now.

### 3. Writing `Off` to "Pod Prime" is refused client-side, never sent

Upstream has no PRIME-stop command (Context, above): a `{isPriming: false}` patch is a proven
no-op. Sending it and then reverting the tile would cost a network round trip to accomplish
nothing.

**Resolution:** mirror `away-mode-guard`'s already-shipped shape exactly. A new
`PrimeCannotBeStoppedError` (small, local to `src/services/prime.ts`, following
`AwayModeBlockedError`'s `new.target.name` pattern) is thrown from the `On` characteristic's
`onSet` handler *before* any call into `WriteQueue` when the written value is `false` — no
request of any kind. The `onSet` catch clause maps it to
`HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)` (the same status
`away-mode-guard` uses for its own client-refused write), and a retained, clearable
~500 ms timer (`scheduleAwayModeRevert`'s pattern, renamed for this service) re-pushes the
cached `isPriming` value so HAP's optimistic tile flip is corrected. `PrimeService.stop()`
clears that timer on shutdown, exactly as `ThermostatService.stop()` already does for its own
away-mode-revert timer — `src/platform.ts`'s `shutdown` handler calls it alongside the others.

Writing `On` while already priming is accepted as a harmless re-send (idempotent upstream: a
second `PRIME` command while priming is already the Pod's own business, not a case this plugin
special-cases).

### 4. The `device` lane gets its own debounce, `pollIntervals.deviceWriteDebounceMs`

Issue #10's own note: "Brightness drags (#20) need a harder debounce (500 ms+); each write
becomes a `SET_SETTINGS` CBOR command on the serialised socket" (`gh issue view 10`). Today
`WriteQueue`'s `writeDebounceMs` (default 400, floor 100) is one constructor value applied
identically to every lane's `submit()` call — raising it queue-wide would slow down every
side write's responsiveness (the thermostat's slider) to fix a problem specific to the device
lane's one write-heavy consumer (LED).

**Resolution:** add a second `WriteQueueOptions` field, `deviceWriteDebounceMs` (default 500,
enforced floor 500 — the exact number issue #10 names, not merely "at least the shared
default"), consulted only by the `device` lane inside `submit()`'s debounce-timer scheduling;
every other lane keeps using `writeDebounceMs` exactly as today. Config-wise, this is a new
field under the already-reserved `pollIntervals` override object
(`PollIntervalsFieldsSchema`, `src/config.ts`) — that object's own module doc already frames it
as "per-endpoint poll/write timing overrides," and this is exactly one more. `hub-accessory`
becomes that field's listed owner in `src/config.ts`'s "Consumed vs. reserved config keys"
table, the same way `poller-and-write-queue` and `thermostat-and-offline` already own the
others there.

Alternatives considered:
- **Reuse the shared `writeDebounceMs` for the device lane, raised project-wide to 500.**
  Rejected: no evidence the thermostat's own drag responsiveness should change to accommodate a
  feature (LED) most installs won't even enable (`ledLightbulb` defaults `false`).
  `test/pollBudget.test.ts`'s existing thermostat-drag assertions would also need to be
  reasoned about again for a value they were never written against.
- **A per-call debounce override on `submitDeviceSettings` itself**, letting `LedService` pass
  its own value. Rejected: `WriteQueue`'s debounce is a *queue-level* timing policy everywhere
  else (one value per lane, set at construction); a per-call override would be the only
  exception and would let a future device-lane caller silently fight the LED service's chosen
  cadence by passing a different value on the same lane.

### 5. LED writes always read-modify-write the whole four-key `settings` object

`updateSettings` CBOR-encodes exactly the keys it's given (Context, above) — a bare
`{ledBrightness: 30}` would drop `gainLeft`/`gainRight` and (per `docs/POD-API.md`) break the
biometrics pipeline's piezo gain settings.

**Resolution:** `LedService` never calls `submitDeviceSettings` with a partial object. Every
write reads `ctx.snapshot.get().documents.deviceStatus?.settings` (the full, already-cached
`{v, gainLeft, gainRight, ledBrightness}`) and submits a new object with only `ledBrightness`
replaced — the same "clone current, merge, post whole" shape
`app/src/pages/SettingsPage/DeviceSettingsSection/LedBrightnessSlider.tsx` uses upstream
(`docs/POD-API.md`). If no `deviceStatus` has ever been observed yet (a brand-new launch racing
the bootstrap poll), the write is refused with `SERVICE_COMMUNICATION_FAILURE` rather than
guessing values for the three fields it isn't changing — sending a guessed `v`/`gainLeft`/
`gainRight` risks silently corrupting a gain the biometrics stream depends on, which is a worse
failure than a rejected write the user can retry once the cache is warm (bootstrap is bounded
at `bootstrapTimeoutMs`, default 10 s, so this window is short-lived).

`On=true` with no explicit `Brightness` in the same HomeKit write restores
`accessory.context.lastNonZeroBrightness ?? 100` (persisted the same way the thermostat's
`publishedF` shadow already is, per `docs/HOMEKIT.md`). `On=false` writes `ledBrightness: 0`
(no separate on/off bit exists in `settings` — brightness *is* the power state, matching
upstream's own `LedBrightnessSlider.tsx` model, cited in `docs/POD-API.md`).

### 6. "Pod Test Alarm" is a fire-and-forget write; `PodClient.postAlarm` never retries

`POST /api/alarm` is non-idempotent at the hardware layer (a retried POST while the first is
still landing double-fires the vibration) and gives no synchronous confirmation the alarm ran
(Context, above — the route responds before `executeAlarm` resolves).

**Resolution:** add `PodClient.postAlarm(request: AlarmRequest, signal?)`, validated against a
new strict `AlarmRequestSchema` (`src/pod/types.ts`), that explicitly bypasses
`requestWithRetry`'s network-error/5xx retry — it calls `singleAttempt` directly (still through
the existing per-endpoint `enqueue` serialization, so `pod-client`'s "at most one in-flight
request per endpoint" invariant is unaffected) and surfaces a network error or 5xx as a single
failure with no second attempt. `TestAlarmService`'s `On` `onSet` handler calls it with
`force: true` (required — `executeAlarm` silently no-ops off/away sides without it) and a fixed,
short `duration`/`vibrationIntensity`/`vibrationPattern` the service itself chooses (not exposed
as characteristics — "Test Alarm" is a single momentary trigger, not a configurable one).
Regardless of the write's outcome (success, failure, or timeout), the switch's own `On`
characteristic is pushed back to `Off` via a ~1 s `this.ctx.timers.setTimeout` (issue #20's own
"self-reset after ~1 s") — this is deliberately decoupled from whether the alarm actually fired:
upstream's own `Math.max(10, duration) * 1000` ms vibration (Context, above) genuinely outlasts
the tile's own reset by an order of magnitude, and there is no reliable synchronous signal to
wait for instead. The tile resetting after ~1 s communicates "the trigger was sent," never
"the bed is done vibrating."

### 7. Server-fault `StatusFault` means "the `serverStatus` poll itself is failing," not "a subsystem reports failed"

`docs/HOMEKIT.md`'s table doesn't disambiguate these two different failure modes, and they
need different handling: one is "we can't currently tell you the Pod's internal health" (this
plugin's own poll of `GET /api/serverStatus` failing/timing out), the other is "the Pod told us
something's actually broken" (a successfully-parsed payload with a `'failed'` subsystem).

**Resolution:** follow `src/services/connection.ts`'s own precedent exactly, applied to a
different endpoint class. `ContactSensorState` is the **payload** signal — `CONTACT_DETECTED`
("closed," the good state, matching the connection sensor's own polarity convention) when every
subsystem in the last successfully-parsed `serverStatus` document has a status other than
`'failed'`, `CONTACT_NOT_DETECTED` the moment any one does. `StatusFault` is the **reachability**
signal for this specific endpoint class — `GENERAL_FAULT` while the `serverStatus` poll's own
`ConnectionState`-equivalent (see the new `SnapshotStore` slot below) reports its most recent
attempt failed, `NO_FAULT` otherwise — exactly mirroring what `connection.ts`'s `faultState()`
already means for the `deviceStatus` class, just keyed to a different one. `StatusActive`
mirrors `connection.ts`'s too: `false` until the first successful `serverStatus` observation,
sticky `true` after. Per `pod-snapshot`'s "last successful observation stands" requirement, a
failing `serverStatus` poll leaves `ContactSensorState` at its last known value while
`StatusFault` signals that value may be stale — the same two-axis reasoning `connection.ts`
already established, reused rather than reinvented.

### 8. `ServerStatus` is vendored as a fifth top-level schema block

`src/pod/types.ts`'s own module doc states "Four blocks, one per upstream source file" (device
status, settings, schedules, services) and reproduces `StatusInfoSchema` locally inside the
`services` block rather than adding a fifth, because nothing outside `ServicesSchema` needed it
before now.

**Resolution:** add a genuine fifth top-level block, `ServerStatusSchema`, citing
`server/src/routes/serverStatus/serverStatusSchema.ts` (`StatusInfoSchema`/`ServerStatus`) as
its own upstream source — it is not a sub-shape of any of the other four. The existing local
`StatusInfoSchema` reproduction inside the `services` block and this new one are structurally
identical (`{name, status, description, message, timestamp?}` with the same six-value `status`
enum) but are **not merged into one shared schema**: `types.ts`'s own "four/five blocks, one per
upstream source file" discipline means each block should be independently diffable against its
own cited upstream file without a shared type creating an implicit coupling between two
otherwise-unrelated upstream schemas that happen to look alike today. The module doc's "Four
blocks" framing is updated to "Five blocks" and this deviation is called out explicitly in a
comment at the new block, not left to be noticed later as an inconsistency.

`ServerStatus`'s optional biometrics-gated keys (`analyzeSleepLeft`, `analyzeSleepRight`,
`biometricsInstallation`, `biometricsStream`, `biometricsCalibrationLeft`,
`biometricsCalibrationRight` — present only when `servicesDB.data.biometrics.enabled`,
`server/src/serverStatus.ts`'s `updateServices()`) are all `.optional()`, matching the read-side
leniency `types.ts` already applies everywhere else (an absent key parses fine; the
"any subsystem `=== 'failed'`" derivation simply has fewer subsystems to check when they're
absent).

## Risks / Trade-offs

- **[Risk] LED brightness feedback lags a drag by up to ~5 s** (Decision 2) → Mitigation:
  documented as an accepted trade-off; no jitter or snap-back occurs in the interim, only a
  delay, and the fix (a device-scope overlay) is a known, scoped future change if it becomes a
  real complaint.
- **[Risk] `GET /api/serverStatus` is not free — a real SQLite round-trip per call
  (`updateDB()`, Context above)** → Mitigation: polled on the slow (`slowPollIntervalMs`,
  default ~5 min) cadence like `settings`/`schedules`/`services`, never the fast `deviceStatus`
  cadence, and only while `serverFaultSensor` is enabled (default `false`) — the poller's
  `enabled` predicate (already a first-class extension point, `EndpointClassSpec.enabled`) skips
  the request entirely when the sensor isn't published, at zero cost to installs that don't
  opt in.
- **[Risk] A "Test Alarm" trigger's tile self-resets ~1 s in, while the physical bed keeps
  vibrating for ≥10 real seconds (Decision 6)** → Mitigation: this is issue #20's own explicit
  design ("self-reset after ~1 s"); documented here so it is a deliberate choice a future reader
  can find, not a bug report waiting to happen. A user who wants to *see* the real vibrating
  state already has `isAlarmVibrating`'s existing `SideChangeField` plumbing to build an
  automation on, unrelated to this switch's own tile.
- **[Risk] `postAlarm`'s no-retry policy means a single dropped packet or transient 5xx loses
  the trigger with no automatic recovery** → Mitigation: deliberate — retrying a fire-and-forget,
  non-idempotent hardware trigger risks a double-fire, which is strictly worse for this specific
  endpoint than an occasional missed press the user can just press again.
- **[Risk] Five new services on the hub accessory, each independently config-gated, multiplies
  `enabledServiceKeysFor`/`constructServicesFor`/`handleSnapshotChanges` branching** →
  Mitigation: each of the three existing extension points was already designed for exactly this
  growth (`enabledServiceKeysFor`'s own doc comment: "a later change only has to grow
  `enabledServiceKeysFor`, never [`pruneServices`]") — no new mechanism is introduced, only more
  entries in already-generic tables/switches.

## Migration Plan

Purely additive: five new, independently defaulted config keys (`primeSwitch`, `ledLightbulb`,
`testAlarmSwitch`, `serverFaultSensor` default `false`; `pollIntervals.deviceWriteDebounceMs`
defaults to 500 when omitted), one already-shipped key's *documentation* changing from
"reserved" to "live" with no shape change (`waterLowSensorType`), and one new unconditional
service (water-low). An existing installation's `config.json` needs no edit to keep behaving
exactly as it does today; `npm run build` and a Homebridge restart pick up the new services at
their documented (mostly off) defaults. No accessory identity, UUID, or existing service is
altered — `pruneServices` only ever removes a service that is *not* in the currently-enabled
set, and every currently-published service stays enabled under its own unchanged config.

No rollback beyond reverting the plugin version is needed: turning a new boolean back to
`false` (or downgrading the plugin) prunes the corresponding service on the next restart via the
existing restore-and-prune path (`specs/platform/spec.md`'s "Restoring from the accessory cache
never duplicates, and prunes what is no longer enabled").

## Open Questions

- HAP's exact behavior when a `Lightbulb`'s `Brightness` characteristic is set to `0` while `On`
  is also being set `true` in the same batched HomeKit write (a client sending both at once) can
  only be confirmed on a real paired Home app — `LedService` is written defensively (treat `On`
  and `Brightness` as independently-arriving `onSet` calls, matching how `ThermostatService`
  already treats `TargetHeatingCoolingState`/`TargetTemperature` as two separate, debounced
  writes) but the exact Home-app-generated write pattern for a Lightbulb specifically is not
  something this repo has observed yet.
- Whether real free-sleep Pod hardware ever reports a `serverStatus` subsystem status of
  `'restarting'` or `'retrying'` in practice (as opposed to `'not_started'` transiently at boot)
  is unconfirmed without a real Pod under real load — this change treats every non-`'healthy'`,
  non-`'not_started'` status other than `'failed'` (i.e. `'restarting'`, `'retrying'`,
  `'started'`) as *not* a fault, matching the issue's own literal "status === 'failed'" wording;
  if real-world observation later shows `'retrying'` deserves the same treatment as `'failed'`,
  that's a narrow, low-risk follow-up to the one derivation function this design isolates for
  exactly that reason.

## Resolutions (tech lead, 2026-09-06)

All eight decisions ratified as designed. Notably: water-low unconditional matches the
connection-sensor precedent (waterLowSensorType picks the service type only — shipped enum
unchanged, issue #20's 'none' value dropped); the LED ~5s settle trade-off is accepted and
must be stated in README's config table; prime-off refusal mirrors the established
NOT_ALLOWED_IN_CURRENT_STATE pattern; postAlarm's no-retry opt-out is mandatory (also noted
by the pod-client review long ago). The server-fault two-axis split (payload vs poll
reachability) is the honest signal design requested.
