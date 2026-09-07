## Context

See proposal.md — Why. This section covers only what the approach needs beyond that.

Pre-existing state this design builds on (all shipped, all unmodified by this change except
where "Decisions" below says otherwise):

- **`WriteQueue`** (`src/pod/writeQueue.ts`): each lane (`left`, `right`, `device`,
  `settings`) has its own independent trailing-edge debounce timer (default 400ms), but every
  lane's dispatch is serialized through one global FIFO mutex (`pumpMutex`/`mutexQueue`,
  processed in the order each lane's debounce fires and enqueues a dispatch task).
  `submitSettings` already exists and already installs/clears the `awayMode` overlay on
  `left`/`right` **synchronously at submission** (`syncAwayModeOverlays`, called from inside
  `submit()`'s executor, before any `await`) — this is unconditional and predates this change;
  nothing in the shipped codebase has ever called it with an `awayMode`-touching patch before
  now.
- **`AwayModeGuard.decide()`** (`src/pod/awayModeGuard.ts`): a synchronous, no-`await` read of
  `snapshot.get()`, called from inside `WriteQueue.dispatch()` for side lanes only (`left`,
  `right`), at the moment that lane's mutex task actually runs — moved here by
  `away-mode-guard`'s tech-lead resolution 2, specifically to make it impossible for a caller
  to bypass by not going through a front-door wrapper.
- **`test/mockPod.ts`**: already reproduces `POST /api/settings`'s deep-merge and `id`-stripping
  semantics (verified this session against `server/src/routes/settings/settings.ts`,
  `~/Code/free-sleep`, v2.1.5 `dc0c710`: `delete body.id; await settingsDB.read(); _.merge
  (settingsDB.data, body); await settingsDB.write();` — `test/mockPod.ts`'s own `POST /api/
  settings` handler deletes `id` from the request body then does the equivalent recursive
  merge, matching this exactly) and `controlBothSides` mirroring. This change's tests, and the
  new ordering-hazard regression test below, run against it.
- **free-sleep job guards** (verified this session, same pin):
  `server/src/jobs/powerScheduler.ts:18,91`, `server/src/jobs/temperatureScheduler.ts:45`,
  `server/src/jobs/alarmScheduler.ts:127` (`scheduleAlarm`'s `if (settingsData[side].awayMode)
  return;`, guarding whether the recurring job is even registered) all read `awayMode`.
  `alarmScheduler.ts`'s scheduled job callback (inside `scheduleAlarm`, after the
  `node-schedule` rule fires) separately checks `settingsDB.data[side].scheduleOverrides.alarm
  .expiresAt`: `if (expiresAt) { if (moment(expiresAt).isAfter(moment())) { ...skip... } }` —
  confirmed this check is against `expiresAt` alone; `disabled` is read only by
  `scheduleAlarmOverride` (`alarmScheduler.ts:93`), a separate function `jobScheduler.ts`
  calls independently for the "move tonight's alarm" feature this change does not touch.
  `server/src/db/settings.ts` and `server/src/db/settingsSchema.ts` are the only
  non-test/non-mock hits for `temperatureSchedules` outside `app/src/mocks/mockData.ts` —
  confirming issue #18's "dead config" claim.
- **`app/src/pages/ControlTempPage/AlarmDisabledDialog.tsx`** (verified this session): the
  exact next-alarm rule this change mirrors —
  `const noonToday = now.clone().hour(12)...; const targetDay = now.isSameOrAfter(noonToday) ?
  now.clone().add(1, 'day') : now;` then `moment.tz({year, month, date, hour, minute, ...},
  settings.timeZone).add(2, 'minutes').format()`. `moment.tz(...).format()` on a
  zone-constructed moment yields a full ISO-8601 string with a UTC offset — exactly what issue
  #17 asks this change to also emit, and what its own comment on parse ambiguity (`moment()`
  vs `moment.tz()` reading `expiresAt` in different upstream call sites) requires.

## Goals / Non-Goals

**Goals:**

- Ship both switches using existing `WriteQueue`/`SnapshotStore`/`ServiceContext` machinery as
  fully as possible — the only shipped-code change this design proposes is the minimum needed
  to close the ordering hazard.
- Close the ordering hazard issue #18's comment identifies, for both the `'mirror'` and
  `'block'` away-mode-write policies, not just reduce its blast radius for one of them.
- Name, not build, the shared next-alarm-computation surface a concurrent (not-yet-created)
  change is expected to extend.
- Keep the common case (no pending away-mode-touching settings write, the overwhelming
  majority of every side dispatch) at effectively zero added cost.

**Non-Goals:**

- A general "settings write" service abstraction beyond what these two switches need.
- Adding `scheduleOverrides.alarm.expiresAt` as a new overlayable field on `SnapshotStore` (see
  "Decisions" below for why a local shadow is preferred instead).
- Reconciling the pre-existing mismatch between the main `pod-write-queue` spec and
  `away-mode-guard`'s own unsynced delta (noted in this change's `specs/pod-write-queue/
  spec.md`, "Context") — that is an archival housekeeping question for whoever archives
  `away-mode-guard`, not something this change's scope extends to.
- The "reactive re-check on settings-failure" mitigation (see "Decisions," rejected as primary).

## Decisions

### The ordering hazard: mechanism, and why the two candidate fixes differ in what they actually close

**The hazard, precisely** (issue #18's comment, reconstructed against the actual merged
source rather than assumed): `submitSettings`'s overlay install is synchronous *at
submission*; `AwayModeGuard.decide()` runs synchronously *at dispatch*, which happens
asynchronously later, gated by that lane's own debounce timer and its turn in the global FIFO
mutex. These two events — "the overlay exists" and "the side lane's dispatch calls decide()"
— are not currently ordered against each other in the hazardous direction:

1. A side write is submitted (`left` or `right` lane's debounce timer starts).
2. Shortly after — still within that lane's debounce window — the Away Mode switch submits an
   `awayMode: false` settings write. `syncAwayModeOverlays` installs the optimistic overlay
   **immediately**, before the settings lane's own debounce timer has even started counting
   down, let alone fired.
3. The side lane's debounce timer, started first, fires first, enqueuing its dispatch task
   into the mutex queue *before* the settings lane's task exists at all.
4. The side lane's dispatch runs its turn in the mutex and calls `decide()`, which reads the
   overlay installed in step 2 — even though the settings write that produced it hasn't been
   dispatched yet, let alone confirmed. `decide()` returns `'plain'` when the true, ground-
   truth state (`awayMode` still `true` on the Pod) calls for `'mirror'` or `'block'`.
5. The side write dispatches under the wrong decision. If the policy is `'mirror'`, the
   un-addressed side's cache silently goes stale (the Pod's own `controlBothSides`, reading
   its still-true `settingsDB.json`, mirrors the hardware effect anyway — only this plugin's
   cache is wrong, for up to `slowPollIntervalMs`, default 300s). If the policy is `'block'`,
   a write that should have been refused instead reaches the Pod — a real correctness gap, not
   merely a caching one.
6. Only afterward does the settings write's own dispatch run; if it fails, `settleWrite`'s
   `'clear'` path correctly reverts the overlay — but the side write already dispatched under
   the wrong decision in step 4/5.

The reverse submission order is safe for a structural reason, not a timing coincidence: if the
settings write is submitted *first*, its debounce timer starts first, so (all else equal) its
mutex task is enqueued and *runs* first too — its own settle (including the immediate
overlay-clear on failure, before its promise resolves) completes before the side lane's
later-enqueued dispatch ever calls `decide()`.

**Why a naive "await the settings write" fix deadlocks:** if the side-lane's dispatch task,
already popped and running under the mutex (`mutexBusy = true`), tried to `await` the settings
lane's own dispatch — and that settings dispatch is still sitting in `mutexQueue`, behind the
side task — the mutex can never advance to it (`pumpMutex` only shifts the next task once the
current one's `run()` promise resolves), so the side task waits on a task that can never run.
This is a real deadlock, not a latency hit.

**Chosen mechanism — drain-inline before deciding:** inside a side lane's `dispatch()`,
immediately before calling `awayModeGuard.decide()`, check whether the settings lane currently
holds a write — pending (still accumulating, debounce not yet fired) or already enqueued in
`mutexQueue` but not yet run — that touches `left.awayMode` or `right.awayMode`. If so, run
that settings write's flush-and-dispatch **inline**, synchronously from within the side lane's
already-held mutex slot (removing it from `mutexQueue` first, if it was already enqueued
there, so it is not dispatched a second time later) — not by awaiting a separately-queued
task. Only once that inline dispatch has fully settled (its own success/failure resolution,
including `settleWrite`'s overlay reconciliation) does the side lane proceed to call
`decide()`. Because the side lane still "holds" the mutex the entire time (nothing else can be
popped from `mutexQueue` while `mutexBusy` is true), this is equivalent in spirit to widening
the existing dispatch step's exclusive section by one settings write — not a new kind of
concurrency the mutex wasn't already designed to serialize — and it produces the *correct*
decision in every case, `'block'` included, because `decide()` never runs until the settings
write has genuinely settled one way or the other. The common case (no pending settings-lane
`awayMode` write — true for the overwhelming majority of every side dispatch, since Away Mode
is rare and deliberate) costs one cheap field check with no side effect.

**This requires touching `writeQueue.ts`** — shipped, heavily-documented code from the merged
`away-mode-guard` change (2026-09-06, PR #39). **This is flagged for tech-lead review**, for
the same reason `away-mode-guard`'s own design.md flagged its policy-value-discrepancy
decision: it overturns an assumption a previous, already-reviewed design relied on (that
`decide()`'s dispatch-time read was sufficient on its own — true until this change introduces
the first `submitSettings({awayMode})` caller) rather than merely filling in an unspecified
detail. See the final message.

**Alternative considered and rejected as primary: "re-check on settings-failure."** On a
failed settings dispatch touching `awayMode`, immediately force a fast, targeted
`deviceStatus` re-poll for both sides (reusing the existing `requestFastPoll`/`poller.refresh`
machinery) to shrink the `'mirror'` cache-staleness window from up to 300s down to one fast-
poll cycle (a few seconds). Rejected as the *primary* fix because it is purely reactive: it
does nothing for the `'block'`-policy case, where the harm (a write that should have been
refused reaching the Pod) is already done by the time any re-check could run — there is no
"un-send" for a request already in flight or already answered. It remains available as cheap,
optional defense-in-depth layered on top of the chosen mechanism (faster cache correction in
the vanishingly rare window where the drain-inline mechanism's own settings dispatch itself
times out rather than cleanly failing), but is not required by this design and is left to the
implementing task's judgment rather than mandated here.

**The literal "concrete probe description" issue #18's comment refers to could not be
recovered.** `gh pr view 39 --comments`, `gh api repos/.../pulls/39/comments`, and `gh api
repos/.../pulls/39/reviews` all returned empty for the merged PR #39. The closest artifact in
the repository, `test/writeQueue.test.ts`'s "reproducing the reviewer's probe" test (~line
690–708, guarding the F1 fix in commit `4301688`), covers a *different* hazard — a failed
*mirror* dispatch wrongly clearing its own overlay instead of rebasing it — not this one (a
`submitSettings` write racing a pending `submitSide` write across lanes). The regression test
this change adds (tasks.md) is therefore written from the first-principles scenario reproduced
above, not from a recovered historical artifact, and should say so in its own comment rather
than implying otherwise.

### The Skip Next Alarm switch keeps a local optimistic shadow instead of extending `SnapshotStore`

`scheduleOverrides.alarm.expiresAt` is not in `snapshot.ts`'s `OverlayableField`/
`SideOverlayField` union today (only `targetTemperatureF`, `isOn`, `isAlarmVibrating`, and
`awayMode` are). Two ways to give the switch optimistic feedback on toggle:

1. **Extend `SnapshotStore`** with a new overlayable field for the derived on/off boolean (or
   for `expiresAt` itself). Rejected: it touches shipped, already-audited `snapshot.ts` for a
   feature only one caller needs, and the derived value (a boolean computed from comparing a
   timestamp against "now") does not fit the existing overlay model cleanly — the existing
   overlayable fields are all raw Pod-reported values with a settle window, not
   continuously-recomputed derived booleans.
2. **A small local shadow inside the Skip Next Alarm service** (`src/services/skipAlarm.ts`),
   mirroring `ThermostatService`'s own `publishedF` shadow pattern (`docs/HOMEKIT.md`,
   "Anti-jitter"): on a successful toggle, remember the just-written `expiresAt` (or its
   derived on/off boolean) and a settle deadline; `onGet` prefers the shadow while it's live,
   falls back to the snapshot's raw `scheduleOverrides.alarm.expiresAt` once it expires or once
   an observed settings read confirms the value. This is chosen: it needs no change to shipped
   `snapshot.ts`, and the existing `publishedF` pattern is exactly this shape already proven
   out and tested elsewhere in the codebase.

### Debounce and rate-limiting live at the service level, above `WriteQueue`'s own lane debounce

Both issues ask for debounce >= 2s (much longer than `WriteQueue`'s own ~400ms default
per-lane debounce), and issue #18 additionally asks for a 10s-per-side rate limit. Both
switches implement their own local debounce/coalesce timer (using the shared `TimerApi` from
`ServiceContext`, for determinism under fake timers) *before* ever calling
`writeQueue.submitSettings` — `WriteQueue`'s own debounce still applies underneath, unmodified
and unrelated; it is not what satisfies the issue's anti-storm requirement, the service-level
timer is. The Away Mode switch additionally tracks, per side, the timestamp of its last
submitted settings write and refuses (queues/coalesces into) a new one inside the 10-second
window.

### "Re-read settings ~250ms after" is satisfied by existing machinery, not a new timer

`WriteQueue.settleWrite` already calls `requestFastPoll('settings', ...)` → `poller.refresh
('settings')` immediately upon a successful settings dispatch — shipped, zero-cost to reuse,
and already faster than "~250ms after." Both switches rely on this rather than adding a
second, bespoke delayed re-read; there is no evidence in `docs/POD-API.md` or the free-sleep
source that the Pod's own settings write handler has any asynchronous tail after its `res
.status(200)` response (`server/src/routes/settings/settings.ts`'s handler is a synchronous
`_.merge` + `await settingsDB.write()` before responding), so an additional artificial delay
would add latency without evidence it closes a real gap.

### Config flags default to enabled; `awayModeTurnsSideOff` defaults to disabled

`awayModeSwitch` and `skipAlarmSwitch` default to `true` — unlike the opt-in-default-off
Prime/Test-Alarm switches (`docs/HOMEKIT.md`'s service table), neither is "loud" or physically
disruptive; both are directly what issues #17/#18 were filed to add, and hiding them by
default would mean most users have to edit `config.json` to get the feature they asked for.
`awayModeTurnsSideOff` defaults to `false`, matching issue #18's own stated default — it
changes write *sequencing* in a way a household should opt into deliberately, not receive
silently.

### Error surfacing follows the existing convention exactly; the away-mode-guard's own error mapping does not apply here

`docs/HOMEKIT.md`'s "No Response" convention (`onGet` never throws while a snapshot exists;
`onSet` throws `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` on a failed write) is reused
unchanged for both switches' `onSet`/`onGet`. `AwayModeGuard`'s `AwayModeBlockedError` →
`NOT_ALLOWED_IN_CURRENT_STATE` mapping (`away-mode-guard/design.md`) does **not** apply to
either switch's own write: that guard gates `submitSide` (side-lane writes) only,
`submitSettings` (what both switches call) is never gated by it. This is worth stating
explicitly since it is an easy thing to get wrong by analogy with `ThermostatService`.

**HAP behavior this cannot fully confirm without a real paired device** (per this project's
own disclosure convention): exactly how the Home app surfaces two per-side "Away Mode"/"Skip
Next Alarm" switch tiles inside each side's existing accessory grouping — and whether users
find the naming clear without the additional explanatory text from the issues — is not
verifiable from unit tests against `test/fakeHomebridgeApi.ts`.

## Risks / Trade-offs

- **[`writeQueue.ts` gains a cross-lane coordination path]** → The drain-inline mechanism adds
  a new kind of interaction between the settings lane and side lanes that the module's dense
  existing documentation does not anticipate. Mitigation: scope the change narrowly (only
  triggers when a settings-lane write specifically touches `awayMode`, checked once per side
  dispatch), document it in the module's own doc comment alongside the existing away-mode-
  guard note, and add the regression test described above. Flagged for tech-lead sign-off
  before implementation.
- **[Two independent, not-yet-reconciled deltas against `pod-write-queue`'s away-mode
  requirement]** → This change's delta and `away-mode-guard`'s own unsynced delta both modify
  the same requirement text, against a main spec that reflects neither yet. Mitigation:
  documented explicitly in `specs/pod-write-queue/spec.md`'s own "Context" section; left for
  archive-time reconciliation, not solved here.
- **[Service-level debounce/rate-limit adds state to track per side]** → Modest complexity in
  two new small service files. Mitigation: mirrors `KeepAlive`'s own per-side state-tracking
  pattern (`src/pod/keepAlive.ts`), already proven out and tested.
- **[The local shadow duplicates a pattern (`publishedF`) rather than generalizing it]** →
  Accepted: `docs/HOMEKIT.md` itself frames `publishedF` as a specific, load-bearing
  anti-jitter mechanism, not a general-purpose utility; a premature abstraction over two
  now-existing instances is worse than two small, independently-testable, honestly-duplicated
  ones.

## Migration Plan

None required for deployed configs — all three new config keys are new, not repurposed, and
default to values that only *add* the requested behavior (or, for `awayModeTurnsSideOff`, add
nothing by default). Rollout is a normal code change: merge, release. No persisted Pod state
(other than the settings fields these switches are explicitly designed to write) is touched.

## Open Questions

- Whether the concurrent, not-yet-created "scheduled fast-poll around predicted alarm times"
  change (`docs/HOMEKIT.md`, "Alarm ringing," informally tracked against issue #16) ends up
  wanting `src/pod/alarmSchedule.ts` to export a richer shape (e.g., every side's next
  occurrence rather than one at a time, or a subscription/callback interface) is that change's
  decision to make when it lands; naming and creating the module with the shape this change
  needs is sufficient for this change to unblock on it without importing anything from that
  change's artifacts.

## Resolutions (tech lead, 2026-09-06)

1. **Drain-before-decide approved** — it fixes 'block''s correctness gap, not merely 'mirror'
   staleness. Condition: the deadlock-avoidance must be proven, not asserted — tests covering
   both submission orders × both settings-POST outcomes (success/failure), executed through
   the real mutex.
2. **`alarmSchedule.ts` ownership is PROVISIONAL** pending the concurrent alarm-events
   proposal's reconcile; whichever change the tech lead sequences first implements the module,
   the other consumes it. Do not treat this change's claim as final until recorded there.
3. **Defaults ratified**: awayModeSwitch/skipAlarmSwitch true (passive services — no polling
   load, so they don't muddy the M3 soak; the soak-cleanliness rule gates *pollers*, i.e.
   occupancySource stays 'none'), awayModeTurnsSideOff false; local optimistic shadow for
   skip-alarm; service-level rate limit; reuse of settleWrite/fast-poll path.
4. The stale main-spec note is correct procedure — deltas written against shipped behavior;
   the archive chore reconciles spec lineage.

### Addendum (tech lead, 2026-09-06): alarmSchedule ownership settled

Resolution 2's provisional claim is resolved AGAINST this change: `alarm-events` implements
first and creates `src/pod/alarmSchedule.ts` (pure derivation); this change CONSUMES it.
Adjust task wording accordingly at implementation time.
