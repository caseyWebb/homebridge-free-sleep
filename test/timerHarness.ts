/**
 * A test-only `TimerApi` (tasks.md 1.2) backed by vitest's fake timers, with a settable
 * `random` so a test can eliminate jitter (`random: () => 0.5`, design.md) or drive it
 * explicitly. Also exposes the pending-timer count so a test can assert a poller or write
 * queue left nothing scheduled after `stop()` (tasks.md 6.6, 9.7).
 *
 * Deliberately thin: `setTimeout`/`clearTimeout` delegate straight to the globals vitest's
 * `vi.useFakeTimers()` has already patched, and `now()` delegates to `Date.now()` — which is
 * the *same* clock `vi.advanceTimersByTimeAsync` moves, so timer firing and `now()` can never
 * drift apart (design.md, "why inject rather than rely on `vi.useFakeTimers()` patching
 * globals").
 */

import { vi } from 'vitest';

import type { TimerApi } from '../src/pod/snapshot.js';

/**
 * Captured at module load — before any test calls `vi.useFakeTimers()` — so this keeps
 * scheduling on the *real* event loop no matter what vitest has since patched `globalThis`
 * with. `PodPoller`/`WriteQueue` tests run real network I/O against `startMockPod()` while
 * fake-timers drive the scheduling logic; `advanceFakeTime` below is how a test lets that real
 * I/O actually complete in between virtual-time jumps (a single `vi.advanceTimersByTimeAsync`
 * call only flushes microtasks, not a full libuv turn, so a self-rescheduling class whose next
 * timer isn't created until its real HTTP response lands would otherwise never get re-armed).
 */
const realSetTimeout = globalThis.setTimeout;

/** A real, faked-timer-immune delay — lets pending real socket I/O reach its callback. */
export function realDelay(ms = 0): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/**
 * Advances vitest's fake clock by `totalMs`, in `stepMs` increments, yielding a short real
 * delay after each so a self-rescheduling poll's real HTTP round trip (and the next timer it
 * schedules once that settles) has a chance to actually happen before the next virtual jump.
 */
export async function advanceFakeTime(totalMs: number, stepMs = 50): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const chunk = Math.min(stepMs, remaining);
    await vi.advanceTimersByTimeAsync(chunk);
    await realDelay(0);
    remaining -= chunk;
  }
}

export interface TimerHarness extends TimerApi {
  /** Mutable — tests reassign this to control jitter draws mid-test. */
  random: () => number;
  /** Number of timers vitest's fake-timer system still has scheduled. */
  pendingCount(): number;
}

export function createTimerHarness(initialRandom: () => number = () => 0.5): TimerHarness {
  let randomImpl = initialRandom;

  const harness: TimerHarness = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    now: () => Date.now(),
    get random() {
      return randomImpl;
    },
    set random(fn: () => number) {
      randomImpl = fn;
    },
    pendingCount: () => vi.getTimerCount(),
  };

  return harness;
}
