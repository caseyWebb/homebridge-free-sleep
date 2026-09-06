## Purpose

Turns user intent into the smallest, safest possible amount of Pod traffic: a burst of
HomeKit writes becomes one coalesced hardware request, every write is serialised against
every other, and the result is reflected in the cached snapshot immediately rather than up to
a poll period later.

## ADDED Requirements

### Requirement: Writes are debounced per lane and merged field by field

A submitted write SHALL NOT be dispatched immediately. It SHALL be held for approximately
400 milliseconds, during which further writes to the same lane merge into it: a field present
in a later write SHALL replace the same field from an earlier one, and fields only present in
the earlier write SHALL be retained. The debounce delay SHALL be configurable.

The lanes SHALL be independent of one another: the left side, the right side, the device-wide
settings carried on the status endpoint, and the persisted settings endpoint. A write to one
lane SHALL NOT delay or merge with a write to another.

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

### Requirement: The queue holds no policy about away mode, keep-alive, or schedules

The queue SHALL dispatch the intent it is given. It SHALL NOT suppress, mirror, rewrite, or
refuse a write on the basis of away mode; SHALL NOT originate a write of its own; and SHALL
NOT read the schedules endpoint. Those behaviours belong to later, separately specified
guards, which are expected to be built on the exclusive-section mechanism.

#### Scenario: An away-mode write is dispatched, not guarded

- **WHEN** a side is in away mode and a write addressed to that side is submitted
- **THEN** the write is dispatched as submitted, and the Pod's own both-sides coupling applies

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
