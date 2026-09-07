# pod-write-queue Specification

## Purpose

Turns user intent into the smallest, safest possible amount of Pod traffic: a burst of
HomeKit writes becomes one coalesced hardware request, every write is serialised against
every other, and the result is reflected in the cached snapshot immediately rather than up to
a poll period later.

## Requirements

### Requirement: Writes are debounced per lane and merged field by field

A submitted write SHALL NOT be dispatched immediately. It SHALL be held for a debounce
interval, during which further writes to the same lane merge into it: a field present in a
later write SHALL replace the same field from an earlier one, and fields only present in the
earlier write SHALL be retained. The debounce interval SHALL be configurable.

The lanes SHALL be independent of one another: the left side, the right side, the device-wide
lane (carrying both the device-settings fields and a priming-trigger field), and the
persisted-settings endpoint. A write to one lane SHALL NOT delay or merge with a write to
another.

The device-wide lane's debounce interval SHALL be independently configurable from the debounce
interval applied to every other lane, and SHALL default to a longer value than the other
lanes' shared default — so that a feature writing frequently on the device-wide lane can be
given a stricter debounce without changing the responsiveness of a side write.

#### Scenario: A rapid pair becomes one merged write

- **WHEN** a power-state write and a target-temperature write for the same side are submitted
  ten milliseconds apart
- **THEN** the Pod receives exactly one request, whose body carries both fields for that side

#### Scenario: The later value wins

- **WHEN** three target temperatures for the same side are submitted within the debounce window
- **THEN** the Pod receives one request carrying the last of the three

#### Scenario: Lanes do not merge

- **WHEN** a write to the left side and a write to the right side are submitted together
- **THEN** each is dispatched for its own side, and neither is delayed by the other's window

#### Scenario: A priming trigger and a device-settings write merge on the same lane

- **WHEN** a priming trigger and a device-settings write are submitted within the device-wide
  lane's debounce window of each other
- **THEN** the Pod receives one request carrying both the priming trigger and the
  device-settings fields

#### Scenario: The device-wide lane's debounce is independent of the side lanes' debounce

- **WHEN** the device-wide lane's debounce interval is configured to a value different from
  the side lanes' shared debounce interval
- **THEN** a device-wide-lane write is held for the device-wide lane's own configured
  interval, and a side write's debounce timing is unaffected

### Requirement: A continuing drag is bounded by a maximum wait

The debounce SHALL NOT be able to postpone a dispatch indefinitely. A lane SHALL be dispatched
no later than a configurable maximum wait, approximately 2 seconds, measured from the first
write in the current batch, however many further writes arrive. After that dispatch, a new
batch and a new maximum wait SHALL begin.

#### Scenario: A long slider drag still reaches the Pod

- **WHEN** a write is submitted to the same lane every 100 milliseconds for 10 seconds
- **THEN** dispatches occur at roughly the maximum wait interval rather than only after the
  drag ends, and each carries the most recent value at the time it was dispatched

### Requirement: A patch never carries both power and explicit duration for one side

Before dispatch, a merged patch that carries both a side's power field and that side's
explicit remaining-seconds field SHALL be reduced to exactly one of them. The field retained
SHALL be the one that reproduces the outcome the Pod itself would produce from the unreduced
patch, given that the Pod applies power first and remaining-seconds last, and silently ignores
a remaining-seconds value of zero:

- when the remaining-seconds value is non-zero, the remaining-seconds field SHALL be kept and
  the power field dropped;
- when the remaining-seconds value is zero, the power field SHALL be kept and the
  remaining-seconds field dropped.

The queue SHALL NEVER dispatch a patch that the client refuses as carrying both fields. The
reduction SHALL be logged at debug with both the submitted and the dispatched patch.

#### Scenario: A non-zero duration supersedes the power field

- **WHEN** a merged patch sets a side on and its remaining seconds to 600
- **THEN** the dispatched body carries only the remaining-seconds field, and the resulting Pod
  state is the same as the unreduced patch would have produced

#### Scenario: A zero duration is discarded in favour of the power field

- **WHEN** a merged patch sets a side off and its remaining seconds to 0
- **THEN** the dispatched body carries only the power field, the side ends up off, and the
  outcome matches what the unreduced patch would have produced

#### Scenario: The client's rejection is never triggered

- **WHEN** every combination of power and remaining-seconds values is submitted as a merged
  pair
- **THEN** no dispatch is refused by the client's pre-flight conflict check, and every
  dispatched body carries at most one of the two fields

#### Scenario: Each field alone is untouched

- **WHEN** a patch carries only the power field, or only the remaining-seconds field
- **THEN** it is dispatched unchanged

### Requirement: All writes are serialised through one mutex

At most one write SHALL be in flight at any moment, across every lane and across both the
status endpoint and the persisted-settings endpoint. Writes SHALL be dispatched in the order
their debounce windows closed. A failing write SHALL release the mutex and SHALL NOT block
those behind it.

The queue SHALL additionally expose a way to run an arbitrary read-modify-write sequence
inside that mutex, so that a later guard which must read settings, decide, and then write
cannot be interleaved with an unrelated write.

#### Scenario: A status write and a settings write never overlap

- **WHEN** a status-endpoint write and a settings-endpoint write become due at the same moment
- **THEN** the Pod observes them one after the other, never concurrently

#### Scenario: A failure does not stall the queue

- **WHEN** a dispatch fails and another lane's write is waiting
- **THEN** the waiting write is dispatched next

#### Scenario: An exclusive section excludes writes

- **WHEN** a caller runs a read-modify-write section and a write becomes due during it
- **THEN** that write is dispatched only after the section completes

### Requirement: A submitter learns whether its write reached the Pod

Submitting a write SHALL yield a result that settles when the dispatch that carried it
settles: successfully when the Pod accepted the request, and with the underlying failure when
it did not. Every submission merged into one dispatch SHALL settle together with the same
outcome.

This is what lets a HomeKit write handler surface a genuine failure to the user while a read
handler never does.

#### Scenario: Merged submissions share one outcome

- **WHEN** two writes merge into one dispatch and the Pod accepts it
- **THEN** both submissions settle successfully

#### Scenario: A rejected write is reported to its submitter

- **WHEN** the Pod rejects the dispatched body
- **THEN** every submission merged into it settles with a failure that identifies the cause

### Requirement: An optimistic overlay is applied on submission and reconciled on dispatch

On submission, the queue SHALL immediately install overlay entries on the snapshot for the
user-visible fields the write sets — target temperature, power state, alarm-vibrating state,
and away mode — so the cached view reflects the user's intent without waiting for a poll. The
remaining-seconds field SHALL NOT be overlaid, because its post-write value cannot be
predicted.

Each entry SHALL expire approximately 15 seconds after the dispatch that carried it settles,
that window being configurable; the expiry SHALL be re-based when the dispatch settles so that
time spent waiting in the debounce and the mutex does not consume it.

When a dispatch fails, the overlay entries it carried SHALL be removed at once rather than
being left to expire, so the user sees the true state immediately instead of a lie that
persists for the full window.

#### Scenario: The cached view updates before the Pod is contacted

- **WHEN** a target-temperature write is submitted
- **THEN** reading the snapshot returns the new temperature immediately, before any request has
  been issued

#### Scenario: The settle window starts when the write lands

- **WHEN** a write waits in the mutex for several seconds before being dispatched
- **THEN** its overlay entries remain effective for the full settle window measured from the
  dispatch settling, not from submission

#### Scenario: A failed write reverts at once

- **WHEN** a dispatch fails
- **THEN** the overlay entries it carried are removed immediately and the snapshot reports the
  last observed values again

#### Scenario: Remaining seconds is never overlaid

- **WHEN** a write sets only a side's remaining seconds
- **THEN** no overlay entry is installed and the snapshot's remaining-seconds value changes
  only when an observation reports it

### Requirement: A successful write speeds up the next reads

After a dispatch the Pod accepted, the queue SHALL cause the device-status class to be polled
at its fast interval for the configured fast window, so that the confirming observation
arrives well inside the overlay's settle window and retires the overlay by agreement rather
than by expiry.

A dispatch that failed SHALL NOT request the fast cadence; an unreachable Pod is the poller's
backoff to handle.

#### Scenario: The confirming read arrives inside the settle window

- **WHEN** a write succeeds and the Pod subsequently reports the written value
- **THEN** the observation arrives before the overlay's expiry and the overlay is retired by
  agreement, with no reversion notification emitted

#### Scenario: A failed write does not accelerate polling

- **WHEN** a dispatch fails because the Pod is unreachable
- **THEN** no fast-cadence request is made and the poller's backoff governs the next attempt

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

### Requirement: Stopping the queue abandons pending work explicitly

Stopping the queue SHALL cancel every pending debounce timer, settle every submission that has
not yet been dispatched with a failure identifying the shutdown, remove every overlay entry it
owns, and leave no timer scheduled. A dispatch already in flight SHALL be allowed to settle,
but SHALL cause no further scheduling or overlay change.

#### Scenario: Pending writes are not silently dropped

- **WHEN** the queue is stopped with writes still inside their debounce window
- **THEN** those submissions settle with a failure naming the shutdown, and the Pod receives
  nothing

#### Scenario: Shutdown leaves no timers

- **WHEN** a test stops the queue
- **THEN** no timer remains scheduled and the test process exits without an open-handle warning

### Requirement: The device-wide lane's settings sub-object is backfilled from a freshly-refreshed observation immediately before dispatch (S4, PR #44 review)

A caller submitting a device-settings field on the device-wide lane SHALL NOT need to supply
every field of the settings sub-object itself to avoid a partial write silently dropping the
fields it omits. Immediately before dispatching a device-wide-lane write that carries any
settings sub-object field, the queue SHALL first attempt a bounded refresh of the
device-status observation, then merge the currently-observed settings sub-object with the
fields this write cycle explicitly supplied — the explicitly-supplied fields SHALL take
precedence over the observed ones for the same field.

This narrows, but does not eliminate, a race in which a settings sub-object field is changed
by something other than this plugin between the observation this write merges against and the
write actually reaching the Pod.

#### Scenario: A caller supplying only the field it changes gets the other fields backfilled

- **WHEN** a device-wide-lane write supplies only one settings sub-object field
- **THEN** the dispatched request's settings sub-object carries that field's new value
  together with the other settings sub-object fields from the current observation, unaltered

#### Scenario: A freshly-observed value, not a value cached before dispatch, is used for the fields a write does not supply

- **WHEN** a settings sub-object field this write does not itself supply changes, due to the
  bounded pre-dispatch refresh, between this write's submission and its dispatch
- **THEN** the dispatched request carries the freshly-observed value for that field, not the
  value that was current at submission time

#### Scenario: A device-wide-lane write carrying no settings sub-object field never triggers the refresh

- **WHEN** a device-wide-lane write carries only the priming-trigger field
- **THEN** no pre-dispatch refresh attempt is made for that write
