## Context

See proposal.md — Why. Every Pod-behaviour claim below cites a path in the free-sleep checkout
at `~/Code/free-sleep`, pinned at **v2.1.5, commit `dc0c710`** (same pin as `docs/POD-API.md`
and every prior change's design.md).

Pre-existing state this design builds on, all already shipped:

- `PodPoller.requestMode(classId, { intervalMs, untilMs, reason }): () => void`
  (`src/pod/poller.ts`) — a stacking set of poll-rate modes, effective interval is the minimum
  across all active modes plus the base rate. `poller-and-write-queue/design.md`'s "Poll modes
  are a stack, and that is how the alarm window (#16) arrives" explicitly designed this so #16
  needs **zero changes to `poller.ts`**: "`#16` will add `reason: 'alarm'` at
  `alarmPollIntervalMs` for a window computed from `/api/schedules` and `settings.timeZone` —
  both already in the snapshot because this change polls them. No poller change is required for
  #16." `HARD_FLOOR_MS = 3000` in `poller.ts` is the reason `alarmPollIntervalMs`'s schema
  minimum is also `3000` (`src/config.ts`).
- `SnapshotStore` (`src/pod/snapshot.ts`) already watches `isAlarmVibrating` per side
  (`SideChangeField`) and already exposes `documents.schedules`/`documents.settings` — the full,
  un-diffed last-observed documents (`EffectiveDocuments`) — precisely so a consumer like this
  change can read them without a dedicated poll class. Neither `schedules` nor `settings` is a
  *watched* field (design.md's "Watched fields are enumerated, and the countdown is deliberately
  not one": "the whole of `schedules` and `services` (read on demand by #16/#19)") — so nothing
  fires a change notification when either updates. This design's scheduler must poll its own
  cached-document read on its own timer, not react to a `Change` event, for exactly that reason.
- `platform.ts`'s `handleSnapshotChanges` already has a explicit, named placeholder for this:
  "`isAlarmVibrating`, `awayMode`, `waterLevelState`, `isPriming`: no published service watches
  these fields yet — ignored, without error (design.md's routing table; #13/#16/#19/#20)."
- `WriteQueue.submitSide(side, { isAlarmVibrating: false })` is already fully implemented and
  mock-tested (`pod-client`/`poller-and-write-queue` changes): `writeQueue.ts`'s
  `SidePatch`/`OverlayableField`/`applyOrClearOverlay` all already include `isAlarmVibrating`,
  and `test/mockPod.ts`'s `updateSide` already reproduces the exact server-side effect
  (`ALARM_CLEAR`, forced to `false`). This change adds a new *caller*, not new machinery.
- `ThermostatService` (`src/services/thermostat.ts`) is the established pattern for: per-service
  `setProps` at construction, a B1 initial-publish call from the constructor, a `scheduleXRevert`
  timer for "accept, then quietly correct" writes, and a `platformStartedAt`-based No-Response
  escalation predicate on `onGet`.

**No HAP claim below needs a real paired device except one, called out at its own decision.**

## Goals / Non-Goals

**Goals:**

- Predict every side's upcoming alarm instant(s) using only already-cached, already-polled
  documents — no new endpoint, no new `PodClient` method, no new poll class.
- Reuse `requestMode` exactly as designed for this purpose; the poller stays untouched.
- Reproduce upstream's own scheduling predicate (which weekdays produce an alarm, which
  calendar day it lands on, how `scheduleOverrides.alarm` skips or retimes it) faithfully enough
  that this plugin's fast-poll window and the Pod's own recurring job agree on when an alarm can
  fire — a false negative here is the one failure mode HOMEKIT.md calls "the feature does not
  work," so precision matters more than covering every corner of the override UI.
- Land the two HAP services using exactly the primitives HOMEKIT.md already fixed
  (`StatelessProgrammableSwitch`, `Switch`), wired through the platform's existing routing/prune
  machinery with no new mechanism.

**Non-Goals:**

- Writing `scheduleOverrides.alarm` (issue #17's "Skip Next Alarm" switch) or firing an alarm on
  demand (issue #20's "Test alarm" switch, `POST /api/alarm`) — see proposal.md's Non-goals.
- A generic "next N alarms" API. Only "is now inside a window" and "when is the next relevant
  recompute" are needed, and the design below computes exactly those.
- Perfect precision across a daylight-saving transition. See "Timezone arithmetic" below —
  called out honestly, not silently assumed correct.
- Modifying `writeQueue.ts`/`awayModeGuard.ts`. See "Away-mode interaction with the dismiss
  write" below and proposal.md's Non-goals — flagged for tech-lead review, not touched here.

## Decisions

### A new peer module, `AlarmWindowScheduler`, not a `PodPoller` endpoint class or `WriteQueue` logic

Structurally identical in role to `KeepAlive` (`src/pod/keepAlive.ts`): a small, self-rescheduling,
timer-owning module that sits beside `PodPoller`/`WriteQueue`, imports `snapshot.ts` for reads and
`poller.ts` for its one write-shaped call (`requestMode`), and is constructed once per launch by
`platform.ts`. It is **not** a `PodPoller` endpoint-class descriptor, because a descriptor's job is
"read an endpoint and apply it to the snapshot" — this module reads the snapshot, not the Pod, and
calls a poller *method*, which a descriptor has no access to (descriptors are internal to
`poller.ts`). It is **not** logic inside `WriteQueue`, because it issues no write at all.

Alternative considered: fold this into `KeepAlive` (also a per-side "check a threshold, act on
it" timer). Rejected — `KeepAlive` reads `deviceStatus` and writes; this reads `schedules`/
`settings` and calls `requestMode`. Sharing a module would mean one class importing both
`WriteQueue` and `PodPoller`, which is currently true of nothing in `src/pod/` and would make an
already-large module respond to two unrelated inputs.

### Recomputation: a hybrid of exact-timing and a periodic safety ceiling

The scheduler holds a `Map` from a stable occurrence key (`${side}:${instantMs}:${source}`,
`source` being `'regular'` or `'override'`) to the `release` callback `requestMode` returned for
it. On construction and after every tick:

1. Recompute the full list of upcoming instants (see "Deriving instants" below) out to a
   `LOOKAHEAD_HORIZON_MS` bound (one week plus a day of slack — long enough that a side whose
   only enabled weekday is six days out is still found).
2. For every instant whose window (`instant ± 3 min`) currently contains "now" and is not
   already an active key: call `requestMode('deviceStatus', { intervalMs: alarmPollIntervalMs,
   untilMs: instant + 3 min, reason: 'alarm' })` and record the release.
3. For every currently-active key no longer present in the fresh list (the schedule changed out
   from under an armed window) whose `untilMs` has not yet passed: call its `release()`
   immediately and drop it, rather than leaving a stale fast-poll window running to its original
   expiry for an alarm that no longer exists.
4. Schedule the next tick at `clamp(timeUntilSoonestUnarmedWindowStart, MIN_TICK_MS,
   RECOMPUTE_CEILING_MS)` — exact-timing for the next window that matters, but never longer than
   `RECOMPUTE_CEILING_MS` even when nothing is upcoming soon, so a schedule edited through
   free-sleep's own web UI (which this plugin cannot get a push notification for — see Context)
   is still caught promptly.

`RECOMPUTE_CEILING_MS` is a module constant, not derived from `slowPollIntervalMs` — the two are
conceptually related (both bound "how stale can our view of `schedules`/`settings` be") but
deriving one from the other would make this module's own cadence a hidden function of an
unrelated config default in a different module, which is exactly the kind of implicit coupling
`poller-and-write-queue/design.md`'s "Cadence arithmetic, in one place" argues against. Proposed
default: 5 minutes — matching `slowPollIntervalMs`'s own default order of magnitude (there is no
point recomputing meaningfully faster than the documents themselves can change), while every
window is 6 minutes wide, so a 5-minute ceiling can never let an entire window pass unnoticed
between two ticks (worst case: activation lands up to ~5 minutes late relative to a window's
*start*, i.e., a same-day schedule edited into existence with under 5 minutes' notice may get a
shortened or missed fast-poll window — an accepted, rare edge case, not a scenario the "done
when" bar in issue #16 is stated against).

Alternative considered: subscribe to `snapshot.subscribe()` and recompute on every notification.
Rejected — `schedules`/`settings` changes are not watched/diffed fields (Context), so no
notification would ever fire for the input this module actually depends on; subscribing would
recompute on every unrelated `isOn`/temperature poll instead, which is both wasteful and would
not even solve the staleness problem it looks like it solves.

### Deriving instants: reproducing `alarmScheduler.ts` and `jobs/utils.ts` faithfully

For side `s`, weekday `w`, with `daily = schedules[s][w]`:

1. **Eligibility** (`alarmScheduler.ts`'s `scheduleAlarm`, its four early-return guards):
   `daily.power.enabled && daily.alarm.enabled && !settings[s].awayMode && settings.timeZone` —
   all four required, or `w` contributes nothing for `s`.
2. **Calendar-day shift** (`jobs/utils.ts`'s `getDayIndexForSchedule`/`isEndTimeNextDay`): the
   alarm's literal weekday is `w` shifted forward one day when `Number(daily.power.off.split(':')
   [0]) <= 12` — an overnight session (power off after midnight) puts the alarm on the day after
   the schedule's own key, not on it. Verbatim port of `isEndTimeNextDay`'s one-line predicate.
3. **The instant**: `daily.alarm.time` (`HH:mm`) on that shifted weekday, in `settings.timeZone`,
   at its next future occurrence (today-or-later, or next week if today's already passed —
   mirroring `nextOccurrenceHhMm`'s "if already passed, add a day" shape, generalized to "next
   occurrence of this weekday-and-time" rather than "next occurrence of this time-any-day," since
   a weekly recurrence, unlike the one-shot override job, is pinned to a specific weekday).
4. **`scheduleOverrides.alarm` interaction** (`docs/POD-API.md`; `alarmScheduler.ts`'s recurring
   job body, which checks only `expiresAt`, and its `scheduleAlarmOverride`, which the one-shot
   override job comes from):
   - If `settings[s].scheduleOverrides.alarm.expiresAt` parses to an instant strictly later than
     "now" **and** the regular occurrence computed above falls at or before that expiry, the
     regular occurrence is skipped — mirroring that by the time the Pod's own recurring job would
     fire it, `expiresAt` will still be in the future and its own check will skip it too. An
     occurrence *after* the expiry is unaffected (by the time the Pod would fire that one,
     `expiresAt` has already lapsed). `disabled` plays no role in this check at all — a documented
     upstream quirk (`docs/POD-API.md`: "`disabled` is read solely by `scheduleAlarmOverride`,"
     never by the recurring job's own skip check).
   - Independently, if `scheduleOverrides.alarm.disabled` is `false` and both `timeOverride` and
     `expiresAt` are set with `expiresAt` still future, one additional one-shot instant is
     derived: the next occurrence of `timeOverride` (`HH:mm`, any day, not weekday-pinned — mirrors
     `nextOccurrenceHhMm`) in `settings.timeZone`. This is `source: 'override'` in the occurrence
     key, kept distinct from any `source: 'regular'` occurrence it happens to suppress, since the
     two are independent computations that only sometimes interact.

This is intentionally more literal than "clever": each of the four steps above is a small, direct
port of a specific upstream function, chosen so a future upstream change to any one of them (a new
`vibrationPattern`, a changed midnight-crossing rule) is a one-function diff here too, not a
re-derivation from first principles.

### Timezone arithmetic: `settings.timeZone` via `Intl`, not the host's local zone, and not a new dependency

**Decision: `settings.timeZone`, computed with the runtime's built-in `Intl.DateTimeFormat`.**
Upstream's own scheduler interprets every `HH:mm` in `settings.timeZone` via `moment.tz`
(`alarmScheduler.ts`: `moment.tz(settingsData.timeZone)`, `moment.tz(alarmOverride.expiresAt,
settingsData.timeZone)`) — never the machine the free-sleep server happens to run on, and
certainly never the machine *this plugin* runs on (a separate, always-on host, per CLAUDE.md).
Using the bridge host's local timezone instead of `settings.timeZone` is exactly the "classic bug
source" the task brief calls out: a plugin host in UTC (common for a headless server) computing
"6:45 AM" in its own zone against a Pod configured for `America/Los_Angeles` would be off by 7–8
hours — not a rounding error, a fundamentally wrong day-part.

No new npm dependency (`moment-timezone`, `luxon`, etc.) is added for this — `zod` remains the
project's only production dependency (`package.json`), and Node's built-in
`Intl.DateTimeFormat(locale, { timeZone })` already answers exactly the one question needed:
"what are this instant's wall-clock fields in this IANA zone?" The standard technique with no
date library: format a candidate UTC instant's fields *as displayed in the target zone*, compare
against the same instant's own UTC fields to get that zone's current offset, then correct the
candidate by that offset and repeat once more (offsets only take two values per zone per year, so
one correction converges except within the transition window itself — see below). This is the
same "format, diff, correct" trick every dependency-free "Intl-based timezone" utility uses.

**DST edges, noted honestly, not silently assumed correct.** A wall-clock time that is skipped
(spring-forward) or repeated (fall-back) in the target zone is a genuine ambiguity with no single
correct instant — every date library resolves it by some convention, none of them "correctly."
This design's convergence loop resolves a skipped time to the post-transition instant and a
repeated time to whichever offset the second correction iteration lands on (empirically, the
first/earlier of the two candidates for most `Intl` implementations, but this has **not been
verified on a real paired device across a real transition** and is flagged here rather than
asserted). This matches, not improves on, upstream's own posture: `moment.tz` resolves the same
ambiguity by its own internal convention with no error either. The practical exposure is small —
one bad prediction, at most, twice a year, for whichever side has an alarm scheduled inside the
one-to-two-hour transition window — and the base 30 s poll (or whatever fast-poll another
concurrent reason is holding) remains a fallback that still has a real, if reduced, chance of
catching a 10–180 s alarm.

Alternative considered: add `moment-timezone` or `luxon` just for this. Rejected — one function's
worth of arithmetic does not justify a new production dependency and its own DST-table
maintenance burden in a project that has deliberately kept `zod` as its only one; `Intl`'s IANA
data is already correct and already shipped with Node.

### The two HAP services: one new file, following `ThermostatService`'s established shape

`src/services/alarm.ts` exports one `AlarmService` class per side (constructed with `(ctx, side,
platformStartedAt)`, mirroring `ThermostatService`'s signature), owning both the programmable
switch and the dismiss switch — they share the same one watched field and the same "what do we
do when `isAlarmVibrating` changes" logic, so one class avoids splitting that logic across two
files that would need to agree on the same rising-edge definition.

- **Naming/subtypes**: press service named `` `${accessory.displayName} Alarm` `` (e.g. "Pod Left
  Alarm," matching issue #16's own suggested name), subtype `alarm-press`; dismiss service named
  `'Dismiss Alarm'` (issue #16's literal name), subtype `alarm-dismiss`. Both added to
  `platform.ts`'s `enabledServiceKeysFor` for side roles only (never the hub), so the existing
  prune-on-restore machinery covers them with no new mechanism (`platform` spec delta).
- **Rising-edge definition, and why bootstrap never fires a press**: `change.previous === false
  && change.current === true`, evaluated from the `Change` object the platform's routing table
  hands the service directly — not re-derived from `snapshot.get()`, which only has "now," not
  "a moment ago." `SnapshotStore`'s diff (`snapshot.ts`'s `pushSideChange`) emits a `Change`
  whenever `current !== previous` and `current !== undefined`, which includes the very first
  observation (`previous === undefined`). A first observation of `isAlarmVibrating: true` — the
  platform started mid-alarm — must not fire a press: "just started" is not knowable, and
  `alarm-events` spec's own "A pre-existing vibration observed at startup fires no press"
  requirement is exactly this case, guarded by requiring `previous === false` (not merely
  `!== true`). The dismiss switch's own state, by contrast, is pushed on *any* observation
  including the first (it has no "edge" semantics, just "reflect the current value"), using the
  same B1 initial-publish-from-constructor pattern `ThermostatService`/`ConnectionService`
  already use.
- **Programmable switch mechanics**: `setProps({ validValues: [SINGLE_PRESS] })` at construction
  — HOMEKIT.md: "HAP explicitly exempts `ProgrammableSwitchEvent` from the `setProps`
  revalidation path to avoid ghost presses," so this is safe the same way it is for every other
  button-shaped HomeKit accessory. No `onGet` at all — this characteristic has no meaningful
  "current value" to serve; every existing `StatelessProgrammableSwitch` implementation is
  push-only via `updateValue`, and this one follows suit. **This one HAP behavior — that firing
  `updateValue(SINGLE_PRESS)` reliably surfaces as "When … is pressed" in a real Home app's
  automation picker — is stated in HOMEKIT.md and is one of the two claims in this whole change
  that can only be confirmed on a real paired device** (the other being the DST resolution
  above); everything else is either upstream source-verified or internal HAP-NodeJS mechanics
  already exercised by the existing test suite's fake Homebridge API.
- **Dismiss switch mechanics**: `onGet` returns the observed `isAlarmVibrating` (default `false`
  when unknown, matching `characteristic.value`'s HAP default), gated by the same
  `noResponseAfterMs`/`platformStartedAt` escalation predicate `ThermostatService` already uses
  (`assertNotEscalated`) — this service has no fault/status channel of its own, so it follows the
  general policy rather than the connection sensor's exception. `onSet(false)` calls
  `writeQueue.submitSide(side, { isAlarmVibrating: false })`; on `AwayModeBlockedError`, logs at
  debug, schedules a revert (see below), and throws `NOT_ALLOWED_IN_CURRENT_STATE`; on any other
  rejection, throws `SERVICE_COMMUNICATION_FAILURE` — identical error-mapping shape to
  `ThermostatService`'s `onSet` handlers. `onSet(true)` **never calls `writeQueue` at all** — per
  HOMEKIT.md, `isAlarmVibrating: true` is unsupported server-side (`docs/POD-API.md`: "`true` is
  unsupported and logged as such") — it accepts the write, and schedules a revert-to-observed-
  value after `AWAY_MODE_BLOCKED_REVERT_DELAY_MS` (500 ms, reusing `ThermostatService`'s already-
  named constant and its injected-`TimerApi` revert-timer pattern) via a `refresh()` call that
  re-reads the snapshot's actual current value — not a hardcoded `false`, so a write that raced a
  genuine alarm start-of-vibration still reports correctly.
- **No config-gating flag.** Unlike LED/Prime/Test-alarm/water-sensor-type (HOMEKIT.md's "Other
  service choices" table, all explicitly opt-in or configurable), the "Alarm ringing" section
  carries no such caveat, and issue #16's own "done when" bar assumes both services simply exist.
  Decision: both services are unconditionally part of a published side accessory, exactly like
  the thermostat and unlike the opt-in hub extras — **flagged for tech-lead confirmation**, since
  this is inferred from the absence of a stated opt-in rather than an explicit design decision.

### Mock Pod: one fault-injection-style addition, no scheduler of its own

`test/mockPod.ts`'s `updateSide` already reproduces the `isAlarmVibrating: false` → `ALARM_CLEAR`
write path exactly. What it lacks is any way for the mock to become `true` in the first place — it
has no `alarmScheduler.ts` equivalent, deliberately (`test/mockPod.ts`'s own doc: "Deliberately
implements no plugin policy"). Tests need to simulate "the Pod's own scheduler just fired an
alarm," which is server-side state this plugin's writes never produce. Decision: add one small,
directly-analogous-to-`fault()` method, e.g. `pod.setAlarmVibrating(side, value)`, that mutates
`state.deviceStatus[side].isAlarmVibrating` directly with no HTTP round trip and no command
recorded (it is not a write the plugin issued) — the same "test reaches into `MockPod.state`
directly" pattern the mock's own public `state` field already documents as "live, readable and
writable by the test directly" (`pod-client/design.md`, "Mock shape"). No change to the mock's
HTTP surface, write semantics, or fault-injection machinery.

### Away-mode interaction with the dismiss write: flagged, not fixed, here

See proposal.md's Non-goals for the two consequences (`'mirror'`: harmless; `'block'`: a real
functional lockout). This design does not modify `writeQueue.ts`/`awayModeGuard.ts` — both are
owned by the concurrently in-flight `away-mode-guard` change, whose landed shape is not yet
visible to this proposal (no synced `pod-write-queue`/`away-mode-guard` spec exists in
`openspec/specs/` as of this writing). The recommended fix, for whoever resolves this — either
folded into this change once `away-mode-guard` has landed, or as its own immediate follow-up — is
narrow: in `WriteQueue.dispatch()`, treat a side patch whose only field is `isAlarmVibrating` as
policy `'plain'` unconditionally, before the existing `'block'`/`'mirror'` branch, citing
`updateSide`'s alarm block never consulting `controlBothSides`/`updateLeft`/`updateRight`
(`test/mockPod.ts`, mirroring `updateDeviceStatus.ts`). This one exemption fixes both documented
consequences at once (an alarm-only patch is never blocked and never mirrored), rather than
patching each separately. See Open Questions.

## Risks / Trade-offs

- **The away-mode `'block'` policy can prevent dismissing a real, currently-vibrating alarm from
  HomeKit.** → See "Away-mode interaction," above and Open Questions; this is the single most
  important open item in this design, more severe than a missed prediction, since it can make the
  Dismiss switch itself non-functional under a policy combination this plugin already ships.
- **A schedule edited with under ~5 minutes' notice for a same-day alarm may get a late or
  missed fast-poll window.** → `RECOMPUTE_CEILING_MS`'s trade-off, accepted (see "Recomputation"
  above); the base poll (and any other concurrently active fast-poll reason) remains a fallback.
- **DST transition instants are unverified.** → Noted honestly above; matches upstream's own
  unverified posture rather than silently assuming correctness neither this plugin nor upstream
  has actually confirmed.
- **A side observed in away mode contributes no predicted instant at all**, even though the Pod's
  own recurring job (`scheduleAlarm`) makes the identical exclusion — so this is intentional
  parity, not a gap, but it does mean re-enabling a side from away mode requires this scheduler's
  own next recompute (bounded by `RECOMPUTE_CEILING_MS`) before a same-day alarm gets its window,
  same as any other schedule change (see "A schedule edit is eventually reflected").
- **The "no config-gating flag" decision is inferred, not explicit** (see its own bullet above).
  → Flagged for tech-lead confirmation; cheap to add a boolean later if wrong, since both services
  are additive to the existing prune-table mechanism.
- **`ProgrammableSwitchEvent`'s real-device automation-picker behavior is assumed, not verified**
  on a real paired Pod/Home app, same category of risk `poller-and-write-queue/design.md` already
  accepted for its own HAP-timing assumptions (its #15 is the designed real-hardware check).

## Migration Plan

No migration. New files only (`src/pod/alarmWindowScheduler.ts`, `src/services/alarm.ts`, their
tests, one small addition to `test/mockPod.ts`); `alarmPollIntervalMs`'s schema shape is
unchanged (already shipped, already defaulted, already validated) — only its doc comment moves
from "reserved" to "consumed," and `platform.ts` gains construction/shutdown wiring plus two
routing-table/prune-table entries. Rollback is deleting the two new source files, reverting
`platform.ts`'s wiring, and reverting the doc-comment-only `config.ts` edit.

## Open Questions

Flagged for tech-lead review; (1) is a genuine "should this land here or as a fast-follow"
sequencing call, not a spec-changing question — the other two are lower-stakes confirmations.

1. **Should the away-mode `'block'`-lockout fix (see "Away-mode interaction") be a task in this
   change, gated on `away-mode-guard` having landed first, or tracked as its own immediate
   follow-up issue once both are shipped?** Recommendation: fold it into this change's tasks,
   gated, since shipping the Dismiss switch without it means shipping a switch that can be
   silently non-functional under a policy this plugin already offers — but the sequencing
   dependency on a concurrently in-flight change's exact landed shape is real and not this
   proposal's to resolve unilaterally.
2. **Is "no config-gating flag" for the two alarm services correct**, or should there be an
   `alarmEvents: boolean` (or similar) alongside the already-opt-in hub extras? Recommendation:
   no flag, matching the thermostat/connection-sensor precedent and HOMEKIT.md's silence on this
   point being read as "not opt-in."
3. **Is the DST-transition resolution behavior (see "Timezone arithmetic") acceptable as
   documented-but-unverified**, or does it need an explicit unit test pinning the exact resolved
   instant for a specific real transition (e.g. `America/Los_Angeles`'s 2027 spring-forward), so
   a future `Intl`/Node behavior change is caught rather than silently drifting? Recommendation:
   add the pinned test (cheap, deterministic, no live Pod needed) even though the *correctness*
   of the chosen resolution itself remains unverified against real hardware.

## Resolutions (tech lead, 2026-09-06)

1. **Alarm-only patches are exempted from the away-mode guard, in THIS change, ungated.**
   The guard (change `away-mode-guard`) is already merged — the sequencing concern is moot.
   Upstream never away-scopes `isAlarmVibrating` (and does not mirror it either), so a patch
   containing ONLY `isAlarmVibrating` bypasses `decide()` and is never mirrored; anything
   else in the patch keeps full guard semantics. Task group 10 is approved as immediate work
   with a regression test (dismiss under 'block' + away on → write lands, exactly one side).
2. **Config flag added: `alarmEvents`, default `true`** — the fast-poll load is bounded and
   purposeful (only near actually-enabled alarms; zero impact on alarm-free Pods), so
   default-on is right; the flag exists for opt-out and for keeping a soak profile frozen.
3. **Shared-module ownership settled** (supersedes settings-switches' provisional claim):
   THIS change implements first and must split the PURE next-alarm derivation (eligibility,
   midnight-crossing, override-skip, timezone) into `src/pod/alarmSchedule.ts`, consumed by
   `AlarmWindowScheduler` here and by `settings-switches`' skip-next-alarm computation later.
   The scheduler module keeps only the window/timer/requestMode concerns.
4. Timezone: `settings.timeZone` via Intl ratified; the pinned regression test stands; DST
   real-world behavior joins #36's observation list at implementation time.
