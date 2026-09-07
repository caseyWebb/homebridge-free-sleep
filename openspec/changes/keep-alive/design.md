## Context

See `proposal.md` for motivation. This section only covers the merged-and-archived pieces
this design builds on, all in `src/pod/` and already shipped by `poller-and-write-queue`
(`openspec/changes/archive/2026-09-06-poller-and-write-queue/`):

- **`PodPoller`** (`src/pod/poller.ts`) owns every *read* cadence and writes only to
  `SnapshotStore`. Its module doc is explicit that it imports `client.ts`, `snapshot.ts`,
  `errors.ts` and `types.ts` **only — never `writeQueue.ts`**, "that would-be cycle is why the
  write queue takes a `requestFastPoll` callback instead of importing this module" (`poller.ts`
  lines 11–13).
- **`WriteQueue`** (`src/pod/writeQueue.ts`) is the only writer of *intent*: per-lane debounce
  → the power/duration reduction → one global FIFO mutex (`runExclusive`) → dispatch → overlay
  settle. Its module doc mirrors the same constraint the other direction: it imports
  `client.ts`, `snapshot.ts`, `errors.ts`, `types.ts` **only — never `poller.ts`** (lines
  19–21).
- **`pod-write-queue`'s own spec** (`openspec/specs/pod-write-queue/spec.md`, "Requirement: The
  queue holds no policy about away mode, keep-alive, or schedules") states outright: "Those
  behaviours belong to later, separately specified guards, which are expected to be built on
  the exclusive-section mechanism" — i.e. keep-alive was always meant to be a separate,
  small component sitting on top of `WriteQueue`, not inside it.
- **`SnapshotStore`** (`src/pod/snapshot.ts`) exposes `get()` synchronously and marks only
  `targetTemperatureF`, `isOn`, `isAlarmVibrating`, and `awayMode` as `OverlayableField`
  (lines 144–151); `secondsRemaining` is deliberately absent, and `WriteQueue.syncSideOverlays`
  (lines 220–224) never touches it.
- **The four-case reduction** (`writeQueue.ts`'s `reduceDurationFields`, lines 108–117, spec'd
  in `pod-write-queue`'s "Requirement: A patch never carries both power and explicit duration
  for one side"): a merged patch carrying both `isOn` and `secondsRemaining` keeps
  `secondsRemaining` whenever it is non-zero, keeps `isOn` otherwise. The archived design's own
  worked table (`poller-and-write-queue/design.md` lines 294–313) *already* names keep-alive as
  the reason this pair can arise at all: "Keep-alive (#12) re-posts `secondsRemaining` on a
  timer while the user toggles the side off in the Home app; both land in one 400 ms window,"
  and the tech lead's resolution 1 confirms the rule "stands."
- **Away mode**: `config.ts` already reserves `awayModeWritePolicy` for issue #13 ("Away-mode
  write guard for the both-sides coupling"), which per its own issue text will "Evaluate the
  mirror condition in `WriteQueue.flush()` before dispatch." That guard does not exist yet —
  today, per `pod-write-queue`'s spec ("Requirement: The queue holds no policy about away
  mode..."), "An away-mode write is dispatched, not guarded... the Pod's own both-sides
  coupling applies" (`docs/POD-API.md`: `controlBothSides = settings.left.awayMode ||
  settings.right.awayMode`).
- `src/config.ts` already reserves `keepAlive: z.boolean().default(true)` with a doc-comment
  table naming this change (`#12`) as its owner; it does **not** yet define `keepAliveMs` or
  `keepAliveThresholdMs` — those are new keys.
- `test/mockPod.ts` (the mock-Pod-as-oracle) reproduces `updateSide`'s guards verbatim
  (truthiness on `secondsRemaining`, fixed command order) but does **not** simulate real-time
  countdown: a stored `secondsRemaining` is static until the next write, never decremented by
  the mock's own clock (`mockPod.ts` lines 176, 264–305). Tests must seed a fixture's
  `secondsRemaining` directly to represent "already below threshold," not rely on advancing
  fake timers and expecting the mock to count down on its own.

## Goals / Non-Goals

**Goals:**
- A side HomeKit believes is on never silently expires, without any HomeKit-visible surface.
- The re-arm write is ordinary in every way a caller of `WriteQueue` can be — same debounce,
  same mutex, same reduction, no bespoke write path.
- Safe by construction across the Pod's daily reboot and across a user turning a side off
  through any path.

**Non-Goals:**
- No HomeKit switch or any other new accessory/service (issue #12 is explicit about this).
- No away-mode-specific logic in this component. Away mode is a general write-path problem
  (issue #13) with a general solution already scoped to land centrally in `WriteQueue`; keep-
  alive does not special-case it (see "Away mode" decision below).
- No change to `SnapshotStore`'s overlay rules or `WriteQueue`'s reduction — both already
  produce the right outcome for a keep-alive write with zero code changes (see below).
- No persisted rate-limit or schedule state across a Homebridge restart. A fresh launch starts
  this component's timer fresh; the worst case is one extra check cycle before a side genuinely
  near expiry is caught, which the threshold's margin already budgets for.

## Decisions

### A new, small, timer-owning module — not a poller endpoint class, not inside the write queue

`KeepAlive` (`src/pod/keepAlive.ts`) is a new class, structurally a peer of `PodPoller` and
`WriteQueue`, constructed and owned by `platform.ts` for the platform's lifetime. It needs to
both *read* `SnapshotStore` and *write* through `WriteQueue`, which rules out the other two
homes:

- **Not a `PodPoller` endpoint class.** Endpoint classes only read from the Pod and write to
  the snapshot (`EndpointClassSpec<T>`, `poller.ts` lines 60–75); none of the four take a write
  path, and `poller.ts` is contractually forbidden from importing `writeQueue.ts` at all (see
  Context). Bending that shape for one write-issuing "class" would violate the module boundary
  the previous change went out of its way to establish.
- **Not folded into `WriteQueue` itself.** `pod-write-queue`'s own spec says the queue "holds
  no policy about... keep-alive" and names the exclusive-section mechanism as the intended
  extension point for exactly this (see Context) — the queue is a mechanism, not a policy
  origin.
- **A dedicated timer, not event-driven off snapshot changes.** `secondsRemaining` is not a
  watched field (`snapshot.ts`'s `diffWatched`, and the archived design's "Watched fields are
  enumerated" section: "a watched countdown means an event storm forever") — there is no
  change event to hang a check off of even if that were otherwise desirable. There is also no
  urgency that would justify one: a side has a 12-hour budget, and the checks below run every
  few minutes at most, an enormous margin. A single independent, self-rescheduling
  `TimerApi`-driven loop (the same injected-timer pattern `PodPoller`, `WriteQueue`, and
  `SnapshotStore` all already use) is the simplest mechanism that satisfies the requirement,
  and introduces no new testing primitive.

`KeepAlive`'s constructor takes `{ snapshot, writeQueue, timers, logger, keepAliveMs,
keepAliveThresholdMs, enabled }` — plain values, no `PlatformConfig` awareness, matching how
`PollerOptions`/`WriteQueueOptions` are defined (archived design, "Config ownership: named
here, defined by `platform-foundation`"). `platform.ts` maps `parsed.data.keepAlive` to
`enabled` and `parsed.data.keepAliveMs`/`keepAliveThresholdMs` through, the same way it already
maps every other config field onto the poller/write-queue options objects.

### Check cadence and re-arm cooldown are both derived from the threshold, not a fourth config key

Issue #12's text proposes three keys, including a hardcoded "rate-limit to one re-arm per side
per 15 min." This design does not add a fourth config key for that. Instead:

- The periodic check interval is `clamp(keepAliveThresholdMs / 2, 60_000, 900_000)` — at most
  15 minutes (issue #12's own number, now a derived ceiling rather than an independent
  constant), at least 1 minute so a very small configured threshold cannot spin the timer.
  Checking at half the threshold guarantees a side crossing the threshold is caught before its
  remaining time can reach zero, since the check interval is always strictly smaller than the
  window between "crossed the threshold" and "would expire."
- Redundant re-arms are suppressed with a per-side, in-memory `nextDueAtMs`, set on a successful
  submission to `now + (keepAliveMs - keepAliveThresholdMs)` — the earliest wall-clock time the
  *newly re-armed* duration would itself next approach the threshold. A tick before that time
  skips the observed-value check for that side entirely, regardless of what the snapshot's
  (still stale, unconfirmed) `secondsRemaining` reads. This is necessary, not just tidy:
  `secondsRemaining` carries no optimistic overlay (see below), so the cached value does not
  reflect a just-issued re-arm until the next `deviceStatus` poll observes it — without this
  guard, every tick between the re-arm and that observation would resubmit. Deriving the
  cooldown from the same two config values, rather than adding a third, keeps the config
  surface at two keys (plus the boolean) and keeps the cooldown correct-by-construction if a
  user configures a non-default duration or threshold — a fixed 15-minute constant would not
  scale down for a deliberately short threshold.

### The check reads live snapshot state every tick — no locally-remembered "is on" flag

Each tick reads `snapshot.get()[side].isOn` and `.secondsRemaining` fresh; nothing about a
side's on/off history is cached across ticks except the `nextDueAtMs` cooldown above. This is
what makes both required safety properties fall out with no special-casing:

- **The daily reboot.** After a reboot every side's `secondsRemaining` resets to `0`
  (`docs/POD-API.md`, "the four things that shape the whole plugin", #4), so the next poll
  observes `isOn: false` for that side. The next tick reads that fresh `false` and does
  nothing — there is no stale "I last saw this side on" state anywhere to act on incorrectly.
- **A user turning a side off through any path** (Home app, free-sleep's own UI, a schedule).
  `isOn` *is* overlayable, and a HomeKit-originated `onSet(OFF)` installs an `isOn: false`
  overlay synchronously at submission (`writeQueue.ts`'s `submit`, called from
  `thermostat.ts`'s `onSet`) — before any dispatch even starts. If `KeepAlive`'s tick runs after
  that submission, it already reads the optimistic `false` and skips the side. (The narrower,
  opposite-order race — `KeepAlive` submits first, the user's off-click merges into the same
  still-open debounce window afterward — is a pre-existing, already-accepted risk; see Risks.)

### Re-arm writes go through `submitSide`, not `runExclusive`

`KeepAlive` calls `writeQueue.submitSide(side, { secondsRemaining: Math.round(keepAliveMs /
1000) })` — the same entry point `thermostat.ts` uses for every power and temperature write.
It carries no other field. Consequences, all already guaranteed by the merged write-queue
design with no code changes needed here:

- **The mutex and reduction cannot drop the re-post.** `reduceDurationFields` only ever removes
  `isOn` or `secondsRemaining`, never both (the four-case table, Context); since `KeepAlive`
  never submits `secondsRemaining: 0`, the field it cares about always survives dispatch, worst
  case at the cost of a coincident `isOn: false` in the same merge window (Risks).
- **No overlay code change is needed.** `secondsRemaining` is not `OverlayableField`, and
  `syncSideOverlays` never installs one for it (Context) — exactly the "no overlay" outcome
  `pod-keep-alive`'s spec requires, already true of the existing `writeQueue.ts`.
- **`runExclusive` is not needed here**, even though `pod-write-queue`'s design flagged `#12`
  as a plausible caller of it (archived design, "One global mutex, and `runExclusive` as the
  guard extension point," line 325). `runExclusive` exists for a read-decide-write sequence
  whose *decision* depends on a value that can go stale between the read and the dispatch —
  exactly issue #13's need to re-read `/api/settings` immediately before deciding mirror/block.
  `KeepAlive`'s decision depends only on the always-current, synchronous `snapshot.get()`, and
  the value it posts is a fixed constant (`keepAliveMs`) that does not depend on anything read
  earlier — there is nothing for a read-write race to corrupt. `submitSide` already queues
  behind the mutex on its own. (Flagged for tech-lead confirmation — see Open Questions.)

### Away mode: no special-casing, by design

`KeepAlive` performs no away-mode check of its own. Two reasons:

- **A duplicate, possibly-divergent policy is worse than none.** Issue #13 is the single place
  `awayModeWritePolicy` (`block`/`mirror`/`allow`) is meant to be decided and enforced, and its
  own text places the check inside `WriteQueue.flush()` "before dispatch" — a choke point every
  lane's writes pass through, `KeepAlive`'s included, with no caller-side awareness required.
  If `KeepAlive` also declined to write under away mode using its own logic, the plugin would
  have two independently-maintained away-mode policies that could disagree.
- **Today, before #13 lands, this is a real, pre-existing gap, not one this change introduces.**
  `pod-write-queue`'s spec already documents "An away-mode write is dispatched, not guarded" as
  current behavior for every caller of `submitSide`, `KeepAlive` included once this change
  ships. Concretely: if either side has `awayMode` on, a `KeepAlive` re-arm addressed to one
  side is, per the Pod's own coupling, also applied to the other side (`docs/POD-API.md`,
  "Away-mode coupling"). This is exactly the same exposure every other HomeKit-triggered write
  already has today; this change does not make it worse, and does not attempt to fix it either,
  since the fix is centrally scoped to #13.

This is the one interaction that genuinely needs a second set of eyes before implementation —
see Open Questions.

## Risks / Trade-offs

- **[Risk] The opposite-order debounce race.** If `KeepAlive` submits `{secondsRemaining: N}`
  for a side, and — within that same ~400 ms (default `writeDebounceMs`) still-open debounce
  window — the user turns that side off, the two merge into one pending patch
  `{isOn: false, secondsRemaining: N}`. The reduction keeps `secondsRemaining` (Context), so the
  dispatched body is `{secondsRemaining: N}` alone and the side ends up **on**, not off as the
  user intended, until they notice and try again. Walking the actual code: `submit()` calls
  `syncSideOverlays` on every merge (`writeQueue.ts` lines 172–174, 220–224), so the user's own
  `isOn: false` overlay — installed the instant they toggled it — is itself cleared the moment
  `KeepAlive`'s merge recomputes the reduced patch, since the recomputed `reduced.isOn` is now
  `undefined`. The optimistic "off" tile the user saw would revert before any Pod response
  arrives. → **Mitigation: none attempted here.** This exact scenario is the one the archived
  `poller-and-write-queue` design names by number ("Keep-alive (#12) re-posts `secondsRemaining`
  on a timer while the user toggles the side off... both land in one 400 ms window") and whose
  resulting reduction rule the tech lead explicitly reviewed and confirmed ("resolution 1: the
  four-case coalescing rule stands"). Closing it would mean changing the already-shipped,
  already-reviewed reduction rule, which is out of this change's scope. The window is bounded
  (one `writeDebounceMs`, 400 ms by default) and only occurs when a re-arm and a same-side
  off-toggle land within it — rare in practice, and never occurs at all if the ordering happens
  to be reversed (user's overlay lands first — see the "live snapshot state" decision above).
- **[Risk] Away-mode mirroring.** Covered above; owned by issue #13, not newly introduced by
  this change, and expected to close automatically once #13's guard lands in `WriteQueue`.
- **[Risk] `keepAlive: true` is the existing default, so shipping this change silently turns on
  new background write traffic for every install that never explicitly set `keepAlive`.** →
  Mitigation: this is issue #12's own explicit intent ("default ON — 'on' should mean 'on'"),
  the traffic is at most one write per side roughly every `keepAliveMs - keepAliveThresholdMs`
  (about once every 11.5 hours under the defaults) while that side is on, and it is logged at
  `debug` like every other write (`writeQueue.ts`'s existing dispatch logging).

## Migration Plan

No persisted state, no schema migration. New file (`src/pod/keepAlive.ts` + its test), two new
`config.ts` fields with safe defaults, one new construction site and one new `stop()` call in
`platform.ts`'s existing shutdown handler (alongside `poller.stop()`/`writeQueue.stop()`).
Rollback is deleting the new source file and test and reverting the `config.ts`/`platform.ts`
edits — identical in shape to the archived `poller-and-write-queue` change's own rollback note.

## Open Questions

Flagged for tech-lead review; per this project's convention (see the archived
`poller-and-write-queue` design), none of these change the specs, the chosen approach, or the
task breakdown as currently written — they are asking for confirmation, not raising a blocker.

1. **Is `submitSide` (no `runExclusive`) really sufficient, given `pod-write-queue`'s own
   design named `#12` as an expected `runExclusive` caller?** This design's reasoning is that
   `runExclusive` is for a decision that can go stale between read and write (issue #13's
   settings re-read); `KeepAlive`'s decision does not have that shape. Confirm, or identify a
   scenario this reasoning misses.
2. **The derived check interval (`clamp(keepAliveThresholdMs / 2, 60_000, 900_000)`) and
   cooldown (`keepAliveMs - keepAliveThresholdMs`) replace issue #12's literal "rate-limit to
   one re-arm per side per 15 min" with a formula.** Confirm the formula is an acceptable
   reading of that requirement, including its floor/ceiling bounds.
3. **Minimum bounds for `keepAliveMs`/`keepAliveThresholdMs`.** No minimums are dictated by the
   issue; this design assumes `1000` ms bounds are enough to reject nonsensical configuration
   (e.g., a duration under a second) without a more specific bound. Confirm, or provide the
   bound explicitly the way `pollIntervalMs`'s `5000` and `fastPollIntervalMs`'s `3000` were.
4. **Away-mode non-special-casing (the "Away mode" decision above).** Confirm that a
   `KeepAlive`-originated write should be treated as an ordinary lane write for #13's purposes
   with no caller-identifying metadata, and that #13's guard is expected to land inside
   `WriteQueue` itself (its own issue text says `flush()`) rather than at each call site — the
   latter would silently exclude `KeepAlive` from the guard.

## Resolutions (tech lead, 2026-09-06)

1. **`submitSide` without `runExclusive` stands.** The queue's global mutex already serializes
   dispatches; `runExclusive` exists for multi-step read-then-write atomicity (#13's guard),
   which a single-shot re-arm is not.
2. **Derived check interval and cooldown stand** — fewer knobs, same behavior.
3. **1000 ms minimum bounds stand.**
4. **Confirmed: #13's guard lands centrally in `WriteQueue.flush()`** so KeepAlive-originated
   writes pass through it with no special casing here. This is binding on the
   `away-mode-guard` change.
5. **The debounce-window race is NOT an accepted risk — fix it in this change.** A user's
   explicit off must always win over a keep-alive re-arm. Mechanism: origin-tagged patches —
   `submitSide` gains an origin (`'user' | 'keepAlive'`, default `'user'`); when the debounce
   merge combines a user-origin `isOn` with keep-alive-origin duration fields, the keep-alive
   fields are dropped before the four-case reduction runs. Add the spec requirement ("an
   explicit user off submitted in the same debounce window as a keep-alive re-arm always
   turns the side off") and a mock-as-oracle test proving it, plus the inverse (keep-alive
   re-arm alone still refreshes). The optimistic-off tile reversion the analysis traced is
   thereby prevented too.
