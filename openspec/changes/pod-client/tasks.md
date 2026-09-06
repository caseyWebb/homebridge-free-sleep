Prerequisite: the `tooling-and-ci` change (#1) must be merged first — this change edits
`package.json` and `tsconfig.json` as that change leaves them (design.md, "Coordination with
`tooling-and-ci`").

Every verification below runs offline with no Pod. The three tasks that require real hardware
are grouped in section 8 and are explicitly **not** blockers for this change (ADR-0001).

## 1. Dependencies and configuration

- [ ] 1.1 Move `zod` from `devDependencies` to `dependencies` in `package.json`; verify
  `node -p "const p=require('./package.json'); !!p.dependencies.zod && !p.devDependencies?.zod"`
  prints `true` and `npm ci && npm test` still passes.
- [ ] 1.2 Add `"smoke": "node --experimental-strip-types scripts/smoke.ts"` to `scripts`;
  verify `npm run smoke` with no host argument exits non-zero and prints a usage line (the
  script itself lands in 7.1 — until then this task's verification is deferred to 7.2).
- [ ] 1.3 Add `"scripts/**/*.ts"` to `tsconfig.json`'s `include`, leaving
  `tsconfig.build.json` at `src/`-only; verify `npx tsc -p tsconfig.json --noEmit --listFiles`
  lists files under `scripts/` once one exists, and `npm run build` produces no `dist/scripts/`
  directory.

## 2. Vendored wire types (`src/pod/types.ts`)

- [ ] 2.1 Create `src/pod/types.ts` with a file header naming free-sleep v2.1.5, commit
  `dc0c710`, and the four upstream source paths it vendors from; verify by reading it back
  against design.md's vendoring table and by confirming `grep -c "free-sleep" src/pod/types.ts`
  is non-zero.
- [ ] 2.2 Vendor the **read** schemas — device status, settings, schedules, services — as
  `.passthrough()` with no `targetTemperatureF` range bound, keeping `taps` optional; verify
  with unit tests that a response object carrying an extra unknown property parses and retains
  its known fields, and that a `targetTemperatureF` of 200 parses.
- [ ] 2.3 Vendor the **request** schemas (`DeviceStatusPatchSchema`, `SettingsPatchSchema`) as
  strict deep-partials with `targetTemperatureF` an integer in 55–110; verify with unit tests
  that an unknown key fails to parse, that 54 and 111 fail, that 55 and 110 pass, and that a
  non-integer fails.
- [ ] 2.4 Export `z.infer` types for every schema and confirm they compile under the project's
  strict settings; verify `npm run typecheck` exits 0 and a deliberate wrong-typed assignment
  in a scratch test file fails typecheck (then remove it).
- [ ] 2.5 Add `interpretWaterLevel(raw: string): 'ok' | 'low' | 'unknown'`; verify with a unit
  test covering `"true"` → `ok`, `"false"` → `low`, and `""`, `"unknown"`, `"TRUE"`, `"1"` →
  `unknown` — asserting explicitly that none of the unknown cases returns `low`.
- [ ] 2.6 Confirm no dependency on free-sleep was introduced: verify
  `node -p "JSON.stringify(require('./package.json'))" | grep -ci "free-sleep"` counts only
  the package's own name/description/URL fields, and that `npm run build` succeeds with
  `~/Code/free-sleep` renamed out of the way.

## 3. Fixtures (`test/fixtures/`)

- [ ] 3.1 Generate the four canonical fixtures — `deviceStatus.json`, `settings.json`,
  `schedules.json`, `services.json` — from free-sleep's `app/src/mocks/mockData.ts` seed
  factories, applying the two departures in design.md (`isPriming: false`,
  `freeSleep.version: "2.1.5"`); verify each file is valid JSON (`jq . <file>`) and that the
  filenames match #3's capture commands character for character.
- [ ] 3.2 Add the three synthetic device-status variants — `deviceStatus.bothOff.json`
  (both sides `secondsRemaining: 0`, `isOn: false`), `deviceStatus.waterLow.json`
  (`waterLevel: "false"`), `deviceStatus.waterUnknown.json` (`waterLevel: "unknown"`); verify
  each parses as JSON and differs from the canonical fixture in exactly the intended fields
  (`diff <(jq -S . a) <(jq -S . b)`).
- [ ] 3.3 Confirm every fixture is scrubbed: verify a grep over `test/fixtures/*.json` for IP
  addresses, MAC addresses, and any real personal or household name returns nothing, and that
  `settings.json`'s `id` is a placeholder rather than a real UUID.
- [ ] 3.4 Write `test/fixtures/README.md` with a per-file table (captured vs synthetic,
  upstream version + commit + source file, date, what it exercises), the exact `curl … | jq >`
  capture commands from #3, the scrubbing checklist, and the list of tests to re-run after a
  swap; verify by reading it back file-by-file against `ls test/fixtures/` — every file present
  must have a row, and every row a file.
- [ ] 3.5 Add `test/fixtures.test.ts` parsing every fixture through its read schema,
  table-driven; verify the suite passes, then temporarily delete a required field from one
  fixture and confirm the failure message names both the fixture and the property, then restore
  it.
- [ ] 3.6 Add the `taps`-absence assertion to `test/fixtures.test.ts` with a failure message
  stating the #21 assumption is invalidated; verify by temporarily adding a `taps` object to
  `deviceStatus.json`, confirming the suite fails with that message, then removing it.

## 4. Mock Pod transport (`test/mockPod.ts`)

- [ ] 4.1 Implement `startMockPod()` on `node:http` listening on port 0, returning `url`,
  `state`, `requests`, `commands`, `fault()`, `reset()`, `close()`; verify a test can start it,
  `fetch(`${pod.url}/api/deviceStatus`)` returns 200 with the fixture body, and `close()`
  resolves.
- [ ] 4.2 Seed state from the fixtures, with an optional state override and a `reset()`;
  verify with tests that a fresh mock's four GET responses deep-equal their fixtures, that an
  override (e.g. `settings.left.awayMode = true`) is reflected in a read, and that `reset()`
  after a write restores the seed and empties `requests` and `commands`.
- [ ] 4.3 Prove isolation and clean shutdown: verify a test starting three mocks concurrently
  gets three distinct ports with independent state, and that `vitest run` reports no open-handle
  warning after `close()` (run with `--reporter=verbose` and confirm the process exits without
  a hanging-process message).
- [ ] 4.4 Implement request recording (method, path, headers, parsed body, response status,
  timestamp) including rejected requests; verify with a test that drives one valid and one
  invalid write and asserts `pod.requests` has both entries with statuses 204 and 400, and that
  headers are readable from the record.
- [ ] 4.5 Implement `fault(endpoint, {kind, status?, times})` for `status`, `hang`, and
  `reset`; verify with three tests — a scripted 500 followed by a normal 200, a `hang` that a
  1 s `AbortSignal.timeout` aborts, and a `reset` that surfaces as a `fetch` TypeError — each
  confirming normal service resumes after `times` is exhausted.

## 5. Mock Pod semantics — the five behaviours

- [ ] 5.1 Validate every POST body against the strict request schemas and return
  `400 {error, details}` on failure, `204` for `/api/deviceStatus` and `200` with the merged
  document (`id` stripped) for `/api/settings`; verify with tests asserting: an unknown key
  gives 400 with the key named and no state change, an out-of-range temperature gives 400, a
  valid device-status write gives 204 with an empty body, and a valid settings write gives 200
  with `id` absent from the response.
- [ ] 5.2 Implement the truthiness guards verbatim from `updateDeviceStatus.ts` so
  `secondsRemaining: 0` is a silent no-op; verify with tests that a side on with 600 s
  remaining is unchanged (still on, still 600) after a `secondsRemaining: 0` write that returns
  success, that `isOn: false` does take it to 0/off, and that `secondsRemaining: 900` sets 900.
- [ ] 5.3 Implement the 12-hour expansion and derived power state — `isOn: true` sets 43200,
  reads compute `isOn` as `secondsRemaining > 0` with no stored flag; verify with tests that a
  power-on write is followed by a read of `secondsRemaining: 43200` and `isOn: true`, and that
  setting `secondsRemaining` directly to 1 and then to 0 flips the reported `isOn` accordingly.
- [ ] 5.4 Implement away-mode both-sides mirroring using upstream's `controlBothSides`
  expression; verify with tests that with `right.awayMode: true` a write to `left`'s
  `targetTemperatureF` changes both sides, and that with neither side away the same write
  changes only `left`.
- [ ] 5.5 Implement the fixed command expansion and the `pod.commands` log — per side
  `isOn` → `targetTemperatureF` → `secondsRemaining` → `isAlarmVibrating`, top level
  `isPriming` → left → right → `settings`; verify with tests that a body written with its
  properties in reverse order still produces the canonical command sequence, that a body
  setting fields on both sides logs all left commands before all right, and that
  `{left: {isOn: true, secondsRemaining: 600}}` logs `LEFT_TEMP_DURATION 43200` then
  `LEFT_TEMP_DURATION 600` and leaves the side at 600.
- [ ] 5.6 Confirm the mock implements no plugin policy: verify by inspection and by a test that
  two identical writes both apply and both appear in `pod.requests`, and that a write to a side
  in away mode is applied (mirrored) rather than suppressed.

## 6. `PodClient` (`src/pod/client.ts`, `src/pod/errors.ts`)

- [ ] 6.1 Add `src/pod/errors.ts` with `PodError` and the seven subclasses from design.md's
  table, each carrying its documented fields; verify with a unit test that every subclass is
  `instanceof PodError`, that `PodBadRequestError` exposes `status` and `details`, and that
  each class's `name` is set (so it survives serialisation into a Homebridge log line).
- [ ] 6.2 Implement the client shell — constructor (`host`, `port` default 3000,
  `timeoutMs` default 8000), URL building, JSON encoding, and the read methods
  `getDeviceStatus`, `getSettings`, `getSchedules`, `getServices`; verify with tests against
  the mock that each returns data deep-equal to its fixture and that a malformed response body
  raises `PodResponseError` naming the property path.
- [ ] 6.3 Implement the write methods `postDeviceStatus` and `postSettings` with pre-flight
  strict validation; verify with tests that a valid patch reaches the mock and returns without
  error, that a patch with an unknown key raises `PodRequestError` with **zero** entries added
  to `pod.requests`, and that an out-of-range temperature is likewise rejected before any
  request.
- [ ] 6.4 Implement the ~8 s per-attempt timeout combined with the caller's signal via
  `AbortSignal.any`; verify with tests using the mock's `hang` fault that a request rejects with
  `PodTimeoutError` at approximately the configured timeout (use a short `timeoutMs` in the
  test), and that aborting a caller-supplied signal mid-flight rejects with `PodAbortError`
  promptly and issues no retry.
- [ ] 6.5 Implement per-endpoint serialisation keyed on `${method} ${pathname}`; verify with
  tests that two concurrent `postDeviceStatus` calls arrive at the mock strictly one after the
  other (assert non-overlap via the mock's per-request timestamps or a hang-then-release
  fault), and that a concurrent `getDeviceStatus` and `getSettings` overlap.
- [ ] 6.6 Implement in-flight GET deduplication returning a `structuredClone` per caller;
  verify with tests that three concurrent `getDeviceStatus()` calls produce exactly one entry
  in `pod.requests` and three equal results, that a fourth call issued after they resolve
  produces a second request (no caching), that two identical `postDeviceStatus` calls produce
  two requests, and that mutating one caller's result leaves the other's untouched.
- [ ] 6.7 Implement the retry policy — at most one retry, ~500 ms plus jitter, on network
  errors and 5xx only; verify with tests using the mock's faults that a single 500 then 200
  yields success with exactly 2 requests, that 500 twice rejects with `PodHttpError` after
  exactly 2 requests, that a connection `reset` then success yields 2 requests, and that the
  gap between the two request timestamps recorded by the mock is non-zero.
- [ ] 6.8 Ensure a 400 is never retried; verify with a test that a write the mock rejects with
  400 produces exactly **one** entry in `pod.requests` and rejects with `PodBadRequestError`
  carrying the mock's `details` payload.
- [ ] 6.9 Implement the pre-flight rejection of `isOn` + `secondsRemaining` for the same side
  (design.md, Open Question 1); verify with tests that such a patch raises `PodRequestError`
  naming the conflict with zero requests recorded, that the same fields on *different* sides in
  one patch are allowed, and that each field alone is sent normally.
- [ ] 6.10 Confirm no credentials are ever sent: verify with a test that iterates every client
  method against the mock and asserts each recorded request has no `authorization` header, no
  `cookie` header, and no userinfo in the URL — and by grepping `src/pod/` for
  `authorization|cookie|token|api[-_]?key` returning nothing.

## 7. Smoke script (`scripts/smoke.ts`)

- [ ] 7.1 Write `scripts/smoke.ts` taking a host argument, performing only the four reads
  through `PodClient`, and printing reachability, `coverVersion`/`hubVersion`/
  `freeSleep.version`, raw `waterLevel` plus `interpretWaterLevel`'s verdict, whether `taps`
  was present, `biometrics.enabled`, and per-request latency; verify by running
  `npm run smoke -- 127.0.0.1:<port>` against a locally-started mock Pod and confirming every
  listed item appears in the output.
- [ ] 7.2 Handle the failure and usage paths; verify `npm run smoke` with no argument exits
  non-zero with a usage line, and `npm run smoke -- 192.0.2.1` (TEST-NET-1, unroutable) exits
  non-zero naming the host and the error type rather than printing a bare stack trace.
- [ ] 7.3 Confirm the script is read-only; verify by pointing it at a mock Pod and asserting
  every entry in `pod.requests` has method `GET`, and by grepping `scripts/smoke.ts` for
  `post|POST` returning nothing.
- [ ] 7.4 Confirm it runs under type stripping without a transpiler; verify
  `node --experimental-strip-types scripts/smoke.ts` starts (usage path is sufficient) with no
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, and that `grep -nE "\benum\b|\bnamespace\b" src/pod/*.ts
  scripts/smoke.ts` returns nothing.

## 8. Acceptance and hardware verification

- [ ] 8.1 Full gate: verify `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`
  all exit 0, and that the suite passes on a machine with networking disabled — proving no test
  contacts a real Pod.
- [ ] 8.2 Confirm the module dependency direction holds; verify by grepping that
  `src/pod/types.ts` imports only `zod`, that nothing under `src/` imports from `test/`, that
  `test/mockPod.ts` does not import `src/pod/client.ts`, and that `dist/` after a build contains
  no `mockPod` or fixture files.
- [ ] 8.3 **Hardware, non-blocking (ADR-0001, #3):** run `npm run smoke -- <pod-ip>` against a
  real Pod; verify it exits 0 and record its full output on #3, in particular the actual
  `coverVersion`, the raw `waterLevel` string, and whether `taps` was present.
- [ ] 8.4 **Hardware, non-blocking (ADR-0001, #3):** capture the four real fixtures with the
  documented `curl … | jq >` commands, scrub them, overwrite the synthetic files, update
  `test/fixtures/README.md`'s table to say captured; verify `npm test` still passes — this is
  the check that closes #3 and re-validates #2's acceptance criterion against real data.
- [ ] 8.5 **Hardware, non-blocking (#4):** perform one manual read from the real Pod through
  `PodClient` (the smoke run in 8.3 satisfies this); verify by noting the observed round-trip
  latency on #4 against the 8 s timeout, flagging for #15 if it is anywhere near it.
