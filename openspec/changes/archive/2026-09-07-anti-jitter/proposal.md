## Why

Two open issues sit against `thermostat-service`'s temperature-shadow machinery, and both are
about the `TargetTemperature` characteristic never showing the user something it shouldn't:

- **#14** asks for proof that dragging the Home app's temperature slider through its *full*
  settable range never produces a visible snap-back, plus the `writeSettleMs` suppression
  window the original `thermostat-and-offline` design (archived) deliberately deferred.
- **#33** (found in #32's own review) is a real, if low-probability, correctness gap: the read
  schema for a side's status is intentionally lenient (`src/pod/types.ts` `SideStatusSchema`),
  so a Pod reporting a `targetTemperatureF` outside 55–110°F parses without error. HAP's
  `TargetTemperature` characteristic has `setProps({minValue, maxValue, minStep})` and clamps
  what it reports; the plugin's `publishedF.targetF` shadow does not, and would keep recording
  the raw, unclamped degree. A `!==` shadow comparison against a value the characteristic can
  never actually reach again permanently suppresses every future correction.

This change resolves both. For #14, the investigation below concludes the fix is proof, not new
machinery: `WriteQueue`'s optimistic overlay (installed synchronously at write submission, held
for `writeSettleMs`, and re-based on every dispatch success) already suppresses every
disagreeing observation for its whole lifetime, which is strictly stronger than a
time-boxed suppression window keyed on a separate write timestamp — and `writeSettleMs` already
exists as exactly that window's name and duration (`src/config.ts`, `src/pod/writeQueue.ts`).
What's missing is a test that actually drags through the whole range, including across the
write queue's own internal batch boundaries, while a stale observation races it — not new
production code.

For #33, the fix is genuinely new (if small): clamp an observed `targetTemperatureF` to
`F_MIN..F_MAX` at the HomeKit service boundary, in `src/services/thermostat.ts`, before it is
compared against or written into the `publishedF` shadow. The read schema itself stays lenient,
per its own documented rationale.

## What Changes

- Add integration-level drag-simulation tests (`test/integration/session.test.ts`, extending the
  existing "slider-drag guardrail") that drive real `handleSetRequest` bursts across the whole
  settable range — including across the write queue's `writeMaxDebounceMs` boundary — while a
  background poll observes a stale, disagreeing value mid-drag, and assert the published
  characteristic never moves to a value earlier than where the drag currently is.
- Clamp `targetTemperatureF` to `[F_MIN, F_MAX]` in `src/services/thermostat.ts` at every point
  it is read from the cached snapshot for the purpose of comparing against or updating
  `publishedF.targetF` or reporting `TargetTemperature`'s `onGet` — not in the read schema, and
  not for `currentTemperatureF` (which this service's spec already requires to stay unclamped).
- Add the regression test from #33: an observation reporting a `targetTemperatureF` outside
  55–110°F does not permanently desynchronize the shadow — a subsequent in-range observation
  still produces exactly one correcting push.
- Update `docs/HOMEKIT.md`'s "Anti-jitter" section to state the full-range-drag guarantee
  explicitly and to record the clamp-at-the-boundary rule, so the next reader does not
  rediscover either from the source.
- No new config keys, no new `accessory.context` fields, no change to `src/pod/types.ts`'s read
  schema.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `thermostat-service`: two requirements gain scenarios —
  - "A characteristic is updated only when its value changed in the Pod's own units" gains the
    clamp-before-compare rule and two scenarios covering #33 (an out-of-range target is clamped
    before it reaches the shadow; an out-of-range reading does not permanently desynchronize the
    shadow against later in-range readings).
  - "Mode and setpoint writes become one minimal Pod patch each" gains a scenario covering #14
    (a full-range drag, racing a stale mid-drag observation, never snaps the published value
    backward).

## Impact

- **Code**: `src/services/thermostat.ts` (clamp `targetTemperatureF` at three read sites: the
  `TargetTemperature` `onGet`, and the `targetF` branch of `pushTemperature`/`refresh`).
  `src/pod/types.ts` is **not** touched — the read schema's leniency is deliberate and out of
  scope (proposal's Non-goals).
- **Tests**: `test/integration/session.test.ts` (new full-range-drag-under-race scenario),
  `test/services/thermostat.test.ts` (unit-level clamp regression test for #33).
- **Docs**: `docs/HOMEKIT.md`'s "Anti-jitter" section.
- **Pod API touched**: none. This is a pure client-side read-path and test change; no new
  `GET`/`POST` to the Pod, no change to write shape or frequency, no settings write (and
  therefore no job-rebuild cost).
- **Issues resolved**: #14, #33. `lastNonZeroBrightness` persistence (mentioned in #14's own
  comment) is explicitly not part of this change — see Non-goals.

## Non-goals

- `lastNonZeroBrightness` persistence. This belongs to the `Pod` hub's LED service (#20,
  M4 — "Everything else"), which does not exist yet; there is nothing in this change's scope to
  attach that persistence to. Noted directly on #20 instead of invented here.
- Any change to `src/pod/types.ts`'s `SideStatusSchema` leniency. #33's own text is explicit
  that the read schema should stay lenient; the fix is a service-boundary clamp, not a
  validation tightening.
- A new, separate `writeSettleMs`-keyed suppression timer independent of the write queue's
  overlay. The investigation below concludes the existing overlay already provides a strictly
  stronger guarantee; adding a second, parallel mechanism would be machinery with no behavior it
  uniquely covers.
- Real-hardware confirmation. This change proves the full-range-drag guarantee with a
  deterministic virtual-clock integration test against the mock Pod, per this repo's
  `docs/adr/0001-synthetic-fixtures-until-hardware.md`. Real-hardware confirmation remains
  tracked on #14's `needs-hardware` label until a Pod is available.
