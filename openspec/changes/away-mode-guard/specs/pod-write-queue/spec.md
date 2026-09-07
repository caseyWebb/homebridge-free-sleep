## Context (delta rationale, not part of the synced spec)

Neither `proposal.md` nor `design.md`'s body originally planned to touch `pod-write-queue`'s
spec — the original design put the away-mode guard entirely in front of `WriteQueue`, as a
caller-side wrapper built on `runExclusive`/`submitSide`, leaving the queue itself exactly as
`pod-write-queue` already specified ("the queue holds no policy about away mode"). The
tech-lead's resolution 2 (see this change's `design.md`, final "Resolutions" section) moved
enforcement *inside* `WriteQueue`'s own dispatch path instead, so that every side-lane dispatch
is guarded regardless of which feature originated it — a front-door wrapper is exactly the
bypass risk resolution 2 calls out. That is a real, narrowing change to a requirement
`pod-write-queue` already ships, so it needs its own delta here rather than being silently
absorbed into `away-mode-guard`'s own spec. `keep-alive`'s and `schedules`' carve-outs are
unaffected — only the away-mode clause of this one requirement changes.

## MODIFIED Requirements

### Requirement: The queue applies the away-mode write policy to every side write; it still originates no write of its own and never reads schedules

The queue SHALL dispatch the intent it is given, for every lane other than a side write. It
SHALL NOT originate a write of its own on behalf of a caller, and SHALL NOT read the schedules
endpoint. Those two guarantees are unchanged from before this requirement's modification.

For a side write specifically, the queue SHALL consult the configured away-mode write policy at
dispatch — after debounce, immediately before issuing the request — for every side write
regardless of which feature submitted it (thermostat, keep-alive, or any future caller), so that
no caller can bypass the policy by virtue of how it reached `submitSide`. When neither side is
in away mode, this changes nothing observable: the write is dispatched exactly as submitted, at
the cost of one synchronous, in-memory decision with no additional request. When either side is
in away mode, the queue SHALL apply the configured policy (`'block'` or `'mirror'`, specified in
full by the `away-mode-guard` capability) instead of dispatching unconditionally.

The decision and the action it produces SHALL be made from within the same dispatch step the
queue already runs every write through under its own mutex, so the decision cannot be
interleaved with another in-flight dispatch this plugin issues.

#### Scenario: Neither side away, the queue is an unmodified pass-through

- **WHEN** a side write is submitted and neither side's cached settings report away mode enabled
- **THEN** the write is dispatched exactly as submitted, and no extra request is made

#### Scenario: An away-mode write is now governed by policy, not dispatched unconditionally

- **WHEN** a side is in away mode and a write addressed to either side is submitted
- **THEN** the configured away-mode write policy governs whether and how the write reaches the
  Pod, rather than the write being dispatched exactly as submitted regardless of away mode

#### Scenario: The queue still originates no write of its own outside the away-mode policy, and still never reads schedules

- **WHEN** any sequence of writes is submitted
- **THEN** the only requests the queue issues are the dispatch of a submitted write, or — under
  the `'mirror'` policy specifically — the one additional mirrored write that policy's own
  requirement describes; the queue never reads the schedules endpoint and never originates a
  write outside those two cases

#### Scenario: An idle queue is silent

- **WHEN** no write is submitted for an hour
- **THEN** the queue issues no request of any kind
