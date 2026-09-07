## Context

`openspec/specs/pod-write-queue/spec.md`'s current "The queue holds no policy about away mode,
keep-alive, or schedules" requirement predates the `away-mode-guard` change's own landed
behavior: `away-mode-guard` is merged into `main` (tech-lead resolution, this change's own
Resolutions section: "The guard (change `away-mode-guard`) is already merged"), and
`WriteQueue.dispatch()` now does consult a configured away-mode policy for every side-lane
dispatch (`src/pod/writeQueue.ts`) — but `away-mode-guard`'s own spec delta has not yet been
synced/archived into the main `pod-write-queue` spec, so the text below is written as a
**MODIFIED** requirement against the *current, still-unsynced* main spec text, per tasks.md
10.2's own instruction ("write it against the then-current main spec text, not this proposal's
guess at it"). Reconciling `pod-write-queue`'s main spec text with `away-mode-guard`'s actual
landed behavior in full is that change's own sync/archive step, not this one's — this delta adds
only the one additional carve-out this change itself requires.

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
regardless of which feature submitted it (thermostat, keep-alive, or any future caller), so that
no caller can bypass the policy by virtue of how it reached `submitSide`. When neither side is
in away mode, this changes nothing observable: the write is dispatched exactly as submitted, at
the cost of one synchronous, in-memory decision with no additional request. When either side is
in away mode, the queue SHALL apply the configured policy (`'block'` or `'mirror'`, specified in
full by the `away-mode-guard` capability) instead of dispatching unconditionally.

**Sequencing against a concurrent away-mode settings write:** before making this decision for a
side write, the queue SHALL first ensure that any settings-lane write already submitted, touching
either side's `awayMode`, that has not yet settled (succeeded or failed) is allowed to settle.
The decision SHALL then be made against the settled — not the merely optimistic, unconfirmed —
state of that settings write. This guarantees the decision for a side write can never be made
against an `awayMode` value that a concurrently in-flight settings write subsequently fails to
actually produce on the Pod. The mechanism used to achieve this SHALL NOT introduce a deadlock
between the settings lane and a side lane sharing the queue's single dispatch mutex.

**Alarm-only exemption:** a side patch whose only field is `isAlarmVibrating` is exempt from any
away-mode policy: it SHALL be dispatched to the addressed side exactly as submitted, and SHALL
NOT be mirrored to the other side, regardless of which side is currently in away mode or which
away-mode policy is configured. This mirrors free-sleep's own `updateSide`, which never consults
`controlBothSides`/`updateLeft`/`updateRight` for this field at all
(`server/src/routes/deviceStatus/updateDeviceStatus.ts`) — the exemption is parity with
upstream's own unconditional behavior, not a plugin-specific carve-out.

**N8 (alarm-events PR #45 review, tech-lead ruling) — a coalesced patch is split, not swept
wholesale under the remainder's own guard outcome:** a side patch carrying `isAlarmVibrating`
alongside one or more other fields SHALL have its `isAlarmVibrating` field dispatched to the
addressed side exactly as submitted — exempt from any away-mode policy, exactly as an
alarm-only patch is, and evaluated *before* the away-mode policy is ever consulted for the rest
of the patch. The remaining field(s) SHALL then be subject to whatever away-mode policy
otherwise applies to them, exactly as they would be had `isAlarmVibrating` never been part of
the same submission at all — coalescing with a dismiss SHALL NOT let a guarded field evade its
own policy, and SHALL NOT let the guarded field's own policy outcome (e.g. `'block'`) prevent
the alarm field's delivery either. `isAlarmVibrating` itself is never mirrored to the other
side under any circumstance (S6), coalesced or not.

#### Scenario: Neither side away, the queue is an unmodified pass-through

- **WHEN** a side write is submitted and neither side's cached settings report away mode enabled
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

#### Scenario: An alarm-only patch bypasses any away-mode policy, under 'block'

- **WHEN** a side patch whose only field is `isAlarmVibrating` is submitted while either side is
  in away mode and the configured away-mode policy is `'block'`
- **THEN** the write is dispatched to the addressed side exactly as submitted, not refused

#### Scenario: An alarm-only patch is never mirrored, under 'mirror'

- **WHEN** a side patch whose only field is `isAlarmVibrating` is submitted while either side is
  in away mode and the configured away-mode policy is `'mirror'`
- **THEN** the write is dispatched to the addressed side only, and no second write is issued to
  the other side

#### Scenario: A mixed patch's alarm field is dispatched addressed-only regardless of policy, and the remainder is guarded normally

- **WHEN** a side patch contains `isAlarmVibrating` alongside at least one other field, and either
  side is in away mode
- **THEN** the `isAlarmVibrating` field is dispatched to the addressed side exactly as submitted —
  never refused and never mirrored — and the remaining field(s) are separately subject to the
  configured away-mode policy exactly as they would be had `isAlarmVibrating` not been part of
  the same submission

#### Scenario: A mixed patch's alarm field still lands when the remainder is blocked

- **WHEN** a side patch contains `isAlarmVibrating` alongside at least one other field, either
  side is in away mode, and the configured away-mode policy is `'block'`
- **THEN** the `isAlarmVibrating` field is still dispatched to the addressed side, even though the
  remaining field(s) are refused

#### Scenario: isAlarmVibrating is never mirrored, mixed or not

- **WHEN** any side write that includes `isAlarmVibrating` is dispatched while the configured
  away-mode policy is `'mirror'` and either side is in away mode
- **THEN** no mirrored write to the other side ever carries `isAlarmVibrating`, whether or not it
  was coalesced with another field

#### Scenario: The queue still originates no write of its own outside the away-mode policy, and still never reads schedules

- **WHEN** any sequence of writes is submitted
- **THEN** the only requests the queue issues are the dispatch of a submitted write, or — under
  the `'mirror'` policy specifically — the one additional mirrored write that policy's own
  requirement describes; the queue never reads the schedules endpoint and never originates a
  write outside those two cases

#### Scenario: An idle queue is silent

- **WHEN** no write is submitted for an hour
- **THEN** the queue issues no request of any kind
