## Why

Every accessory this plugin will publish reads or writes a temperature, and the Pod's
native unit is °F while HAP's is °C. The conversion looks trivial and is not: HAP snaps
`TargetTemperature` onto a step grid anchored at `minValue`, and it computes an effective
maximum by flooring `(maxValue - minValue) / minStep` — an IEEE-754 division that yields
`54.99999999999999` for the natural endpoints and silently makes 110 °F unreachable
forever. The obvious `minStep: 0.5` produces a Fahrenheit slider that visibly skips
degrees. Both bugs are invisible to a unit test of our own arithmetic, and both are
baked into HAP metadata that later accessory code cannot work around.

So this conversion module and its `setProps` constants have to land first, proven against
a real HAP-NodeJS `Characteristic`, before any service code depends on them.

Resolves #6 (milestone M1 — Foundations). Full rationale: `docs/HOMEKIT.md`,
"Temperature: work in integer °F internally".

## What Changes

- **New module `src/pod/temperature.ts`**, the single source of truth for the °F↔°C
  boundary. It exports exactly four things and nothing else:
  - `F_MIN = 55`, `F_MAX = 110` — the Pod's settable range.
  - `fToC(f)`, `cToF(c)` — plain, unrounded conversions.
  - `TARGET_TEMP_PROPS = { minValue: fToC(F_MIN), maxValue: fToC(F_MAX) + 0.2, minStep: 5/9 }`,
    the object every future `TargetTemperature` characteristic passes to `setProps`.
- **`minStep` is `5/9`, not `0.5`**, so grid point *k* is exactly `fToC(55 + k)` and every
  integer °F — and only an integer °F — is reachable.
- **`maxValue` carries a `+0.2` margin.** The margin is load-bearing, not cosmetic; it is
  what keeps 110 °F inside HAP's floored effective maximum.
- **Tests go through a real `@homebridge/hap-nodejs` `Characteristic.TargetTemperature`**,
  not through our own arithmetic, because HAP's validator is the only thing that observes
  either failure mode:
  - `Array.from(char.validValuesIterator())` has length 56 after `setProps(TARGET_TEMP_PROPS)`.
  - Golden round-trip: for every integer 55–110 °F, `updateValue(fToC(f))` then
    `Math.round(cToF(char.value)) === f`.

**Done when:** both tests pass against a real `@homebridge/hap-nodejs` Characteristic under
`npm test`, and `npm run lint`/`npm run typecheck` stay green.

## Non-goals

- **No HomeKit service or accessory code.** No `Thermostat` service, no characteristic
  registration, no `onGet`/`onSet` handlers, no platform wiring. This module is pure math
  plus a frozen constant; consuming it is M2's job.
- **No client code.** No HTTP, no `PodClient`, no polling, no cache.
- **No `CurrentTemperature` props.** `docs/HOMEKIT.md` requires a *different* shape there
  (default `minStep` 0.1, range deliberately not clamped to 55–110 °F because a cold room
  produces genuine sub-55 °F readings). Defining it here would invite the mistake of
  reusing `TARGET_TEMP_PROPS` for it. It lands with the service that owns it.
- **No `TemperatureDisplayUnits` handling** and no reading of
  `/api/settings.temperatureFormat`.
- **No anti-jitter machinery** — the `publishedF` shadow value, `writeSettleMs`, and the
  update-suppression rule from `docs/HOMEKIT.md` are state that belongs to the accessory,
  not to a stateless conversion module.
- **No level-scale arithmetic.** The plugin does not reimplement free-sleep's
  `calculateLevelFromF` / `calculateTempInF`; it sends and receives °F over the API.
- **No rounding or clamping helpers** (`clampF`, `roundToF`, …). Not needed by the two
  tests, and unused exports are a liability at this stage.
- **No `zod` schema** for temperature values (#2's scope).

## free-sleep API endpoints touched

**None.** This change adds no network calls of any kind. It does not read
`GET /api/deviceStatus`, and it writes neither `settingsDB.json` nor `schedulesDB.json`, so
there are no expensive writes and no risk of triggering a scheduled-job rebuild on the Pod.
Its tests contact no Pod and require no network.

The one Pod-side fact this change relies on is already verified and needs no new call:
every integer 55–110 °F round-trips exactly through free-sleep's ±100 level scale
(`docs/HOMEKIT.md`), so integer °F is a faithful internal representation.

## Capabilities

### New Capabilities

- `temperature-mapping`: the plugin's °F↔°C boundary — the settable Fahrenheit range, the
  conversion functions, and the HAP `TargetTemperature` property constants that must make
  every integer °F in that range, inclusive of both endpoints, reachable and stable through
  HAP's own validator.

### Modified Capabilities

None. `build-tooling` (in-flight change `tooling-and-ci`) already adds the
`@homebridge/hap-nodejs` devDependency and the vitest runner this change's tests need; no
requirement of it changes.

## Impact

- **Files added**: `src/pod/temperature.ts`, `test/pod/temperature.test.ts`.
- **Files modified**: none.
- **Dependencies**: none added. Assumes `@homebridge/hap-nodejs` is present as a
  devDependency — it arrives with the in-flight `tooling-and-ci` change. Nothing here
  imports it at runtime; `docs/HOMEKIT.md` requires that it stay test-only.
- **Systems**: no Pod, no network, no HomeKit device impact — nothing is published to a
  bridge by this change.
- **Downstream**: this module becomes a hard dependency of the per-side `Thermostat`
  accessory (M2). Changing `TARGET_TEMP_PROPS` after accessories ship changes HAP metadata
  on a paired device, so it should be treated as frozen once consumed.
