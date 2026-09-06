## Context

See proposal.md — Why. This change composes four capabilities that already exist and adds no
new mechanism of its own; almost every decision below is about *which* existing mechanism to
lean on, and about the handful of HAP behaviours that make the obvious composition wrong.

Every free-sleep claim below cites a path in the checkout at `~/Code/free-sleep`, pinned at
**v2.1.5, commit `dc0c710`** — the same point `docs/POD-API.md` and the two preceding designs
were verified against.

**What this change consumes, all of it assumed landed** (per ADR-0002 this change is serial and
last in the MVP):

- `temperature-mapping` (merged, `887c526`): `F_MIN`/`F_MAX`, `fToC`/`cToF`, `TARGET_TEMP_PROPS`
  in `src/pod/temperature.ts`.
- `pod-client` (#4, #5): `PodClient`, the typed error taxonomy, and the stateful mock Pod with
  request recording and fault injection.
- `poller-and-write-queue` (#8, #10): `SnapshotStore` (synchronous `get()`, enumerated typed
  change events in device units, optimistic overlay), `PodPoller` (one shared poll per endpoint
  class, `bootstrap()`, `stop()`), `WriteQueue` (per-side lanes, 400 ms debounce, per-submission
  promises, overlay install/clear), and the injected `TimerApi`.
- `platform-foundation` (#7): `FreeSleepPlatform`, `src/config.ts`, the three accessories with
  stable identity, `pruneServices`, and `test/fakeHomebridgeApi.ts` (real HAP-NodeJS underneath,
  real `PlatformAccessory`, `simulateRestart`).

**Pod behaviour this change depends on:**

- `isOn` is not stored. It is derived on read as `secondsRemaining > 0`
  (`server/src/8sleep/loadDeviceStatus.ts`), and writing `isOn: true` writes a duration of
  `'43200'` (`server/src/routes/deviceStatus/updateDeviceStatus.ts`). So HomeKit's "on" is a
  12-hour countdown that expires silently. This change does not fix that (#12, M3); it just must
  not pretend otherwise.
- Within one `POST /api/deviceStatus` body, `updateSide` applies `isOn` → `targetTemperatureF` →
  `secondsRemaining` → `isAlarmVibrating` as separate serialised commands
  (`updateDeviceStatus.ts`). `{isOn: true, targetTemperatureF: 64}` in one body is therefore
  correct and safe (`docs/POD-API.md`, "Command order"), which is what makes the write queue's
  coalescing of a mode change and a setpoint change into one request sound.
- `currentTemperatureF` is derived from a −100..100 hardware level
  (`server/src/8sleep/loadDeviceStatus.ts`; `docs/POD-API.md:43`) and can legitimately be below
  `F_MIN` in a cold room.
- `settings.temperatureFormat` is `'celsius' | 'fahrenheit'`
  (`server/src/db/settingsSchema.ts:5-6,59`, default `'fahrenheit'` at
  `server/src/db/settings.ts:46`).
- `POST /api/settings` writes `settingsDB.json`, which `server/src/jobs/jobScheduler.ts`
  chokidar-watches and responds to by cancelling and recreating **every** scheduled job. This is
  the reason `TemperatureDisplayUnits` is never written through.
- The Pod reboots daily: `settings.rebootDaily` defaults to `true`
  (`server/src/db/settings.ts:47`, schema `settingsSchema.ts:60`), and the reboot job is
  scheduled **one hour before** the daily prime — `scheduleRebootJob(onHour - 1, onMinute,
  timeZone)` at `server/src/jobs/primeScheduler.ts:75`, which checks `rebootDaily` (line 27) and
  calls `reboot()` (line 32). Unreachability is scheduled, routine, and multi-minute.

## Goals / Non-Goals

**Goals:**

- Add services to accessories that already exist, restore and prune correctly, without touching
  identity or restore logic.
- Put every HAP-specific quirk in exactly one place, so a later service (#16, #19, #20) copies a
  pattern rather than rediscovering a footgun.
- Keep the read path provably free of I/O, and make that provable by a test that composes the
  whole plugin rather than by inspection.
- Consume `pod-snapshot` / `pod-poller` / `pod-write-queue` exactly as specified. If something
  needed is missing, that is a finding to report upward, not a quiet edit to their modules.

**Non-Goals:**

- Any change to `src/pod/`. This change adds only `src/services/` and edits `src/platform.ts`.
- A service base class or a registration framework. Two services is not enough evidence to
  design an abstraction; #20 adds six more and is the right place to extract one if a shape has
  actually emerged.
- Serving anything from HomeKit that the snapshot does not already watch. `awayMode`,
  `isAlarmVibrating`, `waterLevelState` and `isPriming` are all in the snapshot and all
  deliberately unconsumed here.

## Decisions

### File layout: `src/services/`, not flat `src/`

`src/services/thermostat.ts`, `src/services/connection.ts`, `src/services/types.ts`.

docs/HOMEKIT.md's service table has eight more services queued behind these two (water,
occupancy, LED, prime, test alarm, dismiss alarm, alarm programmable switch, server fault). A
flat `src/` would end at ten sibling files with no grouping, next to a `src/pod/` directory that
already establishes the convention that a subsystem gets a directory. Choosing the directory now
costs nothing and avoids a rename later that would churn every import in `platform.ts`.

`src/services/types.ts` carries one interface — the context every service constructor takes:

```ts
interface ServiceContext {
  readonly api: API;                 // HAP runtime enums via api.hap, never @homebridge/hap-nodejs
  readonly log: Logging;
  readonly accessory: PlatformAccessory;
  readonly snapshot: SnapshotStore;
  readonly writeQueue: WriteQueue;
  readonly timers: TimerApi;         // the same one the poller and queue got
  readonly config: ResolvedConfig;
}
```

Threading the *same* `TimerApi` into the services matters: the No-Response escalation compares
`now()` against a timestamp the snapshot recorded, and if those two clocks differ the escalation
cannot be tested deterministically.

### One shared HAP rule: compare before pushing, and never trust HAP to deduplicate

Every push in this change goes through the same shape:

```
if (next !== current) characteristic.updateValue(next)
```

where `current` is `characteristic.value` (Homebridge 2 removed `Characteristic.getValue()`;
`docs/HOMEKIT.md`, "Homebridge 2.x API notes") — **except for the two temperature
characteristics**, where `current` is the °F shadow instead, for the reason below. We do not rely
on HAP's own change detection: it compares the exact stored value, and after a client write that
stored value is the client's raw float.

### The °F shadow: `publishedF` in `accessory.context`, compared in device units

This is the minimal M2 slice of the anti-jitter scheme that #8, #9 and #14 all describe from
different angles.

The bug it prevents: HAP's `handleSetRequest` assigns the **raw client float** to
`characteristic.value` without snapping it to the props grid, so after a Home-app write the
stored value is e.g. `17.79999`, not our canonical `fToC(64) === 17.777…`. A poller that pushed
`fToC(64)` for the same 64 °F would look like a change to HAP, emit an event, and redraw the
slider under the user's finger (`docs/HOMEKIT.md`, "Anti-jitter"; issue #14).

```ts
// accessory.context.publishedF — JSON-persisted by PlatformAccessory across restarts
{ targetF?: number, currentF?: number }
```

- **onSet(TargetTemperature, °C)**: `f = Math.round(cToF(value))`; write `publishedF.targetF = f`;
  submit `{ targetTemperatureF: f }`; **do not** `updateCharacteristic`. HAP already holds the
  client's value and the client already believes it.
- **On a `targetTemperatureF` change event**: push only when `event.current !== publishedF.targetF`;
  on push, set the shadow to `event.current`.
- **`currentTemperatureF`** gets the identical treatment via `publishedF.currentF`, because the
  Pod's reading is an integer °F and the converted °C is irrational.

The rule composes with `pod-snapshot`'s overlay rather than duplicating it. Walking the sequence
for a slider drag from 64 to 70:

| Step | `publishedF.targetF` | Snapshot effective | Event | Push? |
|---|---|---|---|---|
| user writes 70 | 64 → **70** | 64 | — | no (claimed, not pushed) |
| queue installs overlay | 70 | 64 → **70** | `64→70` | **no** — equals shadow |
| poll races, reports 64 | 70 | 70 (suppressed) | none | no |
| poll reports 70, overlay retires | 70 | 70 | none | no |
| web UI sets 66, poll reports it | 70 → **66** | 70 → 66 | `70→66` | **yes** |
| write failed, overlay cleared | 70 → **64** | 70 → 64 | `70→64` | **yes** (correct revert) |

**What #14 adds on top, deliberately deferred:** the explicit `writeSettleMs` suppression window
keyed on per-side write timestamps, `lastNonZeroBrightness` persistence (an M4/#20 concern), and
the real-hardware confirmation that a full-range drag never visibly snaps back. The window is
deferred because the overlay already suppresses every *disagreeing* observation for the whole
settle window, which is strictly stronger than a 500 ms time-boxed suppression; the residual
race #14 is really about — a poll that started before our write and lands after it — is a
disagreeing observation, so the overlay already covers it. If real hardware shows a residual
snap-back, #14 is where the extra window belongs.

### `writeSettleMs` is claimed by two designs with different meanings — resolved here as the write queue's

**This needs tech-lead confirmation.** Two landed-or-in-flight designs define the same key:

| Design | Default | Meaning |
|---|---|---|
| `platform-foundation` reserved-keys table | `500` | "docs/HOMEKIT.md's anti-jitter window; thermostat-and-offline (#9) reads it" |
| `poller-and-write-queue` options table | `15000` | "overlay window (name fixed by #14)" |

One key, two owners, defaults 30× apart. Resolved here as: **`writeSettleMs` is the write
queue's overlay window, default 15000**, and *this change does not read it at all* — for the
reason in the previous section. The only config key this change consumes is `noResponseAfterMs`.
`platform-foundation`'s reserved-keys row needs its default and its owner corrected; that is a
one-line edit in a change that has not landed, not a new key, so this change adds no config
surface (proposal.md, Non-goals).

### Characteristic table

All properties are declared during construction, before any value is reported and before the
accessory is registered — `setProps` after publish does not bump the HAP configuration number
(`docs/HOMEKIT.md`; there is an explicit TODO about it in HAP-NodeJS's `Characteristic.ts`), and
`setProps` re-validates the current value, so declaring late can silently rewrite a value.

| Characteristic | Props declared | Reads from | Writes to |
|---|---|---|---|
| `CurrentHeatingCoolingState` | **none** — its default valid values are already exactly `[OFF, HEAT, COOL]` | derived, see deadband | — |
| `TargetHeatingCoolingState` | `validValues: [OFF, AUTO]` — **OFF first** | `isOn ? AUTO : OFF` | `{isOn}` |
| `CurrentTemperature` | `{ minValue: -270, maxValue: 100 }`, default `minStep` 0.1 | `fToC(currentTemperatureF)` | — |
| `TargetTemperature` | `TARGET_TEMP_PROPS` | `fToC(targetTemperatureF)` | `{targetTemperatureF}` |
| `TemperatureDisplayUnits` | none | `accessory.context.displayUnits` | `accessory.context.displayUnits` |

**Why OFF is listed first**: our own `updateValue`/`onGet` returns are *clamped, not rejected* —
an out-of-list value is silently replaced with `validValues[0]` (`docs/HOMEKIT.md`). Listing OFF
first means any such replacement lands on "off", never on a mode implying the bed is running. A
*client* write outside the list is a different path: it throws in `validateClientSuppliedValue`
and becomes `INVALID_VALUE_IN_REQUEST` before `onSet` runs, which is why "Hey Siri, set the bed
to heat" fails while "turn on the bed" (which uses AUTO) works.

**Why `CurrentTemperature` gets the full HAP-legal range and not a merely "wide" one**: HAP
clamps a reported value to the declared range, so *any* narrowing is a silent lie about a
reading the Pod genuinely produced (issue #9: "do not clamp to 55–110 °F"). `-270..100 °C` is the
widest the HAP spec permits for this characteristic, so it is the only choice that cannot clamp
anything the Pod can report. Alternative considered: `fToC(0)..fToC(212)`. Rejected — it is an
arbitrary bound that would still clamp, just less often, and it buys nothing.

**Why no `setProps` on `CurrentHeatingCoolingState`**: adding a redundant `validValues` here is
the kind of "harmless" call that later gets moved after construction. Its default list is
already correct, so the safest edit is none.

`service.setPrimaryService(true)` on each thermostat — the service-level method; Homebridge 2
removed `Accessory.setPrimaryService(svc)` (`docs/HOMEKIT.md`).

Both services are added with an explicit subtype (`'thermostat'`, `'connection'`) and looked up
on restore with `accessory.getServiceById(uuid, subtype)`, per `platform-foundation`'s design;
`getService(ServiceType)` is never used.

### The sticky deadband, and where its state lives

```
if (!isOn)                          -> OFF
else if (targetF - currentF >= +1)  -> HEAT
else if (targetF - currentF <= -1)  -> COOL
else                                -> last reported non-OFF state
                                       (seed: HEAT when targetF >= currentF, else COOL)
```

The "sticky" state is simply `characteristic.value` when it is not OFF — there is no extra field
to keep, and it is persisted across restarts for free by `PlatformAccessory`. That is why the
seed clause exists: on a first-ever launch inside the deadband, `characteristic.value` is HAP's
default (OFF), which is exactly the value the rule may not produce for a running side.

The deadband is the reason `CurrentHeatingCoolingState` cannot simply be recomputed and pushed
per event: a `currentTemperatureF` event and a `targetTemperatureF` event both feed it, and so
does an `isOn` event. The handler therefore recomputes the pair
`(TargetHeatingCoolingState, CurrentHeatingCoolingState)` on **any** of those three events and
pushes each member only if it differs from `characteristic.value`. Since both are small integer
enums stored exactly, `!==` is an exact comparison and needs no shadow.

Alternative considered: report an idle state at setpoint. Not available — HAP's
`CurrentHeatingCoolingState` has no idle value, and reporting OFF makes the Home app's tile
subtitle read "Off" beneath a bed that is actively heating (`docs/HOMEKIT.md`).

### Change-event routing: the platform subscribes once, services expose plain methods

`platform.ts` subscribes to `snapshot.subscribe(...)` exactly once and dispatches each change in
the batch:

| Watched field | Routed to | Effect |
|---|---|---|
| `currentTemperatureF` (side) | that side's thermostat | shadow-compare → `CurrentTemperature`; recompute state pair |
| `targetTemperatureF` (side) | that side's thermostat | shadow-compare → `TargetTemperature`; recompute state pair |
| `isOn` (side) | that side's thermostat | recompute state pair |
| `connection.online` | hub connection sensor | `ContactSensorState` + `StatusFault` |
| `isAlarmVibrating`, `awayMode`, `waterLevelState`, `isPriming` | nobody | ignored, no error (#13/#16/#19/#20) |

Each service is wrapped in try/catch at the dispatch site so one throwing service cannot silence
the others — mirroring the isolation `pod-snapshot` already guarantees for its own subscribers,
one level up.

Alternative considered: each service subscribes to the snapshot itself. Rejected — N
subscriptions means N unsubscribes to get right at shutdown, and it puts the "which side is this
event for" filter in every service instead of once at the dispatcher.

**`settings.temperatureFormat` is deliberately not routed**, because it is not a watched field
(`pod-snapshot`: only the enumerated list emits events, and settings contents are not in it).
`TemperatureDisplayUnits` seeds *lazily inside its own `onGet`*: if `context.displayUnits` is
unset and the snapshot's settings class is known, seed from `temperatureFormat` and store it.
That is one code path covering both "settings arrived during bootstrap" and "settings arrived on
the first slow poll", with no watched field added and no timer.

### Write mapping: two characteristics, two single-field patches

| onSet | Submitted patch | Lane |
|---|---|---|
| `TargetHeatingCoolingState = OFF` | `{ isOn: false }` | that side |
| `TargetHeatingCoolingState = AUTO` | `{ isOn: true }` | that side |
| `TargetTemperature = c` | `{ targetTemperatureF: Math.round(cToF(c)) }` | that side |
| `TemperatureDisplayUnits = u` | *(none — `accessory.context` only)* | — |

Each handler `await`s its submission promise and, on rejection, throws
`new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)`. The queue settles
every submission merged into one dispatch with that dispatch's outcome, so a merged mode+setpoint
write fails or succeeds as a unit — which is the honest answer, since the Pod applied it as a
unit.

`secondsRemaining` is never written by this change, so the queue's `isOn`/`secondsRemaining`
reduction never fires from here. It exists for #12.

**Why single-field patches rather than one composed patch**: the queue's 400 ms debounce already
merges a mode change and a setpoint change arriving together into one body (`docs/POD-API.md`
confirms `{isOn, targetTemperatureF}` in one body is safe), so composing them here would
duplicate that logic and lose the per-characteristic failure attribution.

### No Response: what actually works, and why the obvious thing does not

`updateCharacteristic(char, new Error(...))` is a **no-op in an `onGet`-based plugin**
(`docs/HOMEKIT.md`, "the naive approach does not work"; issue #11). `updateValue` sees the Error,
sets `this.statusCode`, and returns *without emitting an event or notifying any controller*; the
read path then resets `statusCode = HAPStatus.SUCCESS` on every successful `onGet`; and the
`throw this.statusCode` branch is only reachable when there is **no** `onGet` handler at all.
Since every characteristic in this change has an `onGet`, that branch is dead code for us. The
only mechanism that surfaces No Response is throwing from the handler — which HAP-NodeJS's own
[wiki](https://github.com/homebridge/HAP-NodeJS/wiki/Presenting-Erroneous-Accessory-State-to-the-User)
warns against for transient failures, because it produces extended No Response states that often
persist until the user force-quits the Home app.

Given the Pod's *scheduled* daily reboot (`primeScheduler.ts:75`, above), the policy is:

1. **`onGet` never throws** while any snapshot exists. Serve last-known values, log at debug.
2. **`onSet` does throw** `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`; it does not latch,
   because the next successful read resets the status.
3. **The outage is data**: the hub's "Pod Connection" `ContactSensor`, with `StatusFault` and
   `StatusActive` — characteristics that `ContactSensor` legally declares and `Thermostat` does
   **not**, so they are added to the sensor only.
4. **Escalation after `noResponseAfterMs`** (default 600000; `0` disables), after which `onGet`
   throws, clearing on the first successful poll.

**Escalation is computed lazily at read time, with no timer:**

```ts
const since = connection.lastSuccessAt ?? platformStartedAt;
const escalated = noResponseAfterMs > 0
  && !connection.online
  && timers.now() - since > noResponseAfterMs;
```

No timer, no state machine, nothing to leak at shutdown, and it clears the instant a poll
succeeds because `connection.online` and `lastSuccessAt` are the snapshot's own fields. The
`?? platformStartedAt` clause handles a launch where the Pod was never reachable.

**Bootstrap fallback**: when a snapshot class reads as unknown, every `onGet` returns
`characteristic.value` — which `PlatformAccessory` persists to disk across restarts
(`docs/HOMEKIT.md`, "Bootstrap"). This is why `platform-foundation`'s bootstrap-before-wiring
ordering matters: handlers are registered only after `poller.bootstrap()` settles, so the common
case never takes this path.

### Connection sensor polarity: online is "contact detected"

`ContactSensorState.CONTACT_DETECTED` while reachable, `CONTACT_NOT_DETECTED` while not. The
Home app renders these as "Closed" and "Open", so an outage reads as "Pod Connection — Open",
and the natural automation trigger ("when Pod Connection opens") fires on going offline, which is
the event people want to be notified about. The alternative polarity makes the notification-worthy
event the *closing* one, which reads backwards. Flagged in Open Questions because it is a UX
judgement, and because flipping it after users have built automations on it is breaking.

`StatusFault` = `GENERAL_FAULT` while offline, `NO_FAULT` otherwise. `StatusActive` = `false`
until the first successful observation *ever* in this launch, `true` afterwards — including
during a later outage, because once we have observed the Pod the sensor's "not detected" reading
is trustworthy data rather than an absence of data. That is the same reasoning docs/HOMEKIT.md
applies to the occupancy sensor's `StatusActive`, applied in the other direction.

**The sensor cannot flap, structurally**, which is issue #11's done-when: the snapshot only emits
a change event when `connection.online` actually changes, and `connection.online` is derived from
the last device-status poll outcome — a run of consecutive failures leaves it `false` throughout.
So a reboot produces exactly two events regardless of how many polls, retries and backoff steps
occur inside it. No debounce is added; adding one would need a new snapshot field or a new config
key, and neither is warranted by a property the existing design already guarantees.

### `TemperatureDisplayUnits` never reaches the Pod

Serving and storing it in `accessory.context` is not an optimisation; it is the whole point. The
Pod's `temperatureFormat` lives in `settingsDB.json` (`server/src/db/settingsSchema.ts:59`), and
`POST /api/settings` makes `server/src/jobs/jobScheduler.ts` cancel and rebuild **every**
scheduled job. A user tapping a unit toggle in Eve — a characteristic the Apple Home app ignores
entirely, since it displays per the iOS device's region setting — must not be able to tear down
the bed's alarm and temperature schedules.

### The integration test: real HTTP, virtual clock

`test/integration/session.test.ts` boots `FreeSleepPlatform` through
`test/fakeHomebridgeApi.ts` (which `platform-foundation` built, with real HAP-NodeJS underneath —
so `setProps` validation, `validValuesIterator`, and `updateValue` clamping are the real ones)
against `test/mockPod.ts` (which `pod-test-double` built — a real HTTP server with request
recording and fault injection).

**Time is driven through the injected `TimerApi`, not through `vi.useFakeTimers()`.** This is the
one non-obvious harness decision. The mock Pod is a *real* HTTP server reached over *real*
sockets, and freezing the global timer set would freeze undici's own internals along with the
poller's. Because `poller-and-write-queue`'s design already forbids `src/pod/**` from touching
`Date.now`, `Math.random`, `setTimeout` or `setInterval` directly, a hand-written
`ManualTimers` implementing `TimerApi` (virtual `now()`, a sorted pending-callback list,
`random: () => 0.5` for zero jitter) gives complete control of every interval, backoff and
overlay expiry while real HTTP proceeds normally. `advance(ms)` returns a promise the test awaits
so in-flight requests settle before the next assertion.

The three properties, and how each is provoked:

| Property | How | Assertion |
|---|---|---|
| Read burst is free | read every characteristic of all three accessories, twice, at t=0 and t=60 s | `mock.requests.length` delta is **0** across each burst |
| A drag is one write | six `TargetTemperature` writes 50 ms apart to one side, then advance past the debounce | exactly **1** recorded `POST /api/deviceStatus`, body carries the last degree |
| An outage is two flips | mock fault injection: destroy the connection for the next N device-status requests, advance across several poll intervals, then let it recover | `ContactSensorState` changed exactly **2** times; every read during the outage returned a value |

Using fault injection rather than `mock.stop()` / `mock.start()` avoids needing port reuse and
produces the network-level failure `PodNetworkError` the poller's backoff expects — the same
class of failure a rebooting Pod produces. `pod-test-double` already specifies both the
connection-destroy fault and the "after N faulty responses, normal behaviour resumes" semantics,
so nothing new is needed in the mock.

The `≤ 40 requests / exactly 1 write / ≥ 10 reads` budget itself stays in
`poller-and-write-queue`'s spec, where it belongs; this test asserts the *platform-level*
composition on top of it.

### What needs a real paired device

Per this project's design rule, everything above is confirmable by unit or integration test
against real HAP-NodeJS except the following. This list is the intended content of the
verification comments on issues #9 and #11.

**Issue #9 (thermostat):**

1. That the Home app's mode picker really shows only **Off** and **Auto**, and that omitting the
   threshold characteristics really suppresses the two-setpoint range control in Auto.
2. That `Target = Auto` with `Current = Heat/Cool` renders a sensible tile subtitle, and that the
   sticky deadband looks right rather than merely correct — i.e. that a bed sitting at setpoint
   does not visibly alternate.
3. That the °F slider steps one whole degree at a time on a real iOS device set to Fahrenheit,
   with neither a skipped nor a repeated degree, and that 110 °F is reachable.
4. That the widened `CurrentTemperature` range renders acceptably for a genuine sub-55 °F reading
   rather than producing an odd or blank tile.
5. That a `TemperatureDisplayUnits` write from Eve is accepted and sticks, and that the Home app
   does not fight it.
6. That a change made in free-sleep's own web UI appears in the Home app within one poll interval
   (issue #9's done-when).
7. That "Hey Siri, turn on the bed" maps to AUTO, and that "set the bed to heat" fails with
   `INVALID_VALUE_IN_REQUEST` as predicted rather than doing something surprising.
8. That `setPrimaryService(true)` on a service carrying a **subtype** behaves as expected on a
   bridged child accessory.
9. The real size of the Home app's read burst on open — the estimate that
   `poller-and-write-queue`'s budget is sized against (#15).

**Issue #11 (offline):**

10. That `fs-restart` on the Pod flips the connection sensor exactly twice and the thermostat
    keeps serving last-known values throughout (issue #11's done-when), across a *real* reboot
    rather than injected faults.
11. Whether a thrown `onGet` past `noResponseAfterMs` produces the extended No Response latch the
    HAP-NodeJS wiki warns about, and — critically — **how long it persists after recovery**. If it
    latches until a force-quit even after the escalation clears, the default may need to be
    raised or escalation disabled by default.
12. That `StatusFault` / `StatusActive` on a `ContactSensor` surface anywhere useful in the Home
    app, or whether they are only visible to third-party clients like Eve.
13. That "Pod Connection — Open" for an offline Pod reads naturally to a user, and that the
    automation trigger appears with sensible wording.
14. That the real on-disk `cachedAccessories.json` round-trips `accessory.context.publishedF` and
    `context.displayUnits`, and that persisted characteristic values are really available to the
    first `onGet` after a restart — the fallback the whole bootstrap story rests on.

## Risks / Trade-offs

- **`isOn: true` silently expires after 12 hours** (`updateDeviceStatus.ts` writes `'43200'`), so
  a HomeKit thermostat left in Auto will spontaneously report Off overnight. → Known and
  deliberate; #12's keep-alive is the fix and is M3. This change reports the truth rather than
  masking it, which is the only defensible behaviour until the keep-alive exists.
- **A write to one side under away mode is applied to both sides** by the Pod. HomeKit will then
  show the other side changing "by itself" one poll later. → Correct behaviour for #13 to guard;
  the snapshot already watches `awayMode`, so nothing here blocks it. Worth a README note.
- **Escalation is evaluated per read, so it can flip mid-burst.** A burst that straddles the
  `noResponseAfterMs` boundary can have its first reads succeed and its last reads throw. → The
  outcome is identical to a burst issued a second later, and the alternative (a timer that
  latches a flag) adds state and a shutdown obligation for no behavioural gain.
- **The `publishedF` shadow can desynchronise from HAP's stored value** if anything ever calls
  `updateCharacteristic` on a temperature without updating the shadow. → Single writer: exactly
  one function pushes each temperature characteristic, and it updates the shadow in the same
  statement. The integration test's "no push for an unchanged degree" assertion is the guard.
- **`accessory.context` is JSON-persisted asynchronously by Homebridge**, so a crash between a
  write and the flush loses the shadow. → Worst case is one spurious `updateCharacteristic` after
  a restart, which is invisible to the user.
- **Two services are not enough to justify an abstraction, but #20 adds six at once.** → Accepted
  deliberately; extracting a base class from two examples is likelier to be wrong than useful.
- **This change assumes four in-flight changes land as specified.** → It is serial and last by
  ADR-0002. The concrete coupling points are: `SnapshotStore`'s event shape, `WriteQueue.submit`'s
  promise semantics, `PodPoller.bootstrap`/`stop`, and `fakeHomebridgeApi`'s
  `simulateRestart`. A signature drift in any of them changes tasks, not this design.

## Migration Plan

No data migration. Three new source files and edits to `src/platform.ts`; no persisted format
changes beyond two new optional keys inside `accessory.context` (`publishedF`, `displayUnits`),
both of which are absent-tolerant by construction.

Users upgrading from a `platform-foundation`-only build keep their accessories: identity is
derived from `host` and role and is untouched, so the existing UUIDs are restored and simply gain
services in place. No re-pairing. Rollback is deleting `src/services/` and reverting
`src/platform.ts`, which returns the accessories to information-only — HomeKit handles a service
disappearing from a bridged accessory without unpairing it.

`platform-foundation`'s `Categories.THERMOSTAT` choice for side accessories was made in
anticipation of exactly this change, so no category changes here and no re-pair is triggered.

## Open Questions

Flagged for tech-lead review; none of them changes the specs, the approach, or the task
breakdown.

1. **Connection sensor polarity.** This design uses online = `CONTACT_DETECTED`, so the Home app
   shows "Closed" when healthy and "Open" during an outage, and the automation trigger is "when
   Pod Connection opens". The inverse reads better as a *state* ("Pod Connection: Closed" for a
   closed connection is arguably clearer) but makes the notification-worthy event a *close*.
   Cheap to flip now, breaking to flip after users build automations.
2. **Should `StatusActive` also drop to `false` during an outage,** not only before the first
   success? As specified it stays `true`, on the grounds that a known-offline Pod is data rather
   than absent data. The counter-argument is that Eve renders `StatusActive: false` as a clear
   "no data" badge that some users would find more legible than a contact sensor reading "Open".
3. **Should the escalation default (`noResponseAfterMs: 600000`) survive contact with real
   hardware?** Ten minutes comfortably exceeds a `fs-restart`, but a Pod firmware update or a
   `reboot` that hits an fsck could exceed it, and verification item 11 above may show the No
   Response latch is worse than a stale reading. If so the honest default may be `0` (escalation
   off), with the connection sensor carrying the whole signal.

## Resolutions (tech lead, 2026-09-06)

1. **`writeSettleMs` belongs to the write queue at 15000; this change reads only
   `noResponseAfterMs`.** `platform-foundation`'s reserved-key row was corrected on main at
   reconcile time (same commit as these artifacts), so task 9.3 becomes a verification that
   the correction holds, not the edit itself.
2. **Polarity stands**: online = `CONTACT_DETECTED` (Closed when healthy, Open during an
   outage, automations trigger on "opens"). Locked before anyone builds automations on it.
3. **`StatusActive` stays `true` during outages** (false only pre-first-success); StatusFault
   carries the outage signal, per docs/HOMEKIT.md.
4. **`noResponseAfterMs: 600000` ships as the default**, explicitly provisional on hardware
   verification item 11; if the No Response latch proves stickier than documented, flipping
   the default to `0` is a one-line change tracked on issue #11.
