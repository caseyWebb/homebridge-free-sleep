import { Characteristic } from '@homebridge/hap-nodejs';
import { describe, expect, it } from 'vitest';

import { F_MAX, F_MIN, TARGET_TEMP_PROPS, cToF, fToC } from '../../src/pod/temperature.js';

describe('F_MIN / F_MAX', () => {
  it('reports 55 °F as the minimum and 110 °F as the maximum, both inclusive', () => {
    expect(F_MIN).toBe(55);
    expect(F_MAX).toBe(110);
  });
});

describe('fToC / cToF', () => {
  it('converts known anchor points exactly', () => {
    expect(fToC(32)).toBe(0);
    expect(fToC(212)).toBe(100);
    expect(fToC(-40)).toBe(-40);
  });

  it('is a pure function of its input, independent of call order or prior calls', () => {
    const first = fToC(70);
    // Interleave unrelated calls, including at the range endpoints, to rule out any
    // shared/mutable state influencing the result.
    fToC(F_MIN);
    cToF(fToC(F_MAX));
    fToC(-40);
    const second = fToC(70);
    expect(second).toBe(first);
  });

  it('inverts across the settable range to within floating-point error', () => {
    for (let f = F_MIN; f <= F_MAX; f++) {
      expect(cToF(fToC(f))).toBeCloseTo(f, 10);
      expect(Math.abs(cToF(fToC(f)) - f)).toBeLessThan(Number.EPSILON * 100);
    }
  });

  it('does not clamp values outside the settable range', () => {
    // A sub-55 °F room reading must convert to its true Celsius equivalent, not be
    // clamped to the settable bed-temperature range. 40 °F is above freezing, so its true
    // value is positive — not negative as tasks.md's illustrative wording suggests; what
    // matters, and what spec.md actually requires, is that it is the true, unclamped value.
    expect(fToC(40)).toBeCloseTo(((40 - 32) * 5) / 9, 10);
    expect(fToC(40)).not.toBe(fToC(F_MIN));

    // A colder room reading demonstrates the true-negative case: still not clamped.
    expect(fToC(20)).toBeLessThan(0);
    expect(fToC(20)).toBeCloseTo(((20 - 32) * 5) / 9, 10);
  });
});

describe('TARGET_TEMP_PROPS', () => {
  it('anchors minValue at fToC(F_MIN) and uses a 5/9 step', () => {
    expect(TARGET_TEMP_PROPS.minValue).toBe(fToC(F_MIN));
    expect(TARGET_TEMP_PROPS.minStep).toBe(5 / 9);
  });

  it('carries a maxValue margin strictly between 0 and one full step', () => {
    // The upper bound keeps a 111 °F grid point out, which the Pod's zod validator would
    // reject (deviceStatusSchema.ts:9-10) — see docs/HOMEKIT.md.
    const margin = TARGET_TEMP_PROPS.maxValue - fToC(F_MAX);
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(TARGET_TEMP_PROPS.minStep);
  });
});

// These two tests exercise a real HAP Characteristic rather than our own arithmetic,
// because HAP's own grid-snapping and validation are the behaviour under test — a mock or
// a reimplementation of HAP's rules could not observe either failure mode described below.
describe('TARGET_TEMP_PROPS against a real HAP TargetTemperature characteristic', () => {
  function buildCharacteristic(): Characteristic {
    const char = new Characteristic.TargetTemperature();
    char.setProps(TARGET_TEMP_PROPS);
    return char;
  }

  it('admits exactly the 56 whole degrees from 55 to 110 °F', () => {
    // Guards the maxValue-margin bug: without the +0.2 margin, HAP's validValuesIterator
    // yields only 55 values (110 °F unreachable) instead of 56. See docs/HOMEKIT.md and
    // design.md — Risks.
    const char = buildCharacteristic();
    const validValues = Array.from(char.validValuesIterator());
    expect(validValues).toHaveLength(F_MAX - F_MIN + 1);
  });

  it('enumerates only whole degrees Fahrenheit, one degree apart, topping out at 110 °F', () => {
    const char = buildCharacteristic();
    const validValues = Array.from(char.validValuesIterator()) as number[];
    const asF = validValues.map((c) => cToF(c));

    // Every enumerated grid point is a whole degree Fahrenheit.
    for (const f of asF) {
      expect(f).toBeCloseTo(Math.round(f), 6);
    }

    // Consecutive grid points differ by exactly one degree Fahrenheit — no skipped and no
    // duplicated whole degree.
    for (let i = 1; i < asF.length; i++) {
      expect(asF[i]! - asF[i - 1]!).toBeCloseTo(1, 6);
    }

    // Nothing above the range becomes selectable.
    expect(Math.round(asF[asF.length - 1]!)).toBe(F_MAX);
    for (const f of asF) {
      expect(Math.round(f)).toBeLessThanOrEqual(F_MAX);
    }
  });

  it('round-trips every whole degree Fahrenheit from 55 to 110 through updateValue', () => {
    // This is the write path a poller actually uses. Note: this assertion alone does not
    // independently catch a too-coarse minStep (e.g. 0.5) — Math.round's 0.5 °F tolerance
    // absorbs the snap error of any minStep <= 5/9. The "enumerates only whole degrees..."
    // test above is what catches that case (see tasks.md task 3.5's recorded finding).
    const char = buildCharacteristic();
    for (let f = F_MIN; f <= F_MAX; f++) {
      char.updateValue(fToC(f));
      expect(Math.round(cToF(char.value as number))).toBe(f);
    }
  });
});
