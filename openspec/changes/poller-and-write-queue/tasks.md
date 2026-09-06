Prerequisite: the `pod-client` change (#4, #5) must be merged first — `PodClient`, the error
taxonomy, and the stateful mock Pod with request recording and fault injection are all hard
dependencies. `platform-foundation` (#7) may land before or after; nothing here imports it.

Every verification below runs offline with no Pod, under vitest. No task in this change requires
real hardware; the real-Pod load check is #15 and the Home-app confirmations belong to #9/#11.

All timing tests use vitest fake timers plus the injected `TimerApi`, with `random: () => 0.5`
so jitter is exactly zero. See design.md, "Timer, clock and randomness injection".

## 1. Shared timing plumbing

- [ ] 1.1 Define the `TimerApi` interface (`setTimeout`, `clearTimeout`, `now`, `random`) and a
  default implementation over `globalThis` / `Date.now` / `Math.random`, exported from
  `src/pod/snapshot.ts` (the leaf module of the three); verify with a unit test that the default
  implementation's `now()` tracks `Date.now()` and that `random()` stays within `[0, 1)` over
  1 000 draws.
- [ ] 1.2 Build a test-only `TimerApi` harness backed by vitest fake timers with a settable
  `random`, in `test/timerHarness.ts`; verify with a self-test that advancing the harness by
  `n` ms fires exactly the callbacks scheduled at or before `n`, in scheduled order, and that
  `now()` advances in lockstep.
- [ ] 1.3 Add an ESLint `no-restricted-globals` entry forbidding `setTimeout`, `setInterval`,
  `clearTimeout`, `Date` and `Math.random` inside `src/pod/{snapshot,poller,writeQueue}.ts`;
  verify `npm run lint` fails when a direct `Date.now()` is temporarily added to `poller.ts` and
  passes once removed.

## 2. Snapshot store: state, immutability, synchronous reads

- [ ] 2.1 Create `src/pod/snapshot.ts` with the layered `raw` / `overlay` / `effective` model and
  a single private `commit()` that recomputes, deep-freezes and swaps the effective value; verify
  with a unit test that `get()` returns a frozen object, that a mutation attempt on it does not
  change what a later `get()` returns, and that two consecutive `get()` calls with no commit in
  between return the identical reference.
- [ ] 2.2 Model per-class state as unknown-until-first-success, and prove a later failure does not
  revert it; verify with a unit test that every class reads as unknown before any commit, that
  after one successful commit the class reads real values, and that recording a failure leaves the
  last successful value in place.
- [ ] 2.3 Derive and expose `connection` (`online`, `consecutiveFailures`, `lastSuccessAt`,
  `lastErrorKind`) from device-status outcomes only; verify with a unit test driving
  success/failure/success that the counter rises and resets, and that a `PodNetworkError` and a
  `PodResponseError` produce distinguishable `lastErrorKind` values.
- [ ] 2.4 Prove reads are synchronous and I/O-free: verify with a unit test that `get()` returns a
  non-thenable value, and that 80 consecutive `get()` calls made while a mock-Pod request is
  in flight add zero entries to the mock's request recording.

## 3. Snapshot store: change notifications

- [ ] 3.1 Define the watched-field enumeration and the discriminated-union change type (per side:
  `currentTemperatureF`, `targetTemperatureF`, `isOn`, `isAlarmVibrating`, `awayMode`;
  device-wide: `waterLevelState`, `isPriming`, `connection.online`); verify with a typecheck-level
  test that switching exhaustively on `change.field` narrows `previous`/`current` to the right
  types, and that assigning an unlisted field name fails `npm run typecheck`.
- [ ] 3.2 Implement batched per-commit notification computed on the effective view; verify with a
  unit test that a commit changing two fields delivers one notification listing both, that an
  identical commit delivers none, and that reading the snapshot from inside a listener returns the
  post-commit value.
- [ ] 3.3 Implement subscribe/unsubscribe; verify with a unit test that an unsubscribed listener
  receives nothing from a subsequent commit, and that subscribing or unsubscribing from inside a
  notification does not change who receives the notification in progress.
- [ ] 3.4 Exclude the continuously-varying counter: verify with a unit test that two commits
  differing only in `secondsRemaining` deliver no notification while `get().deviceStatus` reports
  the new value, and that two commits differing only in schedules content likewise deliver none.
- [ ] 3.5 Implement listener isolation and re-entrancy queueing; verify with a unit test that when
  the first of three listeners throws, the other two are still called and the error is logged, and
  with a second test that a listener which installs an overlay entry produces a separate later
  notification rather than a nested or interleaved one.

## 4. Snapshot store: optimistic overlay

- [ ] 4.1 Implement overlay install/refresh/clear as commits, restricted to the overlayable fields
  (`targetTemperatureF`, `isOn`, `isAlarmVibrating`, `awayMode`); verify with a unit test that
  installing an entry changes `get()` immediately and emits a notification with no Pod request
  made, that installing a second entry for the same field replaces value and expiry, and that
  attempting to overlay `secondsRemaining` is rejected.
- [ ] 4.2 Implement suppression: an observation disagreeing with an active entry must not change
  the effective value and must emit nothing; verify with a unit test that pins 70 °F, commits an
  observation of 64 °F, and asserts `get()` still reads 70 with zero notifications delivered.
- [ ] 4.3 Implement retirement by agreement, including deriving power agreement from
  `secondsRemaining > 0` rather than an exact duration; verify with two unit tests — an exact
  `targetTemperatureF` match clears the entry silently, and an `isOn: true` entry is cleared by an
  observation reporting any positive `secondsRemaining` — and that after retirement a subsequent
  disagreeing observation is no longer suppressed.
- [ ] 4.4 Implement expiry on an injected timer, dropping the entry and emitting the reversion when
  the observation still disagrees; verify with a fake-timer unit test that advancing past
  `writeSettleMs` with no agreeing observation emits one change from the overlaid value to the
  observed value, and with a second test that this still happens when no observation has arrived
  at all (Pod unreachable).
- [ ] 4.5 Verify an agreed entry never reverts: a fake-timer test where agreement arrives before
  expiry, then time is advanced well past the original expiry, and no reversion notification is
  ever delivered.

## 5. Poller: classes, cadence, jitter

- [ ] 5.1 Create `src/pod/poller.ts` with the endpoint-class descriptor registry and the four
  shipped descriptors (`deviceStatus` 30 s; `settings`, `schedules`, `services` 300 s), each with
  `read`, `apply` and `enabled`; verify with a unit test against the mock Pod that one period
  produces exactly one request per class and that the snapshot is updated from each.
- [ ] 5.2 Implement the interval bounds — configured minimums of 5 000 ms (`pollIntervalMs`) and
  60 000 ms (`slowPollIntervalMs`), plus the 3 000 ms hard floor independent of config; verify with
  unit tests that a configured 1 000 ms is clamped to 5 000 ms with a warning naming both values,
  and that no path can produce a scheduled delay below 3 000 ms.
- [ ] 5.3 Implement ±10 % jitter drawn from the injected `random`; verify with a unit test that
  `random: () => 0.5` yields exactly the effective interval, that `random: () => 0` and
  `random: () => 0.999…` yield the −10 % and +10 % bounds, and that a real random source over 50
  scheduled delays produces at least two distinct values, all within bounds.
- [ ] 5.4 Implement self-rescheduling from poll settle, and prove in-flight suppression; verify
  with a fake-timer test using the mock's hang fault that a poll spanning three intervals results
  in exactly one in-flight request throughout, the next request one interval after it settles, and
  no burst on recovery.

## 6. Poller: modes, backoff, bootstrap, lifecycle

- [ ] 6.1 Implement `requestMode(classId, { intervalMs, untilMs, reason })` returning a release
  function, with the effective interval as the minimum over active modes and the base; verify with
  fake-timer tests that a 3 s mode wins over a concurrent 5 s mode, that releasing the 3 s mode
  falls back to 5 s and then to the base on expiry, and that a mode arriving late in a pending base
  delay reschedules from the last poll rather than waiting the delay out.
- [ ] 6.2 Wire the priming mode: hold a fast mode while an observation reports `isPriming`, release
  it on the first observation that does not; verify with a fake-timer test seeding the mock with
  `isPriming: true` that polling runs at `fastPollIntervalMs` for as long as priming persists
  across more than `fastPollDurationMs`, then returns to base after priming clears.
- [ ] 6.3 Implement backoff as `clamp(effective × 2^failures, effective, max(maxBackoffMs,
  effective))` with jitter applied last and immediate snap-back on success; verify with fake-timer
  tests that a failing 5 s class produces ~10/20/40/60/60 s gaps, that a failing 300 s class stays
  at ~300 s rather than dropping to 60 s, and that one success returns the next gap to the
  effective interval.
- [ ] 6.4 Implement `bootstrap()` — all enabled classes in parallel, resolves on completion or at
  `bootstrapTimeoutMs`, never rejects, always starts the recurring schedules, and counts failures
  towards backoff; verify with three tests: reachable mock populates every class; all-failing mock
  resolves with every class unknown, failures logged and schedules running; and a hanging mock
  resolves at the deadline with the late response still committing when it lands.
- [ ] 6.5 Implement `refresh(classId)`, attaching to an in-flight poll rather than issuing a second
  request and resetting the class's next delay; verify with unit tests that a refresh mid-period
  issues one request and updates the snapshot, and that a refresh during an in-flight poll adds no
  entry to the mock's recording while still settling with that poll's outcome.
- [ ] 6.6 Implement `stop()`; verify with a test that after stopping no timer remains scheduled
  (assert on the fake-timer harness's pending-timer count), that a request outstanding at stop time
  commits nothing when it later resolves, and that the suite reports no open-handle warning.
- [ ] 6.7 Prove nothing escapes the injected clock: verify with a test supplying a `TimerApi` whose
  `now()` never advances and whose `setTimeout` never fires, that no poll, backoff, mode expiry or
  overlay expiry occurs over an arbitrarily long real-time wait.

## 7. Write queue: debounce, coalescing, dispatch

- [ ] 7.1 Create `src/pod/writeQueue.ts` with the four lanes (`left`, `right`, `device`,
  `settings`), each carrying its own debounce values, and per-submission promises; verify with a
  unit test that a submission's promise settles when the dispatch carrying it settles, and that two
  submissions merged into one dispatch settle together with the same outcome.
- [ ] 7.2 Implement trailing-edge debounce with field-level merging; verify with the **#10
  acceptance test**: a `TargetHeatingCoolingState`-shaped power write and a `TargetTemperature`-
  shaped write for the same side submitted 10 ms apart produce **exactly one**
  `POST /api/deviceStatus` in the mock's recording, whose body carries both fields for that side
  and nothing else.
- [ ] 7.3 Prove last-write-wins per field and lane independence; verify with unit tests that three
  target temperatures inside one window dispatch only the last, and that simultaneous left and
  right submissions produce one dispatch each with neither delaying the other.
- [ ] 7.4 Implement `writeMaxDebounceMs`; verify with a fake-timer test that a submission every
  100 ms for 10 s produces dispatches at roughly the maximum-wait interval rather than a single
  dispatch at the end, and that each carries the most recent value at its dispatch time.

## 8. Write queue: the duration-field reduction

- [ ] 8.1 Implement the reduction — keep `secondsRemaining` when non-zero, keep `isOn` otherwise —
  logging both the submitted and dispatched patch at debug; verify with a unit test over all four
  combinations that the dispatched body carries exactly one of the two fields, with the field
  chosen per design.md's table.
- [ ] 8.2 Prove equivalence against the mock as oracle: for each of the four combinations, verify
  that the mock's resulting device state after the queue's reduced dispatch equals its state after
  applying the unreduced patch directly to a separately-seeded mock — in particular that
  `{isOn: false, secondsRemaining: 0}` ends with the side **off**, which "always drop `isOn`" would
  get wrong.
- [ ] 8.3 Prove the client's pre-flight rejection is never tripped: verify with a test that drives
  the queue with every ordering and interleaving that can put both fields in one window — including
  a simulated keep-alive `secondsRemaining` re-post landing inside a user's power-off window — and
  asserts no `PodRequestError` is ever raised and no recorded request body contains both fields.
- [ ] 8.4 Prove single-field patches are untouched: verify with a unit test that a patch carrying
  only `isOn`, and one carrying only `secondsRemaining`, are dispatched byte-identically to what was
  submitted.

## 9. Write queue: mutex, overlay lifecycle, fast poll

- [ ] 9.1 Implement the global FIFO mutex across all lanes and both write endpoints; verify with a
  test using the mock's delay fault that a status write and a settings write due at the same moment
  are recorded strictly sequentially with no overlap, and that a failing dispatch releases the mutex
  so a waiting lane dispatches next.
- [ ] 9.2 Implement `runExclusive(fn)`; verify with a test that a write becoming due during an
  exclusive section is recorded only after the section completes, and that a throwing section still
  releases the mutex.
- [ ] 9.3 Install overlay entries at submission for the overlayable fields; verify with a unit test
  that `snapshot.get()` returns the new target temperature immediately after submission, before the
  mock has recorded any request.
- [ ] 9.4 Re-base overlay expiry to dispatch-settle time and clear entries on dispatch failure;
  verify with fake-timer tests that a write held several seconds in the mutex still gets a full
  `writeSettleMs` window measured from settle, and that a 500-faulted dispatch removes its entries
  immediately (reverting `get()` and emitting the reversion) rather than at expiry.
- [ ] 9.5 Request the fast poll on success only, via the injected `requestFastPoll` callback; verify
  with a fake-timer integration test that after a successful write the confirming device-status poll
  arrives inside `writeSettleMs` and retires the overlay by agreement with **no** reversion
  notification, and with a second test that a failed dispatch makes no fast-poll request.
- [ ] 9.6 Verify the queue holds no policy: a test seeding `settings.left.awayMode = true` asserts a
  write addressed to the right side is dispatched unmodified (and that the mock's both-sides mirror
  fires), and a test asserts an idle queue issues zero requests over an hour of fake time.
- [ ] 9.7 Implement `stop()`; verify with a test that submissions still inside their debounce window
  settle with a shutdown failure, that the mock recorded nothing, that owned overlay entries are
  removed, and that no timer remains scheduled.

## 10. Guardrail: the five-minute Home-app session

- [ ] 10.1 Write `test/pollBudget.test.ts` reproducing design.md's scenario table — bootstrap at
  t=0; 80 `snapshot.get()` calls at t=0 and again at t=60 s; six `left`-lane submissions between
  t=120.0 s and t=120.3 s; run to t=300 s under fake timers with `random: () => 0.5`; verify it
  asserts **≤ 40 total recorded requests, exactly 1 write, and ≥ 10 device-status reads**.
- [ ] 10.2 Add the sharp form of the invariant to the same test: verify the mock's recorded request
  count is **unchanged** across each 80-read burst (delta exactly zero).
- [ ] 10.3 Prove the guardrail actually guards: verify by temporarily making the snapshot read path
  trigger a device-status request that the budget assertion fails, then reverting — and record the
  observed failing count in a comment next to the assertion so a future reader knows the margin.
- [ ] 10.4 Document the derivation next to the assertion, pointing at design.md's table, so that a
  later change to the fast-poll shape updates the number deliberately rather than by loosening the
  bound; verify by reading the test back and confirming the expected count (32) and each of the
  three assertions are explained.

## 11. Integration and gates

- [ ] 11.1 Wire an end-to-end fake-timer test that runs poller, snapshot and write queue together
  against one mock Pod: a write, its overlay, the fast poll, agreement retirement, then a
  fault-injected outage with backoff, then recovery; verify the emitted change-notification sequence
  matches the expected list exactly, with no spurious event during the settle window and exactly one
  `connection.online` transition in each direction.
- [ ] 11.2 Verify module boundaries hold: `grep` shows no import of `homebridge`, `hap-nodejs`, or
  anything under `test/` from `src/pod/{snapshot,poller,writeQueue}.ts`, and no import of
  `poller.js` from `writeQueue.ts`; confirm `npm run build` emits the three modules into `dist/`
  with no test file present.
- [ ] 11.3 Verify the four CI gates: `npm run lint`, `npm run typecheck`, `npm test` and
  `npm run build` all exit 0, and the whole suite runs with no network access and no Pod on the LAN.
