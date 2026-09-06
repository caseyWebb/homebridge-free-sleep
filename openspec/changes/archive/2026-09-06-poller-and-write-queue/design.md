## Context

See proposal.md — Why. Every Pod-behaviour claim below cites a path in the free-sleep checkout
at `~/Code/free-sleep`, pinned at **v2.1.5, commit `dc0c710`**, the same point `docs/POD-API.md`
was verified against.

Pre-existing state this design builds on:

- The `pod-client` change (#4, #5) provides `PodClient` — `getDeviceStatus`, `getSettings`,
  `getSchedules`, `getServices`, `postDeviceStatus`, `postSettings` — with an ~8 s per-attempt
  timeout, one-in-flight-per-endpoint serialisation, in-flight GET deduplication, one retry on
  network errors and 5xx, and the typed error taxonomy (`PodNetworkError`, `PodTimeoutError`,
  `PodBadRequestError`, `PodHttpError`, `PodResponseError`, `PodRequestError`, `PodAbortError`).
  It also provides the stateful mock Pod with request/command recording and fault injection.
  **This change assumes both have landed.**
- `PodClient` **rejects, pre-flight, a device-status patch that sets both `isOn` and
  `secondsRemaining` for the same side** (`pod-client/design.md`, "Pre-flight rejection…", and
  tech-lead resolution 1, which explicitly assigns the reducing behaviour to this change).
- `platform-foundation` (#7) is in flight and owns `src/config.ts` and `config.schema.json`.
  Nothing here imports it; see "Config ownership" below.

Constraints from free-sleep that shape everything:

- `GET /api/deviceStatus` calls `franken.getDeviceStatus()`
  (`server/src/routes/deviceStatus/deviceStatus.ts`); all socket traffic is serialised through
  one queue (`server/src/8sleep/sequentialQueue.ts`) with a 10 s response timeout and a 25 s
  connect timeout (`server/src/8sleep/frankenServer.ts:14,16`).
- The Pod polls **itself** over that same socket every **2 s** on Pod 4/5 and every **60 s** on
  Pod 3 (`server/src/8sleep/frankenMonitor.ts:86-88`: `waitTime = hasGestures ? 2_000 : 60_000`,
  where `hasGestures = coverVersion !== Version.Pod3`). Our polling is additive on a queue that
  is never idle — hence jitter, so we do not repeatedly land in the same phase relationship.
- `updateSide` applies per-side fields in the fixed order `isOn` → `targetTemperatureF` →
  `secondsRemaining` → `isAlarmVibrating`, each as a separate serialised hardware command, and
  guards with `if (secondsRemaining)` / `if (targetTemperatureF)` rather than `!== undefined`
  (`server/src/routes/deviceStatus/updateDeviceStatus.ts`). So an explicit duration overrides
  `isOn` in the same body, **except** when it is `0`, which is a silent no-op.
- `isOn` is derived on read as `secondsRemaining > 0` and is not stored
  (`server/src/8sleep/loadDeviceStatus.ts`), and `isOn: true` writes a duration of `'43200'`.
- `isPriming` comes from `rawDeviceData.priming === 'true'`
  (`server/src/8sleep/loadDeviceStatus.ts:184`); the daily prime job posts
  `{ isPriming: true }` (`server/src/jobs/primeScheduler.ts:83`).
- `POST /api/settings` writes `settingsDB.json`, which `server/src/jobs/jobScheduler.ts`
  chokidar-watches and responds to by cancelling and recreating **every** scheduled job.
  `POST /api/deviceStatus` does not touch LowDB and is cheap.

**No HAP claim in this document needs a real paired device**, because this change registers
nothing with HAP-NodeJS and imports no Homebridge type. Two *downstream* HomeKit behaviours are
assumed and can only be confirmed on a real paired Pod: that the Home app issues a read for
every characteristic on open (dozens within a few hundred ms), and that a thermostat
interaction issues `TargetHeatingCoolingState` and `TargetTemperature` as separate writes
milliseconds apart. Both are the premise of the request budget and the debounce window. The
budget is sized with headroom precisely because the burst size is an estimate, and #15 (load
check on real hardware) is the designed confirmation.

## Goals / Non-Goals

**Goals:**

- One direction of dependency, no cycles, and no HAP anywhere:
  `snapshot.ts` ← `poller.ts` and `writeQueue.ts`, all three depending only on
  `client.ts` / `types.ts` / `errors.ts`.
- A single, uniform rule for change events that makes overlay suppression and truth-pushing
  fall out rather than being special-cased.
- Every timing decision expressible under fake timers, deterministically, in milliseconds of
  real time.
- Extension points for #12, #13, #16 and #19 that are *mechanisms already used by this change*,
  not speculative hooks.

**Non-Goals:**

- A general event bus. There is exactly one publisher (the snapshot store) and a fixed,
  enumerated set of watched fields.
- A generic diff. Deep-diffing responses would emit noise from `schedules` and from the
  seconds-remaining countdown, and would make the event type unstateable.
- Reconciliation. The plugin never writes to bring the Pod in line with a desired state; it
  writes what a user asked for, once.

## Module dependency direction

```
src/pod/snapshot.ts    (imports: ./types.js)               ← cache + overlay + change events
src/pod/poller.ts      (imports: ./client.js, ./snapshot.js, ./errors.js, ./types.js)
src/pod/writeQueue.ts  (imports: ./client.js, ./snapshot.js, ./errors.js, ./types.js)
```

`writeQueue.ts` does **not** import `poller.ts`. It needs to request the post-write
confirmation, which would be a cycle (`poller → writeQueue` is not needed, but a future guard
makes it tempting). The queue therefore takes a `requestFastPoll: (lane, untilMs) => void`
callback in its options — `lane` names which endpoint class the dispatch confirms, so the
platform can wire a `deviceStatus`-lane write to `poller.requestMode('deviceStatus', …)` (the
extended fast-poll window) and a `settings`-lane write to `poller.refresh('settings')` instead (a
single confirming read; a settings write gains nothing from accelerating `deviceStatus` polling).
One function, no cycle, and the queue stays testable without a poller at all.

Nothing under `src/pod/` imports Homebridge, HAP-NodeJS, or anything from `test/`.

## Decisions

### The snapshot is a layered value: observed truth, plus an overlay, plus a derived view

```
raw:      { deviceStatus?, settings?, schedules?, services?, connection }   ← what polls saw
overlay:  Map<`${side}.${field}`, { value, expiresAt }>                     ← what we asked for
effective = applyOverlay(raw)                                               ← what everyone reads
```

`get()` returns `effective` — the only read path every HAP `onGet` uses.

**Every state mutation is a *commit*.** A commit takes a new `raw`, a new `overlay`, or both;
computes the new `effective`; deep-freezes it; compares the watched fields of the previous and
new `effective`; swaps it in; and then notifies. A poll result is a commit. Installing an
overlay entry is a commit. Retiring one — by agreement or by expiry — is a commit. There is one
code path.

This is the decision that makes the overlay/diffing interaction stateable in one sentence:
**change events are the diff of the effective view, and nothing else.** Everything the issues
ask for follows mechanically:

| Situation | `raw` | `overlay` | `effective` | Event |
|---|---|---|---|---|
| User sets 64 → 70 | 64 | 70 | 64 → 70 | `targetTemperatureF 64→70` |
| Poll races, reports 64 | 64 | 70 | 70 → 70 | none — *the suppression* |
| Poll reports 70 | 70 | retired on agreement | 70 → 70 | none |
| Overlay expires, `raw` still 64 | 64 | dropped | 70 → 64 | `targetTemperatureF 70→64` — *the truth push* |

Alternative considered: diff `raw` and have consumers apply the overlay themselves. Rejected —
every consumer would reimplement the suppression, and the thermostat would push a
`updateCharacteristic` for a value the user is currently dragging (#14's exact bug).

Alternative considered: suppress events for overlaid fields by an explicit "muted fields" set.
Rejected — it needs a second rule for un-muting that emits the reversion, which is precisely
what the effective-diff gives for free.

### Overlay lifecycle lives in the snapshot store; the write queue only installs entries

Agreement is detected during a `raw` commit and expiry is a timer; both are internal to the
store, which already owns commit and diff. The queue calls `overlay.set(side, field, value,
ttlMs)` and, on failure, `overlay.clear(handle)`. Splitting expiry across two modules would put
two timers and two copies of the agreement predicate in play.

Consequence: `snapshot.ts` needs injected timers too, not just the poller. It takes the same
`TimerApi`.

### Only exactly-predictable, user-visible fields may be overlaid

Overlayable: `targetTemperatureF`, `isOn`, `isAlarmVibrating` (per side), `awayMode` (per side,
from settings).

**Not overlayable: `secondsRemaining`.** Writing `isOn: true` produces `43200` on the Pod
(`updateDeviceStatus.ts`), but by the time we read it back it is `43198` or whatever; an overlay
pinned to `43200` would never agree, would always reach expiry, and would emit a spurious
reversion every single time a side is turned on. Nothing in HomeKit renders it. So the
keep-alive (#12) installs no overlay at all, which is also correct: a keep-alive changes nothing
the user can see.

Agreement for an `isOn` entry is therefore evaluated against the *derived* boolean
(`secondsRemaining > 0`, `loadDeviceStatus.ts`), which is exact. Agreement for
`targetTemperatureF` is exact integer equality — `docs/POD-API.md` records that every integer
55–110 °F round-trips losslessly through `calculateLevelFromF`/`calculateTempInF`, so there is
no rounding slop to absorb and no tolerance is needed.

### Watched fields are enumerated, and the countdown is deliberately not one

Watched: per side `currentTemperatureF`, `targetTemperatureF`, `isOn`, `isAlarmVibrating`,
`awayMode`; device-wide `waterLevelState` (the three-state interpretation, not the raw string),
`isPriming`, `connection.online`.

Not watched: `secondsRemaining` (changes every poll by construction — a watched countdown means
an event storm forever), `wifiStrength` (a boot-time constant from a client's point of view,
`docs/POD-API.md`), the whole of `schedules` and `services` (read on demand by #16/#19), and
`coverVersion`/`hubVersion`/`freeSleep.version` (seeded once into `AccessoryInformation`).

The event type is a discriminated union over that enumeration, so a consumer switches on
`change.field` with `previous`/`current` correctly typed — this is the "typed change-event
surface in device units" #9 subscribes to. Adding a watched field is a deliberate edit to one
list plus its type, which is the point.

`waterLevel` is watched by its *interpretation* rather than its raw string so that an
unrecognised value (`docs/POD-API.md`: anything not `"true"`/`"false"` is unknown, never low)
does not flap the sensor as free-sleep versions change the string.

### Frozen commits, returned by reference

`get()` is called dozens of times per Home-app open; cloning there would be the cost we are
trying to avoid. Instead each committed `effective` is deep-frozen once at commit time — once
per poll, not once per read — and handed out by reference. Callers cannot corrupt it, and a
caller holding an old snapshot keeps a coherent view.

This deliberately differs from `PodClient`, which `structuredClone`s per caller: the client
hands out mutable results a caller may legitimately want to edit, whereas the snapshot is a
shared read model.

### Notification delivery: copy the listener list, queue re-entrant commits

Deliver over a copied array so subscribe/unsubscribe during delivery is safe; wrap each listener
in try/catch and log. A commit triggered from inside a notification (a subscriber that calls
`writeQueue.enqueue`, which installs an overlay) is pushed onto a pending-commit queue and
processed after the current delivery drains, so notifications never interleave and `get()` is
never observed mid-swap.

### The poller is a registry of endpoint-class descriptors

```
{ id, read: (client) => Promise<T>, apply: (snapshot, value) => void,
  baseIntervalMs, enabled: (snapshot) => boolean }
```

Four descriptors ship: `deviceStatus` (30 s), `settings`, `schedules`, `services` (300 s each).
`presence` (30 s) and `vitals` (60 s) are *not* included — `PodClient` deliberately exposes no
`/api/metrics/*` method (its proposal, Non-goals), so #19 adds a client method and a descriptor,
and inherits jitter, backoff, in-flight suppression and stop for free. That is the extension
point; the `enabled` predicate is there so #19 can gate on `services.biometrics.enabled` without
new machinery.

### Cadence arithmetic, in one place

```
effectiveInterval(class) = max(HARD_FLOOR_MS, min(baseIntervalMs, ...activeModes.intervalMs))
delay(class)             = clamp(effectiveInterval × 2^consecutiveFailures,
                                 effectiveInterval,
                                 max(maxBackoffMs, effectiveInterval))
                           × (1 + (random() × 0.2 − 0.1))
```

Three details worth stating because each is a bug if got wrong:

1. **`HARD_FLOOR_MS = 3000`** is a module constant, separate from the *configuration* minimum of
   5 000 ms for `pollIntervalMs`. The alarm window (#16) needs 3 s, which config must not be
   able to request as a steady-state base.
2. **The backoff cap is `max(maxBackoffMs, effectiveInterval)`.** A naive `min(x, 60_000)` would
   make the 5-minute settings class poll *five times more often* while it is failing — the exact
   opposite of backoff. Called out because it is the easy mistake.
3. **Jitter is applied last, to the backed-off delay**, so retries do not synchronise either.

The next delay is computed and scheduled **after the previous poll settles** (a self-rescheduling
`setTimeout`, never `setInterval`). "Skip a tick if the previous poll is still in flight" (#8) is
then structural rather than a guard that can be removed: there is no tick to skip. The spec still
states it as observable behaviour so the property survives an implementation change.

### Poll modes are a stack, and that is how the alarm window (#16) arrives

`poller.requestMode(classId, { intervalMs, untilMs, reason }): () => void`. Active modes are held
in a set; the effective interval is the minimum. This change creates exactly two kinds of mode:

- `reason: 'write'` — `fastPollIntervalMs` until `now + fastPollDurationMs`, requested by the
  write queue after a successful dispatch.
- `reason: 'priming'` — `fastPollIntervalMs`, held while an observation reports `isPriming` and
  released on the first observation that does not. Held as a mode rather than as an ad-hoc flag
  so it composes with the write mode instead of fighting it.

#16 will add `reason: 'alarm'` at `alarmPollIntervalMs` for a window computed from
`/api/schedules` and `settings.timeZone` — both already in the snapshot because this change polls
them. **No poller change is required for #16**; that is the whole reason the schedules class is
polled here despite having no consumer yet.

When a shorter interval becomes effective, the pending timer is cancelled and rescheduled from
the *last poll time*, not from now — otherwise a mode arriving 29 s into a 30 s base delay would
push the next poll out instead of pulling it in.

### Bootstrap: all classes in parallel, deadline-bounded, never rejects

`bootstrap()` fires every enabled class concurrently (the client permits parallelism across
distinct endpoints) and settles when all have, or at `bootstrapTimeoutMs` (default 10 000),
whichever is first. It never rejects, and it starts each class's recurring schedule regardless of
outcome.

The deadline exists because the client's worst case per call is ~8 s + backoff + ~8 s ≈ 16.5 s
(`pod-client/design.md`), and `didFinishLaunching` should not sit on that before accessories are
published. Outstanding polls are not cancelled — they commit to the snapshot whenever they land.
A bootstrap failure counts towards backoff, so a Pod that is down at startup is not hammered.

The fallback when bootstrap yields nothing is `characteristic.value`, which `PlatformAccessory`
persists across restarts — but that is #9/#11's code, not this change's; here it simply means the
class reads as unknown.

### Write queue pipeline: submit → debounce lane → coalesce → reduce → mutex → dispatch → settle

Lanes: `left`, `right`, `device` (the `settings` object carried inside `POST /api/deviceStatus`,
for #20's LED brightness), and `settings` (`POST /api/settings`, expensive, no caller yet).

**Lanes flush independently — left and right are not merged into one body.** They could be: one
`POST /api/deviceStatus` can carry both sides. Rejected because a single Home-app interaction only
ever touches one side, so the merge would almost never fire; because it doubles the bookkeeping
for per-submission promises and overlay handles; and because under away mode a two-side body
interacts badly with the both-sides mirror the guard in #13 has to reason about
(`settings.left.awayMode || settings.right.awayMode`, `updateDeviceStatus.ts`). The mutex means
two lanes flushing together produce two sequential POSTs, which is a rare and acceptable cost.

Debounce is trailing-edge at `writeDebounceMs` (400) with a hard `writeMaxDebounceMs` (2 000)
measured from the first submission of the batch, so a continuous slider drag still reaches the
Pod. #20's "brightness drags need 500 ms+" is served by giving the `device` lane its own,
larger default; the lane descriptor carries its own debounce values.

### The `isOn` / `secondsRemaining` reduction, and why it is not simply "drop `isOn`"

Issue #10 says "drop `isOn` when both are present". That is right in three of the four cases and
**wrong in the fourth**, because of the truthiness guard in `updateSide`:

| Merged patch | Pod's outcome, unreduced | "Always drop `isOn`" | Reduction used here | Result |
|---|---|---|---|---|
| `{isOn: true, secondsRemaining: 600}` | `43200` then `600` → on, 600 | `600` → on, 600 | keep `secondsRemaining` | ✅ matches |
| `{isOn: false, secondsRemaining: 600}` | `0` then `600` → on, 600 | `600` → on, 600 | keep `secondsRemaining` | ✅ matches |
| `{isOn: true, secondsRemaining: 0}` | `43200` then **no-op** → on | `0` → no-op → **unchanged** | keep `isOn` | ✅ matches |
| `{isOn: false, secondsRemaining: 0}` | `0` then **no-op** → off | `0` → no-op → **still on** | keep `isOn` | ✅ matches |

So: **keep `secondsRemaining` when it is non-zero, otherwise keep `isOn`.** This reproduces the
Pod's own outcome in all four cases, which is the only defensible definition of "correct" — the
user's intent is whatever the unreduced patch would have done. `if (secondsRemaining)` is the
guard (`server/src/routes/deviceStatus/updateDeviceStatus.ts`), and `docs/POD-API.md` records
`secondsRemaining: 0` as a silent no-op.

How does the pair even arise? Keep-alive (#12) re-posts `secondsRemaining` on a timer while the
user toggles the side off in the Home app; both land in one 400 ms window.

The mock Pod is the oracle for this: the test asserts, for all four combinations, that the mock's
resulting state after the *reduced* dispatch equals its state after applying the *unreduced*
patch directly. That is a stronger assertion than comparing bodies, and it is only possible
because `pod-test-double` reproduces the guards verbatim.

### One global mutex, and `runExclusive` as the guard extension point

A single FIFO across all lanes and both write endpoints. Justification is #13's, not throughput:
the away-mode guard must read `/api/settings`, decide, and write without an unrelated write
interleaving. `writeQueue.runExclusive(fn)` exposes that section, and is the mechanism #13's
"re-read `/api/settings` ~250 ms after any settings write" and #12's read-decide-write will use.

The Pod serialises hardware access anyway (`sequentialQueue.ts`), so a global write mutex costs
only latency we were going to pay.

### Overlay installed at submission, expiry re-based at dispatch, cleared on failure

Installed at **submission**, not dispatch, because the point is that the UI does not go stale —
and a poll landing during the 400 ms debounce plus the ~8 s round trip would otherwise roll the
value back. Expiry is set to `now + writeSettleMs` on install and **re-based to
`dispatchSettledAt + writeSettleMs`** when the dispatch settles, so time queued in the debounce
and the mutex does not eat the settle window.

On dispatch failure the entries are cleared immediately rather than left to expire: issue #10's
"continuing to lie is worse" applies with more force when we already *know* the write failed.
The submitter's promise rejects at the same moment, which is what lets #9's `onSet` throw
`HapStatusError(SERVICE_COMMUNICATION_FAILURE)` per `docs/HOMEKIT.md`.

Fast poll is requested on **success only** — on failure the poller's backoff is the correct
governor, and a 5 s cadence against an unreachable Pod is just noise.

### Timer, clock and randomness injection

```ts
interface TimerApi {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
  now(): number;
  random(): number;
}
```

Defaults to `globalThis.setTimeout` / `clearTimeout` / `Date.now` / `Math.random`. All three
modules take it. Nothing in `src/pod/{snapshot,poller,writeQueue}.ts` may reference `Date.now`,
`Math.random`, `setTimeout` or `setInterval` directly — enforceable with an ESLint
`no-restricted-globals` rule if it ever drifts.

Why inject rather than rely on `vi.useFakeTimers()` patching globals: fake timers alone do not
make jitter deterministic, and `now()` must come from the *same* clock as the timers or overlay
expiry drifts against poll scheduling in tests. Tests pass a `TimerApi` backed by vitest's fake
timers with `random: () => 0.5` (zero jitter) — and one test supplies a clock that never advances
to prove nothing escapes it.

### Config ownership: named here, defined by `platform-foundation`

These modules take plain options objects (`PollerOptions`, `WriteQueueOptions`) with all
durations in milliseconds and their own defaults. They never see a Homebridge `PlatformConfig`.
`platform-foundation` (#7) validates config and maps it onto these objects; if it nests the keys
under a `polling` object, only its mapping changes.

| Key | Default | Bound | Owner of the value |
|---|---|---|---|
| `pollIntervalMs` | 30 000 | min 5 000 | `deviceStatus` base |
| `fastPollIntervalMs` | 5 000 | min 3 000 | write + priming modes |
| `fastPollDurationMs` | 90 000 | — | write mode window |
| `slowPollIntervalMs` | 300 000 | min 60 000 | settings/schedules/services base |
| `maxBackoffMs` | 60 000 | — | backoff cap |
| `bootstrapTimeoutMs` | 10 000 | min 1 000 | bootstrap deadline |
| `writeDebounceMs` | 400 | min 100 | side lanes |
| `writeMaxDebounceMs` | 2 000 | — | all lanes |
| `writeSettleMs` | 15 000 | — | overlay window (name fixed by #14) |
| `alarmPollIntervalMs` | 3 000 | min 3 000 | reserved for #16, unused here |

All milliseconds with an `Ms` suffix, matching the two keys the issues already name
(`writeSettleMs` in #14, `noResponseAfterMs` in #11). #12's issue text proposes
`keepAliveSeconds`; that key belongs to #12 and the inconsistency is flagged to
`platform-foundation` rather than resolved here.

### The request budget: N = 40

The guardrail scenario, with jitter fixed to zero (`random: () => 0.5`), defaults as above, and
the mock answering instantly:

| t | Event | Requests |
|---|---|---|
| 0 | bootstrap, all four classes | 4 |
| 0 | 80 snapshot reads (Home app opens) | **0** |
| 30, 60, 90, 120 | `deviceStatus` base polls | 4 |
| 60 | 80 snapshot reads (Home app reopens) | **0** |
| 120.0–120.3 | slider drag: 6 submissions to the `left` lane | 0 |
| 120.4 | debounce flushes | 1 write |
| 125.4 … 210.4 | fast mode, every 5 s | 18 |
| 240.4, 270.4 | base polls resume | 2 |
| 300 | slow classes' second poll | 3 |
| | **Total** | **32** |

**N = 40** gives 25 % headroom over the deterministic 32 — enough that adjusting a default or the
exact drag timing does not flake the test, and far below what any regression produces:

- a read handler that contacts the Pod: +160 for the two bursts → ~192;
- fast mode never released: ~35 fast polls instead of 20 → ~47;
- in-flight suppression removed against a slow Pod: unbounded.

One regression the budget does **not** catch is losing write coalescing — 6 POSTs instead of 1
totals 37, still under 40. That is exactly why the assertion is three-part: **≤ 40 total,
exactly 1 write, ≥ 10 device-status reads.** The write count catches coalescing regressions; the
lower bound catches a poller that silently died and would otherwise "pass" with 4 requests.

The burst is 80 reads against an estimated real burst of ~30 (two thermostats plus hub sensors),
deliberately oversized so the assertion stays meaningful as services are added in M4. The test
additionally asserts the *delta* around each burst is zero, which is the sharp form of the
invariant; the total budget is the coarse net that catches everything else.

## Risks / Trade-offs

- **18 fast polls for one slider drag.** 90 s at 5 s is a lot of hardware round-trips for a
  confirm-read, on a socket the Pod is already using every 2 s (`frankenMonitor.ts:86`). → The
  values are config keys, the mode API supports a decaying schedule without redesign, and #15 is
  the designed load check on real hardware. See Open Questions.
- **The overlay can hide a genuine external change for up to `writeSettleMs`.** If the user
  changes the temperature from free-sleep's own web UI within 15 s of a HomeKit write, the poll
  reporting that value disagrees with our overlay and is suppressed until expiry. → Bounded at
  15 s, and the reversion is then emitted. Shortening the window trades this against the
  round-trip time; 15 s is comfortably above the client's ~8 s worst case plus one fast poll.
- **`connection.online` is derived from the device-status class only.** A settings-endpoint
  failure with a healthy status endpoint does not mark the Pod offline. → Correct for #11's
  purpose (the daily reboot takes everything down together), and the per-class failure counts are
  in the snapshot for anything that needs finer detail.
- **The reduction rule silently discards a field the caller submitted.** A caller that submits
  `{isOn: false, secondsRemaining: 600}` gets a side that is *on*. → That is what the Pod does
  with that body; the alternative is to reject and make callers understand `updateSide`'s
  ordering. Logged at debug with both patches, and the equivalence to the Pod's own outcome is
  asserted against the mock for all four cases.
- **Two lanes flushing simultaneously produce two POSTs where one body would do.** → Rare (one
  interaction touches one side), and the mutex bounds the cost to sequential latency.
- **`bootstrapTimeoutMs` can publish accessories with an unknown snapshot.** → Intended: #11's
  fallback is `characteristic.value`, persisted by `PlatformAccessory`, which is strictly better
  than blocking startup for 17 s.
- **The budget's 32 depends on scheduling details this design owns.** A future change to the
  fast-poll shape moves the number. → The test asserts a bound, not the exact count, and the
  derivation table above is the place to update.
- **The Home-app read burst size is an estimate** and can only be measured on a real paired
  device. → Oversized burst plus the zero-delta assertion; #15 measures the real thing.

## Migration Plan

No migration. Three new files, no existing file touched, nothing published to HomeKit yet, and
no persisted state introduced. `pod-client` (#4, #5) must land first. `platform-foundation` (#7)
may land before or after: it consumes the options types defined here, and nothing here consumes
it.

Rollback is deleting three source files and their tests.

## Open Questions

Flagged for tech-lead review; none of them changes the specs, the approach, or the task
breakdown.

1. **Should the post-write fast poll decay instead of holding 5 s for the full 90 s?** As
   specified it is 18 round-trips per user interaction. A decaying shape — say 5 s for the first
   three polls, then 15 s for the remainder of the window — would cut that to ~9 while keeping
   the confirm-read latency identical, and the mode API already supports it (two stacked modes
   with different `untilMs`). Implemented literally per #8 for now; the budget derivation above
   would drop from 32 to ~23.
2. **Should `waterLevelState`'s `unknown` be a watched transition at all?** Watching it means a
   free-sleep version that changes the string flaps the hub's water sensor once on upgrade.
   Suppressing `→ unknown` transitions would hide a genuine sensor fault. Currently watched, as
   specified.
3. **Should `runExclusive` be on the write queue or a standalone mutex module?** It is on the
   queue because the queue is the only thing that owns write ordering today, but #13 and #12 are
   both non-write-queue callers of it, which is a hint that it may want to be its own module.
   Cheap to move later; no spec text changes if it does.

## Resolutions (tech lead, 2026-09-06)

Numbered decisions from the proposal review:

1. **The four-case coalescing rule stands; issue #10's "drop isOn" text is wrong** for
   `{isOn: false, secondsRemaining: 0}` and will be corrected with a comment on the issue
   citing this design. Task 8.2's mock-as-oracle proof is the guard.
2. **N = 40 with the three-part assertion stands** (≤40 total, exactly 1 write, ≥10 reads).
3. **Ship the literal 5 s × 90 s fast poll per #8** (open question 1). The decaying shape is
   a good M3 follow-up once #15's load check can measure it — note it on issue #15 at sync
   time rather than gold-plating now.
4. **`...Ms` naming stands everywhere.** When #12 (M3) lands its config key it should be
   `keepAliveMs`, not `keepAliveSeconds`; flag to platform-foundation's reserved-keys list.
5. **All scope additions accepted** (snapshot `connection` state as data, `runExclusive`,
   `writeMaxDebounceMs`, `bootstrapTimeoutMs`).

Open questions: (1) resolved above — literal now, decay in M3. (2) keep `→ unknown`
watched, as specified — hiding a genuine fault is worse than one flap on a firmware
upgrade. (3) keep `runExclusive` on the queue; revisit only if #12/#13 make it awkward.
`secondsRemaining` unwatched/un-overlayable: agreed, for exactly the stated reasons.
