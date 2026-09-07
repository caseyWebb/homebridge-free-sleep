/**
 * `AwayModeGuard` — pure decision-logic tests (away-mode-guard tasks.md 1.2, 1.3, adapted).
 *
 * Adaptation note (tech-lead resolution 2): the original tasks.md described `AwayModeGuard` as
 * owning both the decision *and* the dispatch (a `guardSideWrite(side, patch)` front-door
 * wrapper around `WriteQueue`). The tech lead moved enforcement inside `WriteQueue.dispatch()`
 * itself (see `test/writeQueue.test.ts`'s "away-mode guard (9.6)" section for the dispatch-level
 * behavior — block/mirror/symmetry/concurrency/zero-cost), so this module now holds only the
 * decision: a pure function of the cached snapshot and the configured policy, with no side,
 * patch, or `WriteQueue` reference at all — the "either side away" requirement made this trivial
 * to make side-independent, per the module doc.
 */
import { describe, expect, it } from 'vitest';

import { AwayModeBlockedError, AwayModeGuard, type AwayModeWritePolicy } from '../../src/pod/awayModeGuard.js';
import { SnapshotStore } from '../../src/pod/snapshot.js';
import type { Settings } from '../../src/pod/types.js';
import { loadFixture } from '../loadFixture.js';
import { createTimerHarness } from '../timerHarness.js';

const settingsFixture = loadFixture('settings.json') as Settings;

function guardWith(policy: AwayModeWritePolicy, leftAway: boolean, rightAway: boolean): AwayModeGuard {
  const timers = createTimerHarness();
  const snapshot = new SnapshotStore({ timers });
  snapshot.observeSettings({
    ...structuredClone(settingsFixture),
    left: { ...settingsFixture.left, awayMode: leftAway },
    right: { ...settingsFixture.right, awayMode: rightAway },
  });
  return new AwayModeGuard({ snapshot, policy });
}

describe('AwayModeGuard.decide() — the four (leftAway, rightAway) combinations crossed with both policies (1.3)', () => {
  const combos: Array<[boolean, boolean]> = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ];

  for (const policy of ['mirror', 'block'] as const) {
    for (const [leftAway, rightAway] of combos) {
      const eitherAway = leftAway || rightAway;
      const expected = eitherAway ? policy : 'plain';
      it(`policy=${policy}, left=${leftAway}, right=${rightAway} -> ${expected}`, () => {
        const guard = guardWith(policy, leftAway, rightAway);
        expect(guard.decide()).toBe(expected);
      });
    }
  }
});

describe('AwayModeGuard.decide() is side-independent by construction (either side away is sufficient)', () => {
  it('takes no side parameter — the same decision governs a write to either side', () => {
    const guard = guardWith('block', true, false);
    // `decide()` has no side/patch parameter at all: there is nothing for a caller to vary that
    // could change the outcome depending on which side is being written to.
    expect(guard.decide()).toBe('block');
    expect(guard.decide()).toBe('block');
  });
});

describe('AwayModeBlockedError (1.2)', () => {
  it('is an Error subclass with a stable name', () => {
    const error = new AwayModeBlockedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AwayModeBlockedError');
  });

  it('accepts a custom message while keeping the stable name', () => {
    const error = new AwayModeBlockedError('custom');
    expect(error.message).toBe('custom');
    expect(error.name).toBe('AwayModeBlockedError');
  });
});
