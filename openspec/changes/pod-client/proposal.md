## Why

Nothing in this repo can talk to a Pod yet. Every later milestone — the poller (#8), the
thermostat services (#9), the write queue (#10), the keep-alive (#12), the away-mode guard
(#13) — is a consumer of one typed HTTP client and one test double that behaves like the
real Pod. Both have to exist, and be *honest about the Pod's surprising semantics*, before
any of that can be written or tested.

"Honest" is the whole point. free-sleep's `updateSide` guards with `if (secondsRemaining)`
rather than `!== undefined`, so `secondsRemaining: 0` is a silent no-op; `isOn: true` is a
12-hour countdown, not a boolean; a write to one side hits *both* sides when either is in
away mode; and every request body is validated by a `.strict()` zod schema that returns 400
on an unknown key. A mock that implements the idealised API would let us ship a plugin that
fails only on real hardware.

Resolves #2, #4, #5, and the synthetic-fixtures half of #3 (milestone M1 — Foundations).

## What Changes

- **`src/pod/types.ts`** — the free-sleep wire contract, *vendored* (copied, not depended
  upon) from the upstream zod schemas at commit `dc0c710` / v2.1.5. Runtime zod schemas plus
  `z.infer` types for device status, settings, schedules, and services. `waterLevel` is
  modelled as the string it actually is, with an explicit three-state interpretation
  (`ok` / `low` / `unknown`) rather than a coerced boolean.
- **Read schemas are lenient, request schemas are strict.** The vendored read schemas drop
  upstream's `.strict()` and its `targetTemperatureF` range bound, because the Pod's `GET`
  routes never validate their own responses — a future free-sleep field or an out-of-range
  reading must not blow up a poll. The request schemas keep both, because that is what the
  Pod actually enforces on us.
- **`test/fixtures/`** — the four capture targets named in #3 (`deviceStatus.json`,
  `settings.json`, `schedules.json`, `services.json`) plus edge-case device-status variants,
  generated synthetically from free-sleep's own mock seed data per ADR-0001, with a
  `README.md` recording per-file provenance and synthetic-vs-captured status. An automated
  test parses every fixture through the vendored schemas, and asserts `taps` is **absent**
  from the device-status fixture — the tripwire for #21.
- **`test/mockPod.ts`** — a stateful in-process mock Pod on `node:http`, seeded from those
  fixtures. It is the executable spec for the client and reimplements the five semantics
  above rather than an idealised API. It records every HTTP request *and* every derived
  hardware command in order, so tests can assert on exact traffic and on command ordering.
  It can inject faults (5xx, hang, connection reset) so the client's timeout and retry
  policy are testable.
- **`src/pod/client.ts`** — `PodClient`: an ~8 s `AbortSignal.timeout` per attempt, a
  concurrency limit of 1 per endpoint with in-flight deduplication of identical GETs, one
  retry with backoff on network errors and 5xx, **never** a retry on 400, and a typed error
  taxonomy so callers can tell "Pod is rebooting" from "our payload is wrong". No
  authentication is sent, ever.
- **`scripts/smoke.ts`** — a read-only smoke script (`npm run smoke -- <host>`) that reads
  live status from a real Pod and reports reachability, `coverVersion`, the raw `waterLevel`
  string, whether `taps` is present, and per-request latency. Committed now; its live run is
  the pending hardware step recorded in ADR-0001.

**Done when:** `npm test` is green with the client's tests running entirely against the mock
Pod, and the smoke script exists and typechecks. The live smoke read stays open as a
hardware-verification step, not a blocker (ADR-0001).

## Non-goals

- **No HomeKit.** No platform, no accessories, no HAP registration, no `updateCharacteristic`.
  That is M2 (#7–#11).
- **No polling and no caching.** `PodClient` performs exactly the request it is asked for.
  The shared poller and cached snapshot are #8.
- **No write queue, debounce, coalescing, or optimistic overlay** (#10). The client
  serialises per endpoint; it does not batch, merge, or reorder caller intent.
- **No away-mode write guard** (#13). The client will not silently drop or rewrite a write
  because a side is in away mode — that policy needs settings state the client does not
  hold. The *mock* reproduces the coupling so #13 can be tested against it.
- **No keep-alive** (#12).
- **No temperature conversion helpers or HAP characteristic props** (#6) beyond the raw
  integer °F the wire uses.
- **No real fixture capture.** #3 stays open; the synthetic fixtures are placeholders whose
  filenames match the capture commands so a real capture is a straight overwrite.
- **No client-side schema validation of GET responses as a hard failure.** Parsing is
  lenient by design; see the Decisions section of design.md.
- **No endpoints beyond those listed below.** Specifically no `/api/jobs`, no `/api/execute`,
  no `/api/logs` SSE, no `/api/alarm`, and no biometrics (`/api/metrics/*`) — those arrive
  with the features that need them (#16, #19).
- **No vendoring of upstream's MSW handlers or its mock mutators.** Only its seed *data* is
  vendored, as fixtures; see design.md for why.

## free-sleep API endpoints touched

| Endpoint | Used by | Cost |
|---|---|---|
| `GET /api/deviceStatus` | client, smoke script | **Expensive** — live hardware round-trip over the Unix socket, serialised behind a 10 s response timeout (`server/src/8sleep/frankenServer.ts`). The client's 1-per-endpoint limit and GET dedupe exist for exactly this. |
| `POST /api/deviceStatus` | client (method only; no caller in this change) | Cheap. Sends `SET_SETTINGS` / temp / duration device commands. **Does not** touch LowDB and so **does not** trigger a job rebuild (`server/src/routes/deviceStatus/updateDeviceStatus.ts`). |
| `GET /api/settings` | client, smoke script | Cheap LowDB JSON read. |
| `POST /api/settings` | client (method only; no caller in this change) | **EXPENSIVE WRITE.** Writes `settingsDB.json`, which `server/src/jobs/jobScheduler.ts` chokidar-watches — every write cancels and rebuilds every scheduled job on the Pod. The method is implemented and unit-tested against the mock; **nothing in this change calls it against real hardware**, and the smoke script performs zero writes of any kind. |
| `GET /api/schedules` | client, smoke script | Cheap LowDB JSON read. |
| `GET /api/services` | client, smoke script | Cheap LowDB JSON read (`biometrics.enabled`). |

`POST /api/schedules` — the other expensive write — is deliberately **not** implemented in
this change; nothing needs it yet.

No endpoint in this change requires authentication, and none is added.

## Capabilities

### New Capabilities

- `pod-client`: typed, resilient access to a free-sleep Pod's LAN HTTP API — the vendored
  wire contract, the request/response behaviour of the client (timeout, concurrency,
  deduplication, retry policy, error taxonomy, no auth), and the read-only smoke script used
  to verify a real Pod.
- `pod-test-double`: the fixtures and the stateful mock Pod that stand in for real hardware —
  their provenance rules, the Pod semantics the mock must reproduce, and the recording and
  fault-injection surface later changes (#10, #12, #13) build their tests on. Split out from
  `pod-client` because it is a contract *consumed by other changes*, not an implementation
  detail of the client.

### Modified Capabilities

None. `build-tooling` (from the `tooling-and-ci` change) gains files but no new requirement;
see Impact for the coordination note.

## Impact

- **Files added**: `src/pod/types.ts`, `src/pod/client.ts`, `src/pod/errors.ts`,
  `test/fixtures/README.md`, `test/fixtures/*.json`, `test/mockPod.ts`,
  `test/fixtures.test.ts`, `test/mockPod.test.ts`, `test/client.test.ts`,
  `scripts/smoke.ts`.
- **Files modified**: `package.json` (promote `zod` from devDependency to dependency; add a
  `smoke` script), `tsconfig.json` (add `scripts/**/*.ts` to the typecheck `include`).
- **Coordination**: those two files are also edited by the in-flight `tooling-and-ci` change
  (#1), which is being implemented in a separate worktree. `tooling-and-ci` must land first;
  this change edits its output. No requirement of `build-tooling` changes.
- **Dependencies**: `zod` becomes a runtime dependency. No devDependency is *added* by this
  change, but it is the first change to rely on `@types/node` (added by `tooling-and-ci`) for
  typechecking: `test/mockPod.ts`'s `node:http` server, `node:net`'s `AddressInfo`, and
  `scripts/smoke.ts` (now in the typecheck `include`, see below) all need its ambient types.
- **Systems**: no Pod is contacted by the test suite; the whole suite runs offline. The only
  code path that touches real hardware is the smoke script, which is read-only and manual.
