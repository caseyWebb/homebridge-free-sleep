## Context

See proposal.md — Why. Every Pod-behaviour claim below cites a path in the free-sleep
checkout at `~/Code/free-sleep`, pinned at **v2.1.5, commit `dc0c710`** (the same point
`docs/POD-API.md` was verified against).

Pre-existing state this design builds on:

- The repo has `src/settings.ts` and nothing else under `src/`. `test/` holds an empty
  `fixtures/`.
- The in-flight `tooling-and-ci` change (#1) adds vitest, ESLint, CI, a `tsconfig.build.json`
  split, and `zod` as a devDependency. **This change assumes that has landed** and edits its
  output (see "Coordination with `tooling-and-ci`" below).
- No Pod is reachable from the development machine; ADR-0001 governs how that is handled.

Constraints from free-sleep that shape everything here:

- `GET /api/deviceStatus` is a live hardware round-trip. The route calls
  `franken.getDeviceStatus()` (`server/src/routes/deviceStatus/deviceStatus.ts`), and
  `connectFranken`/`FrankenServer` serialise all socket traffic through one queue with a 10 s
  response timeout and a 25 s connect timeout (`server/src/8sleep/frankenServer.ts`).
- Both `POST /api/deviceStatus` and `POST /api/settings` validate with
  `<Schema>.deepPartial().safeParse(body)` and return `400 {error, details}` on failure
  (`server/src/routes/deviceStatus/deviceStatus.ts`, `server/src/routes/settings/settings.ts`).
  Because the source schemas are `.strict()`, `deepPartial()` keeps the unknown-key rejection.
- `updateSide` applies fields with truthiness guards and in a fixed order
  (`server/src/routes/deviceStatus/updateDeviceStatus.ts`).

No claim in this document concerns HomeKit or HAP: this change publishes no accessories and
registers nothing with HAP-NodeJS, so there is nothing here that needs confirmation on a real
paired device. The one hardware-dependent claim is the *Pod-side* one — that a real Pod's
`deviceStatus` response matches the vendored shape and omits `taps` — and that is exactly what
the smoke script and #3 exist to confirm.

## Goals / Non-Goals

**Goals:**

- One direction of dependency, no cycles: `client.ts → types.ts`, `errors.ts` standalone,
  and the mock strictly test-only.
- The mock is the *specification* of Pod write semantics for this repo. If the mock and the
  prose disagree, the mock is the bug report.
- Fixtures and mock share one source of truth, so a real capture upgrades every mock-based
  test at once.
- The client is dumb transport with a resilience policy — no plugin policy, no state.

**Non-Goals:**

- A general-purpose HTTP library. This client speaks to exactly one server on one LAN.
- Response caching of any kind. Deduplication is *in-flight only*; a read issued after the
  previous one resolved always hits the Pod. Caching is the poller's job (#8).
- Type-level exhaustiveness against every free-sleep version. We vendor one pinned version
  and parse leniently.

## Module dependency direction

```
src/pod/errors.ts        (no imports)
src/pod/types.ts         (imports: zod)                     ← vendored wire contract
src/pod/client.ts        (imports: ./types.js, ./errors.js) ← the only network code
scripts/smoke.ts         (imports: src/pod/client.js, src/pod/types.js)

test/fixtures/*.json     (data; no imports)
test/mockPod.ts          (imports: node:http, ./fixtures/*.json, ../src/pod/types.js)
test/*.test.ts           (imports: ../src/pod/*.js, ./mockPod.js)
```

Rules this encodes, enforceable by inspection and by an ESLint `no-restricted-imports` rule
if it ever drifts:

1. **`types.ts` imports nothing from this project.** It is the leaf. Vendored data
   definitions plus `z.infer` types plus one pure helper (`interpretWaterLevel`).
2. **`client.ts` depends on `types.ts` and `errors.ts`, and on nothing else in `src/`.** It
   never imports Homebridge, HAP, or any accessory module — so it stays unit-testable with no
   Homebridge runtime, and so M2 accessories can depend on it without a cycle.
3. **Nothing in `src/` imports anything from `test/`.** The mock is test-only and never
   ships: `tsconfig.build.json` compiles `src/` only, and `package.json` `files` is `dist` +
   `config.schema.json`, so `test/mockPod.ts` cannot leak into the published package.
4. **`test/mockPod.ts` imports `src/pod/types.ts` only** — never `client.ts`. The mock must
   not be able to "agree with" the client by construction; they are the two independent halves
   of the contract. It uses the vendored *request* schemas to validate bodies, which is
   legitimate: both sides are copies of what the Pod enforces, and the fixture-parsing test
   plus the real capture in #3 are what check that copy against reality.

## Decisions

### `types.ts` vendors runtime zod schemas, not bare TypeScript types

Issue #2 says "vendor the types". We vendor the *schemas* and derive the types with
`z.infer`, because the acceptance criterion in #3 — "types parse the fixtures without error" —
requires a runtime parser, and because the mock needs the strict request schemas to reproduce
the Pod's 400s. `zod` therefore graduates from devDependency to runtime dependency.

The file is organised in four blocks, one per upstream source file, each with a header
comment naming the upstream path, version and commit:

| Block | Upstream source |
|---|---|
| device status | `server/src/routes/deviceStatus/deviceStatusSchema.ts` |
| settings | `server/src/db/settingsSchema.ts` |
| schedules | `server/src/db/schedulesSchema.ts` |
| services | `server/src/db/servicesSchema.ts` (needed for the `services.json` fixture in #3) |

Alternatives considered:

- *Depend on free-sleep as a git dependency.* Rejected for the reason in #2: upstream already
  duplicates these schemas between `server/src/db/` and `app/src/api/` with an explicit
  "WARNING! — Any changes here MUST be the same between app/src/api & server/src/db/" header
  (visible at the top of `server/src/routes/deviceStatus/deviceStatusSchema.ts`), and the repo
  ships committed build artifacts.
- *Hand-written `interface`s, no zod.* Cheaper, but then "the fixtures parse" is not a test,
  just a compile, and the mock's 400 behaviour has to be reimplemented by hand.

### Read schemas are lenient; request schemas are strict

Two variants of each shape, applied uniformly across all four blocks (device status,
settings, schedules, services) — not just device status (B1 in the pod-client code review:
the first pass of this file only applied the read/request split to device status, leaving
settings' tap discriminated union and `.min`/`.max` amounts, its `temperatureFormat` enum, and
schedules' `TimeSchema` regex still enforcing request-side constraints on responses):

- **Read** (`DeviceStatusSchema`, `SettingsSchema`, `SchedulesSchema`, `ServicesSchema`): plain
  `z.object()` (strip mode) instead of `.strict()`, no `.min(55).max(110)` on
  `targetTemperatureF`, no tap `type` discriminant or `amount`/`snoozeDuration` bounds, no
  `temperatureFormat` enum, no `TimeSchema` `HH:mm` regex — every value-level constraint that
  exists only to validate a *request* is dropped from the read side.
- **Request** (`DeviceStatusPatchSchema`, `SettingsPatchSchema`): `.strict()`, `.int()`,
  `.min(55).max(110)`, the tap discriminated union with its bounds, the `temperatureFormat`
  enum — a local mirror of what the Pod enforces.

Rationale, all Pod-side:

- The Pod **never validates its own responses**. `GET /api/deviceStatus` is
  `res.json(await franken.getDeviceStatus())` with no `safeParse`
  (`server/src/routes/deviceStatus/deviceStatus.ts`), and `GET /api/settings` is
  `res.json(settingsDB.data)` (`server/src/routes/settings/settings.ts`). A strict read schema
  would therefore fail on data the Pod is perfectly happy to emit — e.g. a free-sleep version
  newer than the one we vendored adding a field, or a tap `type` / `temperatureFormat` value
  a newer client wrote into `settingsDB.json` that this older client has never heard of. Given
  the Pod reboots daily and a poll failure degrades the whole plugin, "reject the snapshot" is
  the wrong failure mode.
- `targetTemperatureF` on read comes from `calculateTempInF` over a hardware level
  (`server/src/8sleep/loadDeviceStatus.ts`), not from the validated write path, so it is not
  guaranteed to sit inside 55–110. Rejecting a whole snapshot over one out-of-range reading
  would be self-inflicted. The same logic applies to a tap's `amount`/`snoozeDuration` and to
  a schedule's `time` string: none of them are re-validated once persisted to
  `settingsDB.json`/`schedulesDB.json`, so a read schema that enforces the request-side bound
  can fail on data that got there validly at write time under an older bound, or via a
  hand-edited DB.
- Conversely a *write* outside any of these bounds is guaranteed to come back 400 from the
  Pod, so failing locally is strictly better: it costs no round-trip and produces a better
  error.

`taps` stays in the read schema as `.optional()` exactly as upstream declares it
(`deviceStatusSchema.ts`), even though the HTTP route never populates it —
`Franken.getDeviceStatus(getGestures = false)` defaults gestures off
(`server/src/8sleep/frankenServer.ts:89`) and the route calls it with no argument. Keeping the
optional field means a Pod that *does* return it parses fine; the fixture test asserting its
absence (below) is what turns that into a loud signal.

Trade-off: passthrough means a typo'd field in a *response* is silently ignored. Acceptable —
we do not control responses. Structural errors (missing field, wrong type) still fail, which
is what actually catches a version mismatch.

### `waterLevel`: raw string plus a three-state interpretation

`waterLevel` is `z.string()` upstream, and free-sleep's UI treats `"true"` as fine, `"false"`
as low, and warns on anything else
(`app/src/pages/ControlTempPage/WaterNotification.tsx`). We keep the raw string on the parsed
type and add:

```
type WaterLevel = 'ok' | 'low' | 'unknown';
interpretWaterLevel(raw: string): WaterLevel
```

`'unknown'` deliberately does **not** collapse into `'low'`. A HomeKit low-water alert that
fires because free-sleep changed a string is worse than one that stays silent; the hub
accessory (#20) will decide how to present `'unknown'`, and that decision belongs there.

### Fixtures: synthetic, seeded from upstream's mock data, named for the capture command

Per ADR-0001 the fixtures are generated from free-sleep's own seed factories in
`app/src/mocks/mockData.ts` — `createDeviceStatus()` (line 310), `createSettings()` (197),
`createSchedules()` (120), `createServices()` (257) — serialised to JSON. That data is written
against the same zod schemas the Pod's server validates with, which makes it the
highest-fidelity source available without hardware.

Layout:

```
test/fixtures/README.md                        provenance table + capture/swap procedure
test/fixtures/deviceStatus.json                ← #3 capture target
test/fixtures/settings.json                    ← #3 capture target
test/fixtures/schedules.json                   ← #3 capture target
test/fixtures/services.json                    ← #3 capture target
test/fixtures/deviceStatus.bothOff.json        permanently synthetic variant
test/fixtures/deviceStatus.waterLow.json       permanently synthetic variant
test/fixtures/deviceStatus.waterUnknown.json   permanently synthetic variant
```

The four canonical names match #3's `curl … > test/fixtures/<name>.json` commands exactly, so
a real capture is `curl | jq > <same path>` with no code change. The variants are hand-derived
and stay synthetic forever; the README marks them so.

Two deliberate departures from upstream's seed values in the canonical `deviceStatus.json`:

- `isPriming` is set to `false`. Upstream's mock ships `isPriming: true`, which is a UI demo
  state, not a resting state.
- `freeSleep.version` is set to `2.1.5` / `branch: main` to match the version we vendored
  from, rather than upstream's mock value of `1.2.0`.

`coverVersion` / `hubVersion` keep upstream's `"Pod 5"`. This is the value most likely to be
wrong for the actual unit — `docs/POD-API.md`'s example shows `"Pod 3"` — and it is exactly
the risk ADR-0001 names. Nothing in this change branches on it; the smoke script prints it.

Two automated checks over the fixtures:

1. **Parse**: every fixture through its read schema. Table-driven so adding a fixture without
   adding it to the table is itself caught.
2. **No `taps`**: `deviceStatus.json` must not contain `taps`, with a failure message stating
   that the assumption behind #21 has been invalidated. This is the tripwire #3 asks for, and
   it only becomes meaningful once a real capture lands — which is precisely why it is written
   now rather than later.

### The mock is a `node:http` server, not MSW — and only upstream's *data* is vendored

Issue #5 suggests vendoring upstream's 599-line mock and 199-line MSW handler set. Having read
both, the recommendation is: **vendor the seed data (as fixtures, above); write the semantics
and the transport ourselves.** Justification:

1. **Upstream's mutators implement none of the five behaviours.** `updateDeviceStatus` in
   `app/src/mocks/mockData.ts:532` is `deviceStatus = mergeDeep(clone(deviceStatus), partial)`
   — a naive recursive merge. It does not derive `isOn` from `secondsRemaining`, does not
   expand `isOn: true` to 43200, does not no-op on `secondsRemaining: 0`, does not mirror away
   mode, and does not validate at all (so it never returns 400). `updateSettings` (523) and
   `updateSchedules` (517) are the same merge. It is a UI demo double, not a semantics model.
   Every behaviour #5 lists would have to be layered on top, replacing the mutators entirely —
   so the vendoring would save only the seed data, which we are taking anyway.
2. **MSW is the wrong layer for what #4 is about.** MSW intercepts at the fetch/XHR layer. The
   client's whole reason to exist is transport resilience: an `AbortSignal.timeout` firing
   mid-response, a connection reset before headers, a 5xx retried once. Testing those against
   an interceptor tests our mock of the transport, not the transport. A real socket on
   `127.0.0.1` tests the real thing — including that `AbortSignal` actually aborts an
   `undici` request.
3. **The handlers are not trivially adaptable.** `app/src/mocks/handlers.ts` is browser MSW v2
   with `HttpResponse.eventStream` and four `@ts-expect-error` suppressions, relative-URL
   patterns (`'/api/services'`) that need rewriting for `setupServer`, and `delay()` calls
   throughout. Adapting it costs about as much as writing a `node:http` router for six routes,
   and leaves us with an MSW dependency we otherwise do not need.
4. **Zero new dependencies.** `node:http` is built in. Six routes, one `switch` on
   `method + pathname`, `JSON.parse` on the body.

Alternatives considered: `msw/node` (rejected, above); Express (a runtime dep for six routes,
and Express's own body parsing/error handling would sit between us and the wire); a fake
`fetch` implementation (fastest, but tests nothing about real aborts or sockets, which is the
point).

### Mock shape and the command log

```
const pod = await startMockPod({ state?, fixtures? });
pod.url            // http://127.0.0.1:<ephemeral>
pod.state          // live, readable and writable by the test
pod.requests       // RecordedRequest[]: method, path, headers, body, status, at
pod.commands       // Command[]: the ordered hardware commands a write expanded into
pod.fault(endpoint, { kind: 'status'|'hang'|'hangMidBody'|'reset', status?, times })
pod.reset()        // restore seed state, clear requests and commands
await pod.close()
```

Port `0` gives an ephemeral port so parallel vitest files cannot collide. `close()` calls
`server.close()` plus `closeAllConnections()` so a keep-alive socket cannot keep the process
alive.

**`pod.commands` is how the fixed ordering becomes assertable.** Recording only the HTTP
request cannot show ordering, because the order lives in how one body expands into several
sequential hardware calls. The mock mirrors `updateSide`'s expansion
(`server/src/routes/deviceStatus/updateDeviceStatus.ts`) into named entries — the same names
upstream passes to `executeFunction`:

- top level: `PRIME` → left side → right side → `SET_SETTINGS`
- per side: `LEFT|RIGHT_TEMP_DURATION` (from `isOn`, `'43200'` or `'0'`) →
  `TEMP_LEVEL_LEFT|RIGHT` (from `targetTemperatureF`) → `LEFT|RIGHT_TEMP_DURATION` (from
  `secondsRemaining`) → `ALARM_CLEAR` (from `isAlarmVibrating`, recorded with no `side` at
  all — upstream calls `executeFunction('ALARM_CLEAR', 'empty')` with no side argument,
  unlike every other per-side command name; N4 in the pod-client code review)

so `{ left: { isOn: true, secondsRemaining: 600 } }` produces
`['LEFT_TEMP_DURATION 43200', 'LEFT_TEMP_DURATION 600']` in that order and leaves 600 — which
is `docs/POD-API.md`'s "never put `isOn` and `secondsRemaining` in the same patch" as an
executable fact.

The truthiness guards are copied literally, comment and all: `if (isOn !== undefined)`,
`if (targetTemperatureF)`, `if (secondsRemaining)`, `if (isAlarmVibrating !== undefined)`.
`if (secondsRemaining)` is the zero no-op; `if (targetTemperatureF)` is the same bug for
temperature, harmless because 0 is out of range anyway.

Away mirroring is `const controlBothSides = state.settings.left.awayMode ||
state.settings.right.awayMode;` — the same expression as upstream, deliberately verbatim so
the coupling is unmistakable to a reader.

Response codes match upstream exactly: `POST /api/deviceStatus` → `204` with an empty body;
`POST /api/settings` → `200` with the whole merged settings document, `id` intact — `settings.ts`
deletes `id` only from the *request* body before merging (so a caller can never overwrite the
stored id), then responds with `res.json(settingsDB.data)`, the stored document, id and all;
validation failure → `400 {error: 'Invalid request data', details: [...]}` on all POST routes.

`POST /api/deviceStatus` validates against `types.ts`'s `UpstreamDeviceStatusPatchSchema`, not
`DeviceStatusPatchSchema` (S3 in the pod-client code review). The latter is `PodClient`'s own
outgoing contract — the handful of fields it has a defined write policy for — and is narrower
than what the real Pod's own request validation
(`DeviceStatusSchema.deepPartial().safeParse(body)`,
`server/src/routes/deviceStatus/deviceStatus.ts`) actually accepts: `currentTemperatureF`,
`currentTemperatureLevel`, `taps`, `waterLevel`, `coverVersion`, `hubVersion`, `freeSleep`,
`wifiStrength` are all structurally valid in a request body even though nothing branches on
them (`updateDeviceStatus.ts` only destructures the fields it has semantics for). A body the
mock receives did not necessarily come from `PodClient` — `test/mockPod.test.ts` posts raw
bodies directly — so the mock validates against the *upstream-equivalent* schema, or it would
400 a body a real Pod accepts.

A `pod.fault(..., { kind: 'hangMidBody' })` writes response headers and a deliberately
unterminated partial JSON body chunk, then never ends the response — reproducing a timeout
that fires *after* `fetch()` has already resolved a `Response`, mid-`response.text()` (B2).

### How later changes reuse the mock

- **#8 `PodPoller`**: seeds a state, advances vitest fake timers, and asserts
  `pod.requests.filter(r => r.path === '/api/deviceStatus').length` — proving the "one shared
  poll" invariant that the whole architecture rests on. Needs `pod.state` mutation between
  polls to test change diffing.
- **#10 `WriteQueue`**: fires a burst of writes and asserts on `pod.requests` — that N HomeKit
  characteristic writes coalesced into one POST, and that the coalesced body is correct. This
  is the recording #5 exists for.
- **#12 keep-alive**: asserts the periodic `secondsRemaining` re-post appears in
  `pod.commands` at the right cadence, and — using the zero no-op — that a keep-alive can
  never accidentally stop the bed.
- **#13 away guard**: seeds `settings.left.awayMode = true` and asserts, via `pod.commands`,
  that a write intended for the right side hit both sides — then that the guard prevents the
  plugin from issuing it.
- **#11 offline handling**: `pod.fault(..., { kind: 'reset', times: n })` and `close()`/restart
  to simulate the daily reboot.

To keep that reuse honest, the mock deliberately implements **no plugin policy**: no write
deduplication, no away guard, no coalescing. It models the Pod, so those policies remain
testable by asserting on the recording rather than being masked by it.

### Client: concurrency, dedupe, retry

**Endpoint key.** One entry per `${method} ${pathname}` — `GET /api/deviceStatus` and
`POST /api/deviceStatus` are separate keys, so a poll in flight does not delay a user's
write, and vice versa. This matters: the Pod serialises hardware access itself
(`server/src/8sleep/frankenServer.ts`), so queuing a write behind a read on our side only
adds latency without reducing load on the Pod.

**Serialisation.** Each key holds a promise chain; a new request awaits the settled tail
before starting. Deliberately not a general semaphore — depth 1 is the requirement.

**Dedupe.** GET only, and keyed on method + path + query. If an identical GET is in flight,
the new caller receives the same promise. Never for POST: two identical writes are two
deliberate commands (a keep-alive re-post is *literally* an identical repeated write, and
#12 depends on both being sent).

The physical (deduped) request runs under no particular caller's `AbortSignal` at all — each
caller instead races its *own* signal against the shared promise. Coupling the shared request
to whichever caller happened to arrive first was a real bug (S1 in the pod-client code
review): caller A aborting would abort the underlying fetch out from under a caller B deduped
onto the same in-flight GET, and a caller whose signal was already aborted before it even
called in would prevent the shared request from starting at all. Decoupling means (a) any one
caller's abort — including one that already fired — only ever rejects that caller's own await,
and (b) the shared physical request is unaffected by, and outlives, any single caller's abort.

Deduplicated callers share one resolved object, so the client returns a value that cannot be
mutated across callers. Chosen: `structuredClone` per caller. Alternative
(`Object.freeze` deep) rejected — it makes the value awkward for callers that legitimately
want to build a modified copy, and silently no-ops mutations in non-strict contexts.

**Timeout.** `AbortSignal.timeout(8000)` per *attempt*, combined with any caller signal via
`AbortSignal.any([callerSignal, AbortSignal.timeout(8000)])`. 8 s is under the Pod's 10 s
response timeout (`server/src/8sleep/frankenServer.ts`) so we give up before the Pod does; the
Pod's 25 s connect path means an unlucky first request after its daily reboot will time out,
which the retry covers. Worst case for one call is therefore ~8 s + backoff + 8 s ≈ 16.5 s —
acceptable because no HAP `onGet` ever awaits this (they read the poller's cache; see
`docs/POD-API.md`, "The four things that shape the whole plugin").

The timeout can fire after `fetch()` has already resolved a `Response` — headers arrived, but
the body is still streaming — and `response.text()` rejects the same way an aborted `fetch()`
call does. Both the header round-trip and the body read must therefore sit inside the same
try/catch that maps errors to `PodTimeoutError`/`PodNetworkError`/`PodAbortError` (B2 in the
pod-client code review); reading the body outside that block let a mid-body timeout reject
with a raw `DOMException` instead, and skipped the retry a timeout is supposed to get.

**Retry.** At most one, after ~500 ms plus jitter. Retry on: a network-level error, or 5xx.
Do not retry: any 4xx, a caller abort, or a response-shape error.

Retrying a **write** is safe here, and that needs stating rather than assuming: every command
`updateSide` issues is an idempotent *set* — `LEFT_TEMP_DURATION '43200'`,
`TEMP_LEVEL_LEFT <level>`, `ALARM_CLEAR` — never a delta
(`server/src/routes/deviceStatus/updateDeviceStatus.ts`), and `POST /api/settings` is an
`_.merge` of the same body (`server/src/routes/settings/settings.ts`). Re-applying either
converges to the same state, including when the Pod partially applied the first attempt before
failing. This safety argument does **not** extend to `POST /api/alarm`, which fires an alarm
as a side effect (`server/src/jobs/alarmScheduler.ts`); when #16 adds it, it must opt out of
retry. Recording that here so the reasoning survives to the change that needs it.

A 400 is never retried because the Pod's `.strict()` `deepPartial()` parse rejected our body
(`server/src/routes/deviceStatus/deviceStatus.ts`); the payload will not become valid on a
second attempt, and the 400 body's `details` array is the diagnostic.

**Error taxonomy** (`src/pod/errors.ts`), all extending `PodError` so a caller can
`catch (e) { if (e instanceof PodError) … }`:

| Error | Raised when | Retryable |
|---|---|---|
| `PodNetworkError` | connection refused / reset / DNS failure | yes |
| `PodTimeoutError` | our 8 s abort fired | yes |
| `PodBadRequestError` | HTTP 400 (carries `status`, `details`) | **never** |
| `PodHttpError` | any other non-2xx (carries `status`, body text) | 5xx only |
| `PodResponseError` | body did not parse against the read schema | no |
| `PodRequestError` | our own pre-flight validation rejected the payload | n/a — never sent |
| `PodAbortError` | the caller's signal aborted | never |

`PodNetworkError` and `PodTimeoutError` are the two #11 will treat as the Pod's normal daily
reboot rather than a fault, which is why they are distinct types rather than one flag.

### Pre-flight rejection of `isOn` + `secondsRemaining` in one patch

`PodRequestError` is raised locally, before any request, for a device-status patch that sets
both `isOn` and `secondsRemaining` for the same side. `updateSide` applies `isOn` first and
`secondsRemaining` last, each as a separate serialised hardware command, so the explicit
duration silently wins — `docs/POD-API.md` calls this out as "never put `isOn` and
`secondsRemaining` in the same patch"
(`server/src/routes/deviceStatus/updateDeviceStatus.ts`).

Placing this in the client rather than in the write queue (#10) is a judgement call: the
conflict is a property of the wire protocol, not of plugin policy, so every future caller gets
the guard for free rather than #10 owning a rule #12 also needs. The cost is that the client
knows one semantic fact about the payload it carries. **Flagged for tech-lead review** — see
Open Questions.

### Smoke script

`scripts/smoke.ts`, run as `npm run smoke -- <host>`. Reads `deviceStatus`, `settings`,
`schedules`, `services` through the real `PodClient` (so the script also exercises the client's
timeout and error paths against real hardware) and prints: reachability, `coverVersion` /
`hubVersion` / `freeSleep.version`, the raw `waterLevel` string *and* `interpretWaterLevel`'s
verdict, **whether `taps` was present** (answering #3's open question directly), per-request
latency, and `biometrics.enabled` from `/api/services`. Exits non-zero with the error's type
name and the host on failure.

It performs **no writes**, so it cannot trigger the job rebuild that `settingsDB.json` /
`schedulesDB.json` writes cause (`server/src/jobs/jobScheduler.ts`) and cannot disturb a bed
someone is sleeping in. `test/smoke.test.ts` (N7 in the pod-client code review) is the
regression test for that claim: it drives the script's exported, `argv`-parameterised `main()`
against a mock Pod and asserts every recorded request is a `GET`.

`parseHostArg`'s `<host>[:<port>]` split needs its own IPv6 handling (N6): a bracketed
`[<addr>]` or `[<addr>]:<port>` (RFC 3986 §3.2.2) is parsed out same as the plain-host case,
while a bare (unbracketed) address with more than one colon — an IPv6 literal is itself full of
colons — is treated as host-only, since there is no unambiguous place to split off a port
without the brackets.

Execution: `node --experimental-strip-types scripts/smoke.ts <host>` (Node ≥ 22.6; type
stripping is unflagged from 22.18 / 24). The script and the modules it imports therefore avoid
TypeScript features that need transformation rather than erasure — no `enum`, no `namespace`,
no parameter properties. That constraint costs nothing here and avoids adding `tsx` as a
dependency for one manual script.

### Coordination with `tooling-and-ci`

Two files are edited by both changes; `tooling-and-ci` (#1) must merge first.

- `package.json`: move `zod` from `devDependencies` to `dependencies`; add
  `"smoke": "node --experimental-strip-types scripts/smoke.ts"`.
- `tsconfig.json`: add `"scripts/**/*.ts"` to `include` so `npm run typecheck` covers the
  smoke script. `tsconfig.build.json` stays `src/`-only, so `scripts/` and `test/` are
  typechecked but never emitted or published.

No requirement of the `build-tooling` capability changes — the gates keep their meaning, they
just cover one more directory.

## Risks / Trade-offs

- **The synthetic fixtures may not match the real unit** — `coverVersion`, the exact
  `waterLevel` string, or a `settings` shape from a different free-sleep version. → ADR-0001's
  accepted risk. Mitigated by deriving from upstream's own schemas, by lenient read parsing so
  a mismatch degrades rather than fails, by the canonical filenames making a swap a plain
  overwrite, and by #3 staying open as the tripwire.
- **The mock could drift from the real Pod, and it is the executable spec** — every test would
  agree with a lie. → Every semantic in the mock cites a specific upstream line, the truthiness
  guards are copied verbatim rather than paraphrased, and the smoke script is the out-of-band
  check. Residual risk is real and only a live capture retires it.
- **Lenient read parsing hides response typos.** A field we misspelled in the vendored schema
  would simply come back `undefined` instead of failing. → The fixture-parsing test catches it
  for the fields the fixtures exercise; the smoke script prints enough of a real response to
  catch it for the rest.
- **8 s is a guess against a 10 s Pod timeout.** If free-sleep's socket queue is deeper than
  expected under real load, a healthy Pod could exceed 8 s and every read would retry, doubling
  the load — the opposite of the intent. → #15 (load check: no new franken timeouts) is the
  designed follow-up, and the value is a constructor option so it can be tuned without a code
  change.
- **Endpoint-keyed concurrency does not limit *total* concurrency.** Six endpoints could be in
  flight at once. → Only the poller and the write queue ever call this, and both are
  single-flight by construction; the Pod serialises hardware access itself
  (`server/src/8sleep/frankenServer.ts`), so the exposure is queue latency, not lost commands.
- **`--experimental-strip-types` constrains what `src/pod/*` may use.** A future `enum` in
  `types.ts` would break `npm run smoke` and nothing else. → Documented in the script's header;
  the fallback is `npx tsx`.
- **This change and `tooling-and-ci` touch the same two files.** → Stated merge order; the
  edits are additive (one keyword, one script, one `include` entry) so a conflict is trivial.

## Open Questions

These do not change the specs, the approach, or the task breakdown, and are flagged for
tech-lead review rather than guessed at:

1. **Does the `isOn` + `secondsRemaining` pre-flight rejection belong in the client or in the
   write queue (#10)?** Designed into the client above, with the reasoning given. If the tech
   lead prefers the client to be pure transport, this moves to #10 and the corresponding spec
   requirement moves with it.
2. **Should `PodClient` expose `POST /api/settings` at all in this change?** It is implemented
   and mock-tested, but it is an *expensive write* with no caller until #18 (away mode). The
   alternative is to omit it and let #18 add it. Keeping it costs one method and buys the
   expensive-write path a test before anything depends on it.
3. **`coverVersion` in the synthetic fixture: `"Pod 5"` (upstream's mock) or `"Pod 3"`
   (`docs/POD-API.md`'s worked example)?** Nothing branches on it today, so the choice is only
   about which wrong guess is less misleading before the real capture lands.

### Resolutions (tech lead, 2026-09-06)

1. **Client keeps the pre-flight rejection.** It is a wire-protocol invariant, so it belongs
   where the wire is spoken; every caller gets the protection for free. Interaction with #10
   noted for change `poller-and-write-queue`: the WriteQueue must drop `isOn` when both fields
   are present *before* dispatch (per issue #10), and the client throwing on such a patch turns
   any queue coalescing bug into a loud failure instead of a silently wrong write.
2. **Keep `POST /api/settings`.** One method now buys the expensive-write path mock coverage
   before #13/#18 depend on it.
3. **`"Pod 5"` stands.** ADR-0001 already names the mismatch risk and #3 remains the tripwire.
