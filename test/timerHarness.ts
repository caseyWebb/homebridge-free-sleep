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

import type { TimerApi, TimerHandle } from '../src/pod/snapshot.js';

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
  /**
   * Diagnostic-only (CI regression investigation, alarm-events PR #45 review): a label — the
   * call-site of whichever `this.timers.setTimeout(...)` scheduled it — for every timer this
   * harness itself has scheduled and not yet cleared or fired, in scheduling order. Only ever
   * covers timers scheduled *through this harness* — i.e. everything this plugin's own code
   * schedules via the injected `TimerApi` (`snapshot.ts`/`poller.ts`/`writeQueue.ts`/
   * `alarmWindowScheduler.ts`/`keepAlive.ts`, and every service that threads the same shared
   * `timers` object through `ServiceContext`). A timer some *other* library schedules directly
   * against the bare global (HAP-NodeJS's own per-accessory `configurationChangeDebounceTimeout`
   * is exactly this) never appears here even though `pendingCount()`/`vi.getTimerCount()` still
   * counts it — which is precisely what makes this a decisive diagnostic: if `pendingCount()`
   * exceeds the expected baseline but `pendingLabels()` is empty (or unchanged), the excess is
   * provably not this plugin's own doing.
   */
  pendingLabels(): string[];
}

/** The call-site inside *this plugin's own source* that invoked `timers.setTimeout(...)`, or the
 * raw first stack line if none is found (e.g. called directly from a test). Skips this module's
 * own frame and vitest/node internals so the label points at the actual caller. */
function callSiteLabel(): string {
  const stack = new Error().stack ?? '';
  const lines = stack.split('\n').slice(1); // drop the "Error" header line
  const appFrame = lines.find((line) => /\/(src|test)\//.test(line) && !line.includes('/test/timerHarness.ts'));
  return (appFrame ?? lines[0] ?? '<unknown>').trim();
}

export function createTimerHarness(initialRandom: () => number = () => 0.5): TimerHarness {
  let randomImpl = initialRandom;
  const labels = new Map<TimerHandle, string>();

  const harness: TimerHarness = {
    setTimeout: (fn, ms) => {
      const label = callSiteLabel();
      const handle = globalThis.setTimeout(() => {
        labels.delete(handle);
        fn();
      }, ms);
      labels.set(handle, label);
      return handle;
    },
    clearTimeout: (handle) => {
      labels.delete(handle);
      globalThis.clearTimeout(handle);
    },
    now: () => Date.now(),
    get random() {
      return randomImpl;
    },
    set random(fn: () => number) {
      randomImpl = fn;
    },
    pendingCount: () => vi.getTimerCount(),
    pendingLabels: () => [...labels.values()],
  };

  return harness;
}
