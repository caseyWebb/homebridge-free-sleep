## Context (delta rationale, not part of the synced spec)

The main spec (`openspec/specs/pod-write-queue/spec.md`) still carries this requirement's
original text ("The queue holds no policy about away mode, keep-alive, or schedules"), even
though the merged, shipped `away-mode-guard` change already narrowed it in code (enforcement
moved inside `dispatch()`, per that change's own unsynced delta,
`openspec/changes/away-mode-guard/specs/pod-write-queue/spec.md`) — `away-mode-guard` has not
yet been archived, so the main spec has not been synced to match shipped behavior. This delta
is written against the same base text the MODIFIED workflow points at (the main spec's current
file), but its body reflects the actual current (shipped) behavior it builds on, plus this
change's own addition, in one coherent requirement — rather than silently perpetuating a
main-spec/code mismatch this change did not create. Whoever archives `away-mode-guard` and this
change should reconcile both deltas into one final requirement text; see also this change's
design.md.

This change is the first thing in the codebase to ever call `submitSettings` with a patch
touching `awayMode` (the Away Mode switch). That exposes a real ordering hazard between the
settings lane's overlay-at-submission behavior and a concurrently-pending side write's
away-mode decision — see design.md, "The ordering hazard," for the full mechanism. The added
paragraph and scenarios below close it.

## MODIFIED Requirements

### Requirement: The queue applies the away-mode write policy to every side write, sequenced against any pending away-mode-touching settings write; it still originates no write of its own outside the mirror exception and never reads schedules

The queue SHALL dispatch the intent it is given, for every lane other than a side write. It
SHALL NOT originate a write of its own on behalf of a caller, and SHALL NOT read the schedules
endpoint. Those two guarantees have one narrow exception: under the `'mirror'` policy, the
queue itself SHALL originate exactly one additional side write — the mirrored write to the
other side, carrying the same overlayable fields as the addressed write — for every side write
it dispatches while either side is in away mode.

For a side write specifically, the queue SHALL consult the configured away-mode write policy at
dispatch — after debounce, immediately before issuing the request — for every side write
regardless of which feature submitted it, so that no caller can bypass the policy by virtue of
how it reached the side-write submission surface. When neither side is in away mode, this
changes nothing observable: the write is dispatched exactly as submitted, at the cost of one
synchronous, in-memory decision with no additional request. When either side is in away mode,
the queue SHALL apply the configured policy (`'block'` or `'mirror'`) instead of dispatching
unconditionally.

**Sequencing against a concurrent away-mode settings write (new in this change):** before
making this decision for a side write, the queue SHALL first ensure that any settings-lane
write already submitted, touching either side's `awayMode`, that has not yet settled
(succeeded or failed) is allowed to settle. The decision SHALL then be made against the
settled — not the merely optimistic, unconfirmed — state of that settings write. This
guarantees the decision for a side write can never be made against an `awayMode` value that a
concurrently in-flight settings write subsequently fails to actually produce on the Pod. The
mechanism used to achieve this SHALL NOT introduce a deadlock between the settings lane and a
side lane sharing the queue's single dispatch mutex.

The decision and the action it produces SHALL be made from within the same dispatch step the
queue already runs every write through under its own mutex, so the decision cannot be
interleaved with another in-flight dispatch this plugin issues.

#### Scenario: Neither side away, the queue is an unmodified pass-through

- **WHEN** a side write is submitted and neither side's cached settings report away mode
  enabled
- **THEN** the write is dispatched exactly as submitted, and no extra request is made

#### Scenario: An away-mode write is now governed by policy, not dispatched unconditionally

- **WHEN** a side is in away mode and a write addressed to either side is submitted
- **THEN** the configured away-mode write policy governs whether and how the write reaches the
  Pod, rather than the write being dispatched exactly as submitted regardless of away mode

#### Scenario: A pending side write's decision waits out a concurrent away-mode-off write that fails

- **WHEN** a side write is submitted while both sides' cached `awayMode` is `true`, and before
  that side write dispatches, a settings write setting one side's `awayMode` to `false` is
  submitted and its `POST /api/settings` subsequently fails
- **THEN** the side write's away-mode decision is made as though the settings write had never
  been submitted — the policy is applied against `awayMode` still being `true`, not against the
  settings write's optimistic, ultimately-incorrect `false`

#### Scenario: A pending side write's decision reflects a concurrent away-mode-off write that succeeds

- **WHEN** a side write is submitted while a side's cached `awayMode` is `true`, and before
  that side write dispatches, a settings write setting that side's `awayMode` to `false` is
  submitted and its `POST /api/settings` subsequently succeeds
- **THEN** the side write's away-mode decision is made against `awayMode` being `false`

#### Scenario: The queue still originates no write of its own outside the away-mode policy, and still never reads schedules

- **WHEN** any sequence of writes is submitted
- **THEN** the only requests the queue issues are the dispatch of a submitted write, or — under
  the `'mirror'` policy specifically — the one additional mirrored write that policy's own
  requirement describes; the queue never reads the schedules endpoint and never originates a
  write outside those two cases

#### Scenario: An idle queue is silent

- **WHEN** no write is submitted for an hour
- **THEN** the queue issues no request of any kind
