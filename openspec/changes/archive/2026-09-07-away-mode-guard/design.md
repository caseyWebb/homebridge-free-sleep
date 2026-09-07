## Context

See proposal.md — Why. This section covers only what the approach needs that proposal.md
doesn't already state.

Pre-existing state this design builds on (all shipped, all unmodified by this change):

- **`WriteQueue`** (`src/pod/writeQueue.ts`) already exposes `runExclusive<T>(fn): Promise<T>` —
  built for exactly this purpose. The `pod-write-queue` spec's own words: "The queue SHALL
  additionally expose a way to run an arbitrary read-modify-write sequence inside that mutex, so
  that a later guard which must read settings, decide, and then write cannot be interleaved with
  an unrelated write" (`openspec/specs/pod-write-queue/spec.md`, "All writes are serialised
  through one mutex"). And explicitly: "Those behaviours belong to later, separately specified
  guards, which are expected to be built on the exclusive-section mechanism" ("The queue holds no
  policy about away mode…"). This change is that guard.
- **`SnapshotStore`** (`src/pod/snapshot.ts`) already treats `awayMode` as an overlayable,
  watched, per-side field (`OverlayableField`, `SideChangeField`), populated from
  `settings.{left,right}.awayMode` and settled by `WriteQueue.submitSettings`'s existing
  `syncAwayModeOverlays`. Critically: `submitSettings` installs the `awayMode` overlay
  **synchronously at submission**, before any network request — so any away-mode toggle this
  plugin itself makes is visible in `snapshot.get()` immediately, not after the POST completes.
  `SnapshotStore`'s module doc currently states "`WriteQueue` … is the only writer of the
  optimistic overlay" — this change preserves that invariant exactly (see "Mirroring reuses
  `submitSide`, not a second overlay writer" below), so no edit to `snapshot.ts` is needed.
- **`FreeSleepConfigSchema`** (`src/config.ts`) already validates `awayModeWritePolicy` as
  `z.enum(['mirror', 'block']).default('mirror')`, and `config.schema.json` /
  `README.md` already document that exact shape as "Reserved — no effect yet. Planned for M3
  (#13)." This is the schema the guard consumes as-is.
- **`test/mockPod.ts`** already reproduces `updateSide`'s `controlBothSides` behavior verbatim
  (`openspec/specs/pod-test-double/spec.md`, "The mock reproduces away-mode both-sides
  mirroring"), and free-sleep's own source is unambiguous:
  `const controlBothSides = settings.left.awayMode || settings.right.awayMode;`
  (`server/src/routes/deviceStatus/updateDeviceStatus.ts`, `~/Code/free-sleep`, v2.1.5,
  `dc0c710` — same pin as `docs/POD-API.md`).

Constraint this design must respect: `pod-write-queue`'s own spec forbids `WriteQueue` itself
from holding away-mode policy. So the guard cannot be added *inside* `writeQueue.ts`'s dispatch
path — it must be a caller-side wrapper built on `runExclusive` and `submitSide`, exactly as that
spec anticipated.

## Goals / Non-Goals

**Goals:**

- Resolve the `'mirror'|'block'` (shipped) vs. `'block'|'mirror'|'allow'` (issue-era) value-set
  discrepancy in favor of one surface, with the migration cost stated explicitly.
- Name one guard surface every side-write originator calls through — today the thermostat, and
  by name (not by import) the concurrent `keep-alive` change.
- Make the common case (no away mode active, the overwhelming majority of writes) add zero extra
  latency and zero extra Pod requests.
- State plainly which race this closes (this plugin's own concurrent writes) and which it cannot
  (an away-mode change made entirely outside this plugin), rather than implying full closure.

**Non-Goals:**

- A `writeGuardStrict` config knob forcing a live settings re-read before every device-status
  write (issue #13 note 5). Addressed under "Staleness and the residual race" below — not
  implemented, and why.
- Any HomeKit-visible away-mode toggle. Out of scope per proposal.md.
- Any change to `WriteQueue` or `SnapshotStore`'s specs or public surface.

## Decisions

### Resolving the policy-value discrepancy: ratify `'mirror' | 'block'`, default `'mirror'`, drop `'allow'`

Issue #13 (and the #12-era planning it cites) specifies three values with `'block'` as the
default. `src/config.ts` and `config.schema.json` already ship two values with `'mirror'` as the
default. This proposal ratifies the shipped shape. Reasoning:

1. **`'allow'` is strictly dominated by `'mirror'`.** `'allow'` was meant to mean "raw upstream
   behaviour, no guard" — submit only the addressed side's write and say nothing about the
   other side. But the Pod's `controlBothSides` coupling fires regardless of what this plugin
   does or doesn't track; an `'allow'` write still physically changes both sides. The only
   difference `'allow'` vs. `'mirror'` could make is whether HomeKit's cached view is told the
   truth about the side it didn't address. There is no scenario where a user benefits from
   HomeKit *not* knowing the truth. `'allow'` is therefore not a materially different runtime
   behavior from `'mirror'` — it is `'mirror'` minus the one thing that makes `'mirror'` useful.
   Keeping it would mean shipping a config value whose only observable effect is "the plugin lies
   to HomeKit about your other side's temperature," with no compensating benefit (not even lower
   latency or fewer requests — see the pipeline below, mirroring adds no extra network round trip
   to the *decision*, only conditionally one extra `POST` to reflect reality).
2. **Default `'mirror'`, not `'block'`, is the safer default for an already-opt-in, rarely-used
   feature.** Away mode itself is off by default and rarely toggled. A user who has it on for one
   side almost certainly still expects HomeKit writes to the other side to work — refusing them
   by default (`'block'`) converts a pre-existing, silent hardware quirk into a newly *visible*
   HomeKit failure ("This accessory is not responding" / a rejected write) for behavior that
   predates this plugin and that the user did not necessarily choose to guard against. `'mirror'`
   changes nothing about whether the write succeeds — only whether HomeKit's cache is honest
   about it — so it introduces no new failure mode for the default-configured user. `'block'`
   remains available, opt-in, for anyone who wants the stricter guarantee.
3. **Migration cost is zero, and this is verifiable, not assumed.** Per this repo's own module
   doc in `src/config.ts`: every reserved key is "genuinely validated... so a typo'd future
   config value fails loudly today rather than silently once one of the changes above starts
   reading it" — and `awayModeWritePolicy`'s row in that table names `#13` (this change) as the
   first and only owner. Nothing in the shipped codebase branches on this key's value before this
   change (confirmed: the only occurrences of `awayModeWritePolicy` outside config/schema/docs/
   tests are the config plumbing itself — `src/platform.ts` does not read it, no service reads
   it). A key nothing reads yet can have its enum's shape corrected for free; there is no
   deployed config to migrate and no behavior to preserve across the change.

**This is flagged for tech-lead review** because it overturns a specific, named prior decision
(issue #13's own text) rather than merely filling in an unspecified detail — see the final
message.

### The guard sits between write originators and `WriteQueue.submitSide`, built on `runExclusive`

One module-level entry point takes `(side, patch)`, decides using the cached snapshot, and either
forwards to `WriteQueue.submitSide` unchanged, forwards it plus a mirrored call for the other
side, or rejects before either happens. It is not part of `writeQueue.ts` (spec-forbidden, see
Context) and not part of `snapshot.ts` (that module has no policy concept at all). It lives
alongside them in `src/pod/` — same module-dependency rules (imports `writeQueue.ts` and
`snapshot.ts`; nothing imports it back into either), same injected `TimerApi`/`Logger` seam, no
HAP dependency, so it can be unit-tested exactly like `WriteQueue` and `PodPoller` are today —
under fake timers, with a hand-built fake `WriteQueue`/`SnapshotStore`, and separately against
`test/mockPod.ts` for the physical-effect-level scenarios.

**Why `runExclusive` around the decision, not around the whole write:** the decision itself
(read `snapshot.get()`, compare two booleans, pick a branch) is synchronous and needs no
`await` — so wrapping it in `runExclusive` costs nothing beyond a microtask, and it's *not*
holding the queue's mutex for the debounce window or the dispatch. Concretely:

```
runExclusive(() => {
  const { left, right } = snapshot.get();
  const eitherAway = left.awayMode === true || right.awayMode === true;
  if (!eitherAway) return { decision: 'plain' };
  return { decision: policy, ... };
})
// then, OUTSIDE the exclusive callback, act on the decision:
//   'plain'  -> writeQueue.submitSide(side, patch)              (return this promise to caller)
//   'block'  -> throw AwayModeBlockedError                       (before calling submitSide at all)
//   'mirror' -> writeQueue.submitSide(side, patch)                AND
//               writeQueue.submitSide(otherSide, mirrorPatch)     (return the *addressed* side's promise)
```

Awaiting the addressed side's own `submitSide` call *inside* the exclusive callback would hold
the global write mutex for that write's entire debounce-plus-dispatch lifetime (400 ms – 2 s),
blocking every unrelated write for that whole window — a much worse regression than the race it
would close. Keeping the exclusive section to "read the cached state and decide" is what makes
this safe to add without changing the write queue's own latency characteristics for the common
(no-away-mode) case, which never enters the exclusive branch that matters here beyond the check
itself. (Every `submitSide` call, guarded or not, already goes through the mutex on its own
dispatch — this design does not change that.)

**What the exclusive section actually buys**, precisely: it guarantees the read of `left.awayMode
|| right.awayMode` cannot land in between another dispatch's mutex-acquire and mutex-release —
i.e., between this plugin submitting an away-mode-toggling settings write and that write's
overlay already being visible (which, per Context, happens at submission, before the exclusive
section could even run, since `submitSettings` is synchronous at the call site). In practice, for
writes this plugin itself originates, the ordering guarantee comes from a combination of (a) the
overlay-at-submission behavior making the check see pending toggles it hasn't dispatched yet, and
(b) the exclusive section ensuring the check-then-act sequence for one guarded write is not
interleaved with another guarded write's check-then-act sequence for the same side pair. It does
not, and cannot, protect against a toggle that reaches the Pod through any other path.

### Mirroring reuses `submitSide`, not a second overlay writer

Alternative considered: on `'mirror'`, call `snapshot.setOverlay(otherSide, field, value, ttl)`
directly for each overlayable field in the patch, skipping a second network request entirely.
Rejected in favor of issuing a second, real `submitSide(otherSide, patch)` call, for three
reasons:

1. **Preserves the "one overlay writer" invariant `snapshot.ts`'s own module doc states as a
   design fact**, not merely convention — introducing a second writer would require auditing and
   rewriting that doc's reasoning about ownership, and would need its own new tests for
   interactions the existing `WriteQueue` overlay tests don't cover (an overlay installed by
   something that never dispatches anything, never rebases on a settle, never clears on a
   dispatch failure — because there is no dispatch to fail).
2. **Every guarantee the `pod-write-queue` spec already makes** — overlay expiry, rebasing on
   settle, immediate clearing on failure, the fast-poll acceleration after a successful
   dispatch — applies to the mirrored side for free, because it went through the same
   `submitSide` path the addressed side did. A direct-overlay approach would need to reimplement
   or special-case all of that for exactly one code path.
3. **The extra Pod traffic is real but proportionate.** `POST /api/deviceStatus` is a device
   command, not a LowDB write — `docs/POD-API.md`: "`settings` writes are cheap... it does not
   trigger the job rebuild. Only `/api/settings` and `/api/schedules` do" (that line is about the
   nested `settings` object in a device-status body, but the same routing applies: no LowDB
   touch, no job-rebuild). The Pod's own `controlBothSides` branch inside `updateSide` would apply
   the addressed-side write to both sides *again* regardless of whether this second POST exists —
   so the extra POST is a redundant-but-idempotent hardware command, not a redundant *effect*.
   Given away mode is opt-in and rare, doubling command count only in that state is an acceptable
   trade for reusing tested machinery wholesale.

This is flagged as a decision the tech lead may want to revisit if the extra Pod traffic under
away mode turns out to matter in practice (see Risks).

### Staleness and the residual race: no forced pre-write settings refresh

Issue #13 note 5 proposes a `writeGuardStrict` config flag: re-read `/api/settings` immediately
before every device-status write, at the cost of doubling round-trips. This design does **not**
add it, for this change. Reasoning:

- **The gap it would close is narrow.** Any away-mode toggle *this plugin* originates is already
  visible to the guard's check the instant it's submitted (overlay-at-submission, see Context) —
  a forced refresh buys nothing for that case. The only gap `writeGuardStrict` narrows is an
  away-mode toggle made through a path this plugin doesn't control (free-sleep's own web UI,
  directly hitting `POST /api/settings`) — which the settings poller (default 300 s,
  `slowPollIntervalMs`) will surface within, worst case, one poll period regardless.
- **The cost is paid by every write, not just the rare away-mode one.** `GET /api/settings` is a
  cheap LowDB read (`docs/POD-API.md`), but "cheap" is relative to the *hardware socket queue*
  every request — including this one — is serialized through
  (`server/src/8sleep/sequentialQueue.ts` per `poller-and-write-queue/design.md`'s Context,
  itself sharing that queue with the Pod's own 2 s/60 s self-poll). A forced refresh before
  *every* thermostat write — the overwhelming majority of which occur with away mode off for
  either side — adds one full request-response round trip of latency to every slider drag and
  every mode toggle, for a condition that is true a small fraction of the time. That is a
  real, continuous cost paid to narrow an already-narrow, already-bounded, already-documented
  residual gap.
- **The bound that already exists is stated, not hidden.** The `away-mode-guard` spec's
  "Away-mode knowledge can be stale... this is bounded, not eliminated" requirement makes this an
  explicit, tested property (bounded by the settings poll interval) rather than an undocumented
  gap.

This is a genuine judgment call between latency-for-everyone and race-window-for-a-rare-case,
and is called out for tech-lead review rather than assumed — see the final message. If the
tech lead wants `writeGuardStrict`, it composes cleanly with this design later: it would become
an optional `await poller.refresh('settings')` inside the guard's exclusive section, before the
synchronous check, at the cost this section describes.

### What `'block'` throws, and why it differs from the existing write-failure error

`docs/HOMEKIT.md`, "No Response — the naive approach does not work," already establishes the
project's convention: `onGet` never throws while a snapshot exists; `onSet` does throw, and today
throws `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` uniformly for any write failure
(`src/services/thermostat.ts`'s existing `catch` blocks). This change introduces a second,
distinct thrown status for exactly one new cause: `HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE`,
reserved for a `block`-policy refusal specifically.

Why distinguish it: `SERVICE_COMMUNICATION_FAILURE` means "the Pod didn't answer" or "the Pod
rejected the request" — a transient, infrastructure-shaped failure a user would reasonably retry
later expecting it to work. A `block` refusal is neither: the Pod was never contacted, and
retrying will fail identically until away mode is turned off on the relevant side. Collapsing the
two into one status would make an intentional, policy-driven refusal indistinguishable from an
outage in the Home app's UI and in any log-based triage. `NOT_ALLOWED_IN_CURRENT_STATE` is a
real, distinct value in HAP-NodeJS's `HAPStatus` enum, used elsewhere in HAP-NodeJS for
state-dependent refusals — the closest existing standard status to "this write is currently
disallowed by policy, not by a transport failure."

**HAP behavior this cannot fully confirm without a real paired device** (`docs/HOMEKIT.md`'s own
disclosure convention, and this design's honoring of the design-artifact rule to call these out):
exactly how the Home app's UI surfaces `NOT_ALLOWED_IN_CURRENT_STATE` to a user (a toast, a
silent revert, or something else) versus `SERVICE_COMMUNICATION_FAILURE` is not verifiable from
unit tests against `test/fakeHomebridgeApi.ts` — HAP-NodeJS accepts and threads the status code
through; only a paired Home app shows what a person actually sees.

**The tile-revert mechanism**: `HOMEKIT.md`'s anti-jitter note establishes that HAP-NodeJS's
`handleSetRequest` can assign the client-supplied raw value to `characteristic.value` as part of
handling the write, independent of whether the registered `onSet` handler subsequently throws —
this is the same mechanism the alarm-dismiss `Switch`'s "accept then quietly revert after ~500 ms"
pattern already works around (`docs/HOMEKIT.md`, "Alarm ringing"). For a `block` refusal, the
guard's caller (`ThermostatService`) schedules, via the shared injected `TimerApi` (the same one
`ServiceContext` already threads through for exactly this kind of determinism — see
`src/services/types.ts`'s module doc), a call to the existing, idempotent `refresh()` method
roughly 500 ms after the throw — reusing the same push path every observed change already uses,
rather than inventing a second way to update a characteristic.

### Naming the shared surface for `keep-alive` to adopt

The concurrent `keep-alive` change (#12) periodically re-posts `secondsRemaining` to keep a side
that HomeKit believes is on from silently expiring at the Pod's 12-hour timer
(`docs/POD-API.md`, "`isOn: true` is implemented server-side as a 12-hour duration"). That is a
side write like any other, and the Pod's `controlBothSides` coupling does not distinguish a
keep-alive refresh from a user-initiated write — if either side is away, a keep-alive refresh
addressed to one side will also touch the other side's hardware, exactly as a thermostat write
would.

This design names the surface `keep-alive` is expected to call instead of
`WriteQueue.submitSide` directly, without either change importing the other's artifacts:

> **`AwayModeGuard.guardSideWrite(side: Side, patch: SidePatch): Promise<void>`**, exported from
> `src/pod/awayModeGuard.ts`. Same side/patch shape `WriteQueue.submitSide` already accepts;
> same settlement contract (resolves when the underlying dispatch settles, rejects with the
> dispatch's failure — or, new here, with `AwayModeBlockedError` if refused before dispatch).

Any write originator holding a reference to the platform's one shared `AwayModeGuard` instance
(threaded through `ServiceContext`, alongside the existing shared `snapshot`/`writeQueue`) calls
this instead of reaching into `writeQueue` directly. `keep-alive`'s own design is free to decide
*whether* a keep-alive refresh should be silently dropped, silently mirrored, or logged
differently on a `block` outcome — that is a decision for that change to make, using the same
`AwayModeBlockedError` this change defines as the signal it decides on.

## Risks / Trade-offs

- **[Extra Pod traffic under `'mirror'`]** → Doubling device-status commands while away mode is
  active is proportionate given away mode's rarity (see "Mirroring reuses `submitSide`" above),
  but if a future change makes away mode common (e.g., an automation that toggles it daily), this
  trade-off should be revisited. Mitigation: the direct-overlay alternative remains available as
  a follow-up if this becomes a real cost.
- **[Residual race with an out-of-band settings change]** → Explicitly bounded by the settings
  poll interval (default 300 s), not eliminated. Mitigation: documented in the spec and in
  `README.md`'s reserved-keys table update (tasks.md); `writeGuardStrict` remains a clean future
  addition if the tech lead decides the trade-off should move the other way.
- **[Two named write paths for "the same" concept]** → `WriteQueue.submitSide` (ungated) and
  `AwayModeGuard.guardSideWrite` (gated) both exist; a future contributor could accidentally call
  the former from a new feature and silently bypass the guard. Mitigation: `ServiceContext`
  exposes only the guard, not `writeQueue.submitSide`, to any new per-side write call site added
  by this change (the existing thermostat call sites are the only ones rewired); `writeQueue`
  itself stays available on `ServiceContext` because other, non-side-addressed use (e.g.
  `submitDeviceSettings`, `submitSettings`) has no away-mode-guard concept to bypass.
- **[Policy-value discrepancy resolution is a reversal of documented prior guidance]** → Flagged
  explicitly for tech-lead sign-off rather than silently decided; see final message.

## Migration Plan

None required for deployed configs — `awayModeWritePolicy` has never been read before this
change (see "migration cost is zero" above). Rollout is a normal code change: merge, release: a
config already setting `awayModeWritePolicy: 'block'` or relying on the default `'mirror'`
starts being honored the moment this change ships, with no config file edit needed. No rollback
concern beyond reverting the change itself, since no persisted state (settings/schedules DB) is
written by the guard.

## Open Questions

- Whether `keep-alive` (#12), once designed, decides to skip a keep-alive refresh entirely for an
  away side (since `powerScheduler.ts`/`temperatureScheduler.ts`/`alarmScheduler.ts` already
  return early for an away side upstream — a keep-alive may not even be necessary there) is that
  change's decision, not this one's; naming the shared surface here is sufficient for this change
  to unblock on it.

## Resolutions (tech lead, 2026-09-06)

1. **The shipped 'mirror' | 'block' shape with default 'mirror' is ratified**, overturning
   issue #13's 'block'-default text. 'allow' is strictly dominated by 'mirror'; 'mirror'
   reproduces the Pod's native both-sides semantics while telling HomeKit the truth, so the
   default introduces no new failure mode; 'block' stays one config flip away for households
   that want refusal. Will be recorded on issue #13.
2. **Enforcement point moves INSIDE the WriteQueue dispatch path.** The AwayModeGuard module
   keeps the policy logic, but the queue consults it for every side write at flush/dispatch
   regardless of origin (thermostat, keep-alive, future callers) — a front-door wrapper that
   callers must remember to use is exactly the bypass risk keep-alive's resolution 4 forbids.
   The runExclusive read-decide-write mechanics stand; they just run under the queue's roof.
   Blocked writes reject the submission promise with AwayModeBlockedError; ThermostatService
   maps it to HapStatusError(NOT_ALLOWED_IN_CURRENT_STATE) + the ~500ms corrective refresh,
   as designed.
3. **'mirror''s extra POST is accepted** (cheap, idempotent, preserves the one-overlay-writer
   invariant). **No writeGuardStrict** — the 300s out-of-band staleness window is accepted and
   documented, not hidden.
