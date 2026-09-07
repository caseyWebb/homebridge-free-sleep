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

### Requirement: The queue holds no policy about away mode, keep-alive, or schedules

The queue SHALL dispatch the intent it is given. It SHALL NOT suppress, mirror, rewrite, or
refuse a write on the basis of away mode; SHALL NOT originate a write of its own; and SHALL
NOT read the schedules endpoint. Those behaviours belong to later, separately specified
guards, which are expected to be built on the exclusive-section mechanism.

A side patch whose only field is `isAlarmVibrating` is exempt from any away-mode policy any
such guard applies to every other side patch: it SHALL be dispatched to the addressed side
exactly as submitted, and SHALL NOT be mirrored to the other side, regardless of which side is
currently in away mode or which away-mode policy is configured. This mirrors free-sleep's own
`updateSide`, which never consults `controlBothSides`/`updateLeft`/`updateRight` for this field
at all (`server/src/routes/deviceStatus/updateDeviceStatus.ts`) — the exemption is parity with
upstream's own unconditional behavior, not a plugin-specific carve-out. A side patch carrying
`isAlarmVibrating` alongside any other field is unaffected by this exemption and remains subject
to whatever away-mode policy otherwise applies to it.

#### Scenario: An away-mode write is dispatched, not guarded

- **WHEN** a side is in away mode and a write addressed to that side is submitted
- **THEN** the write is dispatched as submitted, and the Pod's own both-sides coupling applies

#### Scenario: An alarm-only patch bypasses any away-mode policy, under 'block'

- **WHEN** a side patch whose only field is `isAlarmVibrating` is submitted while either side is
  in away mode and the configured away-mode policy is `'block'`
- **THEN** the write is dispatched to the addressed side exactly as submitted, not refused

#### Scenario: An alarm-only patch is never mirrored, under 'mirror'

- **WHEN** a side patch whose only field is `isAlarmVibrating` is submitted while either side is
  in away mode and the configured away-mode policy is `'mirror'`
- **THEN** the write is dispatched to the addressed side only, and no second write is issued to
  the other side

#### Scenario: A mixed patch containing isAlarmVibrating keeps whatever away-mode policy otherwise applies

- **WHEN** a side patch contains `isAlarmVibrating` alongside at least one other field, and either
  side is in away mode
- **THEN** the patch is subject to the configured away-mode policy exactly as it would be without
  `isAlarmVibrating` present

#### Scenario: An idle queue is silent

- **WHEN** no write is submitted for an hour
- **THEN** the queue issues no request of any kind
