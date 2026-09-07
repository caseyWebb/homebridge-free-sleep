## Purpose

Exposes each side's `awayMode` setting as a HomeKit `Switch`, so a household can pause a
side's schedules and alarms from the Home app instead of free-sleep's own web UI, while
keeping the expensive settings write this requires rare and correctly sequenced against
concurrent side writes.

## ADDED Requirements

### Requirement: The switch reflects the cached `awayMode` value without fetching

Reading the switch's state SHALL return the effective (raw-or-overlaid) cached value of
`settings.{side}.awayMode` from the shared snapshot. Reading the switch's state SHALL NEVER
itself issue a request to the Pod, and SHALL NOT throw while a snapshot exists — matching the
project's existing "`onGet` never fetches, never throws while a snapshot exists" convention.

#### Scenario: Reading the switch reflects the last-known value

- **WHEN** the Home app reads the Away Mode switch's state for a side
- **THEN** it receives the cached `awayMode` value for that side with no request issued to the
  Pod

#### Scenario: An optimistic write is visible before the Pod confirms it

- **WHEN** a write to `settings.{side}.awayMode` has been submitted but not yet confirmed by
  an observation
- **THEN** reading the switch's state returns the newly-submitted value, not the last
  Pod-confirmed one

### Requirement: Toggling the switch writes `settings.{side}.awayMode`

Setting the switch SHALL result in a `POST /api/settings` patch of the form
`{[side]: {awayMode: <value>}}`. This write SHALL be debounced locally by at least 2 seconds
and rate-limited to at most one settings write per side per 10-second window, so that rapid
or repeated toggling does not produce more than one job-rebuilding write per window.

#### Scenario: A single toggle produces exactly one settings write

- **WHEN** a user flips the Away Mode switch for one side once
- **THEN** exactly one `POST /api/settings` request is eventually made, carrying that side's
  new `awayMode` value

#### Scenario: Rapid repeated toggles are coalesced

- **WHEN** a user flips the Away Mode switch for the same side three times within 10 seconds
- **THEN** at most one settings write for that side is sent within that window, carrying the
  most recent value

### Requirement: Enabling away mode can optionally turn the side off first

When the `awayModeTurnsSideOff` option is enabled, turning a side's Away Mode switch on SHALL
first ensure that side is off, and only then enable `awayMode` for that side, as two
sequenced writes — the power-off SHALL be confirmed (or fail) before the `awayMode` write is
submitted. When `awayModeTurnsSideOff` is disabled (the default), enabling Away Mode SHALL
NOT itself change the side's power state.

S2 (settings-switches PR #46 review, tech-lead ruling): if the power-off pre-step fails
*specifically* because the away-mode write policy's `'block'` guard refuses it — which can only
happen because the *partner* side is already in away mode — that failure SHALL NOT abort the
toggle. The `awayMode: true` settings write SHALL still be submitted (the Pod applies a
settings write to both sides whenever either side is already away, so the intended effect is
not lost); the omitted power-off SHALL be logged. Any other power-off failure (a genuine
communication failure, not a guard refusal) SHALL still abort the toggle without submitting the
`awayMode` write, as before.

Turning Away Mode off SHALL NEVER itself change the side's power state, regardless of
`awayModeTurnsSideOff`.

#### Scenario: Enabling away mode with the option on turns the side off first

- **WHEN** `awayModeTurnsSideOff` is enabled and a user turns a side's Away Mode switch on
  while that side is on
- **THEN** the side's power-off write is dispatched and confirmed before the `awayMode: true`
  settings write is submitted

#### Scenario: Enabling away mode with the option off does not touch power

- **WHEN** `awayModeTurnsSideOff` is disabled (the default) and a user turns a side's Away
  Mode switch on
- **THEN** only the `awayMode: true` settings write is made; no power-state write is issued

#### Scenario: A power-off pre-step blocked by the away-mode guard does not abort enabling away mode

- **WHEN** `awayModeTurnsSideOff` is enabled, a user turns a side's Away Mode switch on, and the
  power-off pre-step is refused because the away-mode write policy is `'block'` and the
  *partner* side is already away
- **THEN** the `awayMode: true` settings write is still submitted and the toggle completes
  successfully, rather than aborting

#### Scenario: A non-guard power-off pre-step failure still aborts enabling away mode

- **WHEN** `awayModeTurnsSideOff` is enabled, a user turns a side's Away Mode switch on, and the
  power-off pre-step fails for a reason other than the away-mode guard (e.g. a communication
  failure)
- **THEN** the toggle aborts and no `awayMode` settings write is submitted

#### Scenario: Disabling away mode never touches power

- **WHEN** a user turns a side's Away Mode switch off, regardless of the
  `awayModeTurnsSideOff` setting
- **THEN** only the `awayMode: false` settings write is made; no power-state write is issued

### Requirement: A concurrently-dispatching side write is never decided against a not-yet-settled away-mode overlay

While an `awayMode`-touching settings write submitted by this switch has not yet settled
(succeeded or failed), a side write already pending for either side SHALL NOT be dispatched
using an away-mode decision based on that settings write's optimistic, unconfirmed value. The
side write's away-mode decision SHALL be made only once that settings write has fully
settled, so that a subsequent settings-write failure can never be discovered only after an
side write already reached the Pod under the wrong decision.

#### Scenario: A pending side write waits out a concurrent away-mode-off write that fails

- **WHEN** a side write is already pending when the Away Mode switch submits an `awayMode:
  false` write for that side, and the settings write subsequently fails
- **THEN** the side write's away-mode decision reflects `awayMode` still being `true` — the
  same decision it would have made had the settings write never been submitted

#### Scenario: A pending side write proceeds correctly once a concurrent away-mode-off write succeeds

- **WHEN** a side write is already pending when the Away Mode switch submits an `awayMode:
  false` write for that side, and the settings write subsequently succeeds
- **THEN** the side write's away-mode decision reflects `awayMode` being `false`

### Requirement: A failed write surfaces as a communication failure, not silently

When the settings write a toggle produces fails, the characteristic write SHALL fail with a
distinct, user-visible HomeKit error rather than silently reporting success, and the switch's
displayed state SHALL be corrected back to the last-confirmed value shortly afterward.

#### Scenario: A failed away-mode write is surfaced to the user

- **WHEN** the `POST /api/settings` request a toggle produces fails
- **THEN** the characteristic write fails with a distinct error rather than appearing to
  succeed, and the switch's displayed state reverts to the last-confirmed value
