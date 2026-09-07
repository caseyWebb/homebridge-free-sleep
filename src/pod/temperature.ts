/**
 * The plugin's Fahrenheit/Celsius boundary — the single source of truth for the settable
 * bed temperature range, the conversion between the Pod's native °F and HomeKit's °C, and
 * the HAP `TargetTemperature` property constants derived from them.
 *
 * Stateless, imports nothing, and must never import a HAP implementation package (this
 * module stays reachable at runtime; the HAP test library is a devDependency used only by
 * this module's own test suite). See the HomeKit modeling doc, "Temperature: work in
 * integer °F internally", for the full rationale.
 */

/** The Pod's settable range, inclusive. Server-side enforced by zod on free-sleep. */
export const F_MIN = 55;
export const F_MAX = 110;

/** Exact, unrounded, non-clamping Fahrenheit → Celsius conversion. */
export const fToC = (f: number): number => ((f - 32) * 5) / 9;

/** Exact, unrounded, non-clamping Celsius → Fahrenheit conversion. */
export const cToF = (c: number): number => (c * 9) / 5 + 32;

/**
 * Clamps an observed target temperature to the settable range's bounds — the fix for #33
 * (`anti-jitter` change, design.md's "#33: clamp at three read sites in thermostat.ts").
 *
 * `src/pod/types.ts`'s `SideStatusSchema` (the read schema) is deliberately lenient about
 * `targetTemperatureF`, so a Pod reporting a value outside `[F_MIN, F_MAX]` parses without
 * error. HAP's `TargetTemperature` characteristic cannot represent that value — its `setProps`
 * bounds mean the closest it can ever report is one of `F_MIN`/`F_MAX` — so `src/services/
 * thermostat.ts` calls this at the HomeKit service boundary, before comparing an observed
 * degree against (or writing it into) the `publishedF.targetF` shadow, never in this read
 * schema itself.
 */
export const clampTargetF = (f: number): number => Math.min(F_MAX, Math.max(F_MIN, f));

/**
 * The properties every future `TargetTemperature` characteristic must pass to `setProps`.
 *
 * `minStep` and the `+0.2` margin on `maxValue` are load-bearing and must not be changed
 * independently of each other or of `minValue` — see `docs/HOMEKIT.md`, "Temperature: work
 * in integer °F internally", for why:
 *
 * - `minStep: 5/9` is exactly one degree Fahrenheit. Combined with `minValue = fToC(F_MIN)`,
 *   HAP's grid point `k` (anchored at `minValue`) is exactly `fToC(F_MIN + k)`, so every
 *   integer °F is reachable and nothing between them is. `0.5` would put grid points 0.9 °F
 *   apart and make the slider skip degrees.
 * - `maxValue: fToC(F_MAX) + 0.2` carries a margin strictly between 0 and one full step.
 *   Without it, HAP's floored effective maximum makes 110 °F permanently unreachable.
 */
export const TARGET_TEMP_PROPS = {
  minValue: fToC(F_MIN),
  maxValue: fToC(F_MAX) + 0.2,
  minStep: 5 / 9,
};
