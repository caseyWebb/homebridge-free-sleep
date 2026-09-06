## Context

See proposal.md — Why. The full rationale for every number here already lives in
`docs/HOMEKIT.md`, "Temperature: work in integer °F internally"; this document records only
the decisions that shape the module's shape and its verification, and cites that section
rather than restating it.

State this design depends on:

- `src/` currently holds only `settings.ts`; there is no `src/pod/` directory yet.
- `@homebridge/hap-nodejs` and the vitest runner arrive with the in-flight `tooling-and-ci`
  change (see its proposal — Dependencies). This change assumes both are present and adds
  no dependency of its own.

Pod-side facts, cited rather than assumed:

- The settable range is 55–110 °F inclusive, enforced server-side by zod:
  `~/Code/free-sleep/server/src/routes/deviceStatus/deviceStatusSchema.ts:9-10`
  (`.min(55, …)`, `.max(110, …)`) — a write outside it is rejected, not clamped.
- The Pod's wire representation is a ±100 level, not °F. Writes convert with
  `calculateLevelFromF` — `(F − 82.5) / 27.5 × 100`, rounded —
  (`~/Code/free-sleep/server/src/routes/deviceStatus/updateDeviceStatus.ts:12-15`), and
  reads convert back with `calculateTempInF`
  (`~/Code/free-sleep/server/src/8sleep/loadDeviceStatus.ts:56-65`), which also rounds.
  Both `currentTemperatureF` and `targetTemperatureF` in `GET /api/deviceStatus` are
  therefore already integers (`loadDeviceStatus.ts:163-164`). Every integer 55–110 °F
  survives that round trip unchanged (`docs/POD-API.md:88-89`), which is what makes integer
  °F a faithful internal representation and keeps this module free of level arithmetic.

HAP-side facts that can only be confirmed against the real library — and, for the Home app
claims, only on a paired device:

- HAP snaps a written value onto a grid **anchored at `minValue`**, not at zero. Grid point
  *k* is `minValue + k × minStep`, so the choice of `minValue` is part of the step decision,
  not independent of it (`docs/HOMEKIT.md`).
- `setProps` re-validates and may rewrite the current value, and after publish it does not
  bump the HAP configuration number — so it must be called during accessory construction.
  That constrains the *consumer* of `TARGET_TEMP_PROPS`, not this module; it is recorded
  here so the constant is understood as construction-time metadata (`docs/HOMEKIT.md`,
  "Homebridge 2.x API notes").
- The Home app's slider behaviour with a non-integral step (visible degree skipping under
  `minStep: 0.5`) is a rendering claim that **cannot be verified in CI**. Only the
  characteristic-level consequence — which values HAP admits — is testable here.

## Goals / Non-Goals

**Goals:**

- One frozen constant that every future `TargetTemperature` characteristic passes to
  `setProps`, so the grid can never drift between the left side, the right side, and any
  later surface.
- Verification that fails on the real bugs. The test must observe HAP's admitted value set,
  because both failure modes are invisible to arithmetic we write ourselves.
- A module small and total enough that later accessory work never has a reason to
  reimplement any part of it.

**Non-Goals** (beyond the proposal's):

- No defence against a caller mutating `TARGET_TEMP_PROPS`. `Object.freeze` is considered
  and declined below.
- No abstraction over "temperature" as a type (branded `Fahrenheit`/`Celsius` types, a
  `Temperature` class). Two functions and three numbers do not earn it.

## Decisions

### The module owns only the boundary: range, conversions, and the props constant

`src/pod/temperature.ts` exports `F_MIN`, `F_MAX`, `fToC`, `cToF`, `TARGET_TEMP_PROPS` and
nothing else. It is stateless, imports nothing, and is placed under `src/pod/` because the
range it encodes is a property of the Pod, not of HomeKit — the HAP props object is derived
from that range rather than the other way round.

Rationale: the two bugs this change exists to prevent are bugs of *inconsistency* — a second
place that computes a bound or a step is exactly how they come back. A single module with no
dependencies can be imported by the client layer, the accessory layer, and the tests alike.

Alternatives considered:

- *Put the props next to the Thermostat service (M2).* The constant would then be born
  inside the code that most needs it to already be correct, and could not be proven before
  that code exists — which is the whole point of landing this first.
- *Split conversions from props into two modules.* Nothing consumes one without the other,
  and the props are literally defined in terms of the conversions.

### `minStep: 5/9` with `minValue: fToC(F_MIN)` — chosen together

`5/9` is one degree Fahrenheit exactly. Combined with `minValue = fToC(55)`, grid point *k*
is exactly `fToC(55 + k)`: every integer °F is admissible and nothing between them is.

Rationale and the rejection of `0.5` are in `docs/HOMEKIT.md` (grid points 0.9 °F apart;
consecutive slider positions round to the same whole °F). The pair is load-bearing as a
pair — `5/9` against a grid anchored anywhere other than `fToC(55)` would not land on whole
degrees, so neither value may be changed alone.

Alternatives considered: `minStep: 0.1` with rounding at the accessory (admits values that
are not whole degrees, pushing the snapping problem into every consumer and reintroducing
the jitter `docs/HOMEKIT.md` describes); `minStep: 1` in °C (a 1.8 °F granularity the Pod
does not have).

### `maxValue: fToC(F_MAX) + 0.2` — margin sized between "reaches 110" and "admits nothing above it"

The margin must be strictly greater than the floating-point shortfall that costs us the top
grid point, and strictly less than one full step (`5/9 ≈ 0.5556`), or a 111 °F grid point
appears and the Pod's zod validator rejects any write of it
(`deviceStatusSchema.ts:9-10`). `0.2` sits well inside both bounds and is the value already
recorded in `docs/HOMEKIT.md` and issue #6, so it is adopted unchanged rather than
re-derived.

Verified by simulation while writing this document, in plain Node with no HAP present:
enumerating `for (let i = minValue; i <= maxValue; i += minStep)` yields **55** values with
the exact endpoint (top value 109 °F) and **56** with the `+0.2` margin (top value 110 °F).
The observable failure is therefore exactly as documented. Note that the *mechanism* differs
in detail from the `Math.floor((maxValue - minValue) / minStep)` description in
`docs/HOMEKIT.md`: with these operands that quotient evaluates to exactly `55`, and the lost
value comes from error accumulating across 55 additions in the iterator instead. The
conclusion and the fix are unchanged either way, and which internal path HAP actually takes
is not something this change needs to settle — the test asserts the outcome, not the
mechanism. Task 3.1 confirms the count against the real library, which is the only authority.

Alternatives considered:

- *`maxValue: fToC(F_MAX + 1)`* — a full extra step. Admits a 111 °F grid point that HomeKit
  would offer and the Pod would reject. Rejected.
- *`Number.EPSILON`-scale margin.* Sound in principle, but it encodes a guess about which
  operation loses precision; `0.2` is comfortably clear of the error under any of them.
- *Round `minValue`/`maxValue` to a fixed number of decimals.* Moves the grid anchor off
  `fToC(55)` and breaks the step decision above.

### Verification goes through a real `Characteristic`, constructed directly

The tests import `Characteristic` from `@homebridge/hap-nodejs` (a devDependency — the
plugin must never import it at runtime, `docs/HOMEKIT.md`), instantiate
`Characteristic.TargetTemperature`, call `setProps(TARGET_TEMP_PROPS)`, and then assert on
HAP's own behaviour: 56 values from `validValuesIterator()`, and a 56-case
`updateValue`/read round trip.

Rationale: a mock cannot fail these tests, because the thing under test *is* HAP's snapping
and validation. This is the one place in the change where the dependency is not optional.

Alternatives considered: reimplementing HAP's grid arithmetic in the test (asserts our
understanding of HAP, not HAP — precisely the mistake `docs/HOMEKIT.md` warns about);
publishing a full accessory and inspecting the HAP JSON (needs the platform code this change
deliberately precedes).

`updateValue` is the plugin-side write path (what the poller will call), so the round-trip
test covers the direction this module's consumers actually use. The client-supplied write
path — `handleSetRequest`, which per `docs/HOMEKIT.md` stores the raw client float *without*
snapping — is a different code path and is deliberately out of scope; it is the reason the
accessory will need a `publishedF` shadow value, which is M2's problem, not this module's.

### Plain `const`, not `Object.freeze`

`TARGET_TEMP_PROPS` is exported as a plain object literal, typed so its fields are read-only
to TypeScript consumers. Freezing at runtime is declined: the only consumer is our own code,
`setProps` copies the values it needs, and a frozen object silently ignoring a mutation in
a non-strict context is not obviously better than a type error at the call site.

Trade-off accepted: a runtime mutation by a future consumer would go unnoticed. It is
cheap to add later if the object ever escapes into code we do not control.

## Risks / Trade-offs

- **The `56` in the test is a magic number that could be "fixed" to `55` by a future
  contributor chasing a red test.** → The test asserts `F_MAX - F_MIN + 1`, derived from the
  exported constants, with a comment naming the bug it guards; and the golden round-trip
  independently fails if 110 °F becomes unreachable, so the two tests cannot both be
  silenced by adjusting one literal.
- **HAP-NodeJS could change its snapping or enumeration in a future major.** → That is the
  argument *for* testing against the real library: the change surfaces as a failing test in
  CI rather than as a slider that will not reach 110 °F on someone's bed.
- **`validValuesIterator()` semantics for a numeric characteristic without an explicit
  `validValues` list are load-bearing and only assumed here.** → Confirmed against the
  installed library in task 3.1, before the assertion is written; if the iterator does not
  enumerate the step grid for this characteristic type, the count assertion is replaced with
  a direct probe of the two endpoints (task 3.2) and the discrepancy is recorded in
  `docs/HOMEKIT.md` by a follow-up, not silently absorbed here.
- **The Fahrenheit slider's visible behaviour in the Home app is unverifiable in CI.** →
  Accepted. The characteristic-level property (exactly the 56 whole degrees are admissible)
  is what CI guards; the rendering claim stays a `docs/HOMEKIT.md` note to confirm on a
  paired device when M2 ships.
- **`TARGET_TEMP_PROPS` becomes hard to change once accessories are paired**, since
  `setProps` after publish does not bump the HAP configuration number
  (`docs/HOMEKIT.md`). → Treat it as frozen once M2 consumes it; that is why it is being
  settled and tested now, ahead of any accessory code.

## Migration Plan

Not applicable. Nothing is published or deployed by this change and it has no consumers
yet — the module is additive and unimported until M2. Rollback is deleting the two files.
