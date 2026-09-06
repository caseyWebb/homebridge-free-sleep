## Why

`PodClient` (change `pod-client`, #4) can talk to a Pod, but nothing decides *when* to talk
to it. That decision is the load-bearing one in this plugin.

`GET /api/deviceStatus` is a live hardware round-trip serialised through a Unix-socket queue
with a 10 s response timeout (`server/src/8sleep/frankenServer.ts`), and the Home app fires
`onGet` for **every** characteristic when it opens — a dozen-plus reads within a few hundred
milliseconds, across two sides and three accessories. If those reach the Pod they stack
behind each other and the whole bridge stalls. Meanwhile the Pod is already polling itself
every 2 s (Pod 4/5) or 60 s (Pod 3) over that same socket
(`server/src/8sleep/frankenMonitor.ts:86-88`), so our traffic is additive on a queue that is
never idle.

The mirror-image problem is writes. The Home app sends `TargetHeatingCoolingState` and
`TargetTemperature` as two separate writes milliseconds apart, and a slider drag sends a
dozen. Each one that reaches the Pod is another serialised hardware command. And with a 30 s
base poll, a write that is not optimistically reflected leaves the UI stale for up to half a
minute — or, worse, visibly rolled backwards by a poll that started before the write landed.

So: one shared poller per endpoint class feeding one cached snapshot that every `onGet` reads
synchronously, and one write queue that debounces, coalesces, serialises and optimistically
overlays. Both have to exist before any accessory code can be written, and neither can be
retrofitted — "the `onGet` handler is synchronous and never fetches" is an invariant that has
to be guarded by a test from day one.

Resolves #8 and #10 (milestone M2 — Core thermostat).

## What Changes

- **`src/pod/snapshot.ts`** — `SnapshotStore`: the cached, immutable, device-unit view of the
  Pod that every HAP `onGet` reads synchronously. Holds the last successful response per
  endpoint class, a derived connection state, and the write queue's optimistic overlay. Emits
  a **typed, batched change notification** over an enumerated list of watched fields, computed
  on the *effective* (overlay-applied) view — so an overlay suppresses the spurious change a
  disagreeing poll would otherwise produce, and dropping an expired overlay emits the truth.
  This change-event surface is what the thermostat change (#9) subscribes to; nothing in this
  change knows about HAP.
- **`src/pod/poller.ts`** — `PodPoller`: one self-rescheduling poll per endpoint class
  (`deviceStatus`, `settings`, `schedules`, `services`), never two in flight for a class at
  once, ±10 % jitter from an injected randomness source, exponential backoff to a 60 s cap
  with snap-back on the first success, a deadline-bounded bootstrap poll for
  `didFinishLaunching`, and a **stacking poll-mode API** (`requestMode`) that expresses
  fast-poll-after-write and fast-poll-while-priming today and the alarm window (#16)
  tomorrow with no new mechanism.
- **`src/pod/writeQueue.ts`** — `WriteQueue`: per-lane ~400 ms debounce merging patches, a
  **global mutex** across `POST /api/deviceStatus` and `POST /api/settings`, optimistic
  overlay installed at enqueue and re-based on dispatch, fast-poll entry after a successful
  write, and `runExclusive` so the away-mode guard (#13) and the keep-alive (#12) can do a
  read-modify-write inside the same mutex.
- **A merged patch never carries both `isOn` and `secondsRemaining` for one side.** The
  client rejects such a patch pre-flight (`pod-client` design, "Pre-flight rejection", tech-lead
  resolution 1), because `updateSide` applies them in a fixed order with `secondsRemaining`
  last. The queue reduces the pair *before* dispatch, keeping whichever field reproduces the
  Pod's own outcome — `secondsRemaining` when it is non-zero, `isOn` otherwise, because
  `if (secondsRemaining)` makes a zero duration a silent no-op
  (`server/src/routes/deviceStatus/updateDeviceStatus.ts`). A test proves the queue can never
  trip the client's rejection.
- **Two guardrail tests, both with fake timers.** (1) A simulated 5-minute Home-app session —
  an 80-read burst at t=0 and again at t=60 s, plus a slider drag — hits the mock Pod **no
  more than 40 times**, with **exactly one** write. (2) A `TargetHeatingCoolingState` +
  `TargetTemperature` pair produces **exactly one** `POST /api/deviceStatus` with the correct
  merged body.
- **Config keys are named here but defined by `platform-foundation`** (#7, in flight). These
  modules take plain options objects and never read a Homebridge `PlatformConfig`; the
  platform normalises config into those objects. Requested keys, all milliseconds to match
  `writeSettleMs` (#14) and `noResponseAfterMs` (#11): `pollIntervalMs` (30 000, min 5 000),
  `fastPollIntervalMs` (5 000), `fastPollDurationMs` (90 000), `slowPollIntervalMs` (300 000,
  min 60 000), `maxBackoffMs` (60 000), `writeDebounceMs` (400), `writeMaxDebounceMs` (2 000),
  `writeSettleMs` (15 000), and `alarmPollIntervalMs` (3 000, reserved for #16).

**Done when:** `npm test` is green with both guardrail tests passing against the mock Pod
under fake timers, and `npm run lint` / `npm run typecheck` / `npm run build` stay green.

## Non-goals

- **No HAP, no accessories, no `updateCharacteristic`.** The poller emits typed change events
  in device units; subscribing them to characteristics is #9. Nothing in these three modules
  imports Homebridge or HAP-NodeJS.
- **No temperature conversion.** Everything here is integer °F and booleans — that is the
  whole point of diffing in device units (#6, #14).
- **No shadow `publishedF` / slider-jitter suppression** (#14). That lives in the accessory
  layer, on top of these change events.
- **No "No Response" policy** (#11). The snapshot exposes connection state as data; deciding
  when `onGet` starts throwing, and driving the `ContactSensor`, is #11's.
- **No keep-alive** (#12). The queue provides `runExclusive` and a `secondsRemaining` lane;
  nothing schedules a re-arm.
- **No away-mode write guard** (#13). The global mutex and `runExclusive` exist so #13 can be
  written without racing, but no write is blocked or mirrored here, and no `awayModeWritePolicy`
  is read.
- **No alarm-window scheduling** (#16). `requestMode` accepts an arbitrary interval down to a
  3 s floor, which is the mechanism #16 needs; nothing in this change computes an alarm window
  from `/api/schedules`.
- **No `/api/metrics/presence` or `/api/metrics/vitals` polling.** `pod-client` deliberately
  does not expose those endpoints (its proposal, Non-goals); the poller's endpoint-class
  registry is data-driven so #19 adds a descriptor rather than a mechanism.
- **No config schema, no `config.schema.json`, no defaults resolution.** That is
  `platform-foundation` (#7). This change names the keys and consumes typed options.
- **No response caching in `PodClient`.** The cache is the snapshot store's, and it is never
  served as the result of an explicit read request.
- **No brightness / LED / prime behaviour** (#20). The device-settings lane exists and is
  debounced; nothing populates it.

## free-sleep API endpoints touched

| Endpoint | Used by | Cost |
|---|---|---|
| `GET /api/deviceStatus` | poller, base 30 s / fast 5 s | **Expensive** — live hardware round-trip over the Unix socket, serialised behind a 10 s response timeout (`server/src/8sleep/frankenServer.ts`). Every cadence decision in this change exists for this one endpoint. |
| `POST /api/deviceStatus` | write queue (side lane, device-settings lane) | Cheap. Issues per-field hardware commands and `SET_SETTINGS`; it does **not** write LowDB and so does **not** trigger a job rebuild (`server/src/routes/deviceStatus/updateDeviceStatus.ts`, `docs/POD-API.md`). |
| `GET /api/settings` | poller, 5 min | Cheap LowDB JSON read. Read for `awayMode`, `timeZone`, `temperatureFormat`, side names. |
| `GET /api/schedules` | poller, 5 min | Cheap LowDB JSON read. Cached now so #16 can compute alarm windows without adding a poll. |
| `GET /api/services` | poller, 5 min | Cheap LowDB JSON read (`biometrics.enabled`), the gate #19 will need. |
| `POST /api/settings` | write queue (settings lane) — **no caller in this change** | **EXPENSIVE WRITE.** Writes `settingsDB.json`, which `server/src/jobs/jobScheduler.ts` chokidar-watches; every write cancels and rebuilds every scheduled job on the Pod. The lane exists so the mutex genuinely spans both write endpoints (#13's requirement); it is exercised only against the mock Pod, and **nothing in this change issues a settings write against real hardware**. |

No polling loop in this change ever writes. The only writes are user-initiated ones handed to
the queue by a caller that does not yet exist.

## Capabilities

### New Capabilities

- `pod-snapshot`: the cached, immutable, device-unit view of Pod state that HAP reads
  synchronously — what it holds, how the optimistic overlay composes with observed truth, and
  the typed batched change-notification surface later accessory changes subscribe to.
- `pod-poller`: when the plugin talks to the Pod — one shared poll per endpoint class, the
  interval table and its bounds, jitter, in-flight suppression, the stacking poll-mode API,
  backoff and recovery, bootstrap semantics, and the request budget for a Home-app session.
- `pod-write-queue`: how user intent becomes Pod traffic — per-lane debounce and coalescing,
  the mutually-exclusive-duration-field reduction, the global write mutex and its
  `runExclusive` extension point, optimistic overlay lifecycle, and post-write fast poll.

### Modified Capabilities

None. `pod-client` and `pod-test-double` are consumed unchanged — in particular the mock Pod's
recording and fault-injection surface is used exactly as its spec promises ("A later change
reuses the mock unchanged").

## Impact

- **Files added**: `src/pod/snapshot.ts`, `src/pod/poller.ts`, `src/pod/writeQueue.ts`,
  `test/snapshot.test.ts`, `test/poller.test.ts`, `test/writeQueue.test.ts`,
  `test/pollBudget.test.ts`.
- **Files modified**: none. No `package.json`, `tsconfig*.json`, or existing source change.
- **Dependencies**: none added. Timers, randomness and the clock are injected; the modules
  import only `src/pod/client.js`, `src/pod/types.js` and `src/pod/errors.js`.
- **Depends on**: `pod-client` (#4, #5) must land first — `PodClient` and the mock Pod are
  both hard prerequisites.
- **Coordination**: `platform-foundation` (#7) is in flight concurrently and owns the config
  keys listed above. Neither change imports the other: this change defines the options types
  it consumes, and #7 maps config onto them. If #7 nests the keys, only its mapping changes.
- **Systems**: the whole test suite still runs offline with no Pod. No hardware verification
  is required to land this change; the real-hardware load check is #15.
