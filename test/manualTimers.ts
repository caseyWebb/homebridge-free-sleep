/**
 * `ManualTimers` — a fully hand-rolled `TimerApi` for `test/integration/session.test.ts`
 * (tasks.md 8.1; design.md, "The integration test: real HTTP, virtual clock").
 *
 * Deliberately **not** `vi.useFakeTimers()`: the integration test's mock Pod is a real HTTP
 * server reached over real sockets, and freezing the global timer set would freeze undici's
 * own internals along with the poller's. `src/pod/{snapshot,poller,writeQueue}.ts` never touch
 * `setTimeout`/`Date.now`/`Math.random` directly (the ESLint rule scoped to those three files),
 * so a hand-written implementation of the same `TimerApi` those modules take gives complete
 * control of every interval, backoff and overlay expiry while real HTTP proceeds on the real
 * event loop, untouched.
 *
 * `advance(ms)` fires every due callback in order. After each one, it *settles*: waits, in
 * short real ticks, for the pending-timer queue to go a full stable window with no change,
 * rather than trusting a single fixed tick. This is load-bearing, not cosmetic: `src/pod/
 * client.ts`'s own retry-on-network-error backoff (`RETRY_BASE_DELAY_MS` plus jitter,
 * ~500-700ms) is a **real**, un-fakeable `setTimeout` — it is not one of the three modules routed
 * through the injected `TimerApi` — so a poll that fails and retries genuinely needs that much
 * real wall-clock time to elapse before it calls `scheduleNext` again. Two earlier versions of
 * this file got this wrong in opposite directions: a single 0ms tick after firing returned from
 * `advance()` while the retry was still in flight, silently skipping every subsequent poll
 * attempt for the rest of the test; declaring quiescence after just two unchanged 20ms checks
 * (40ms) made the same mistake one layer down, since 40ms comfortably fits *inside* the gap
 * before a 500-700ms backoff resolves. The stable window below is sized comfortably above that
 * worst case, and — checked only *after* firing a callback, never before — costs nothing when
 * a due callback triggers no further async work at all (the common case: nothing is currently
 * due, so `advance()` returns immediately).
 */

import type { TimerApi, TimerHandle } from '../src/pod/snapshot.ts';

/** Captured at module load, before anything could plausibly patch global timers — this file
 * never expects them to be patched, but capturing defensively costs nothing and matches
 * `test/timerHarness.ts`'s own convention. */
const realSetTimeout = globalThis.setTimeout;

function realTick(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

const SETTLE_STEP_MS = 20;
/** The queue must go this long with no change before settle() declares quiescence — comfortably
 * above `RETRY_BASE_DELAY_MS + RETRY_JITTER_MS` (`src/pod/client.ts`, ~700ms worst case), the one
 * real, un-fakeable delay this file has to wait through. */
const SETTLE_STABLE_WINDOW_MS = 900;
/** Overall cap, in case something never settles at all (e.g. a `stop()` mid-chain) — comfortably
 * above `PodClient`'s own worst-case timeout-plus-retry budget (`platform.ts`'s
 * `SETTINGS_READ_TIMEOUT_MS` derivation: ~17s), so a genuinely slow real request still gets
 * waited out rather than truncated. */
const SETTLE_MAX_WAIT_MS = 20_000;

interface PendingCallback {
  id: number;
  fireAt: number;
  fn: () => void;
}

export interface ManualTimers extends TimerApi {
  /** Advances the virtual clock by `ms`, firing every due callback in order (earliest `fireAt`
   * first, insertion order breaking ties), settling after each one so a callback's own async
   * chain — including real, in-flight HTTP and `PodClient`'s real retry backoff — has actually
   * finished before the next due callback is looked for. */
  advance(ms: number): Promise<void>;
  /** Timers currently scheduled and not yet fired or cleared. */
  pendingCount(): number;
}

export function createManualTimers(): ManualTimers {
  let now = 0;
  let nextId = 1;
  const pending: PendingCallback[] = [];

  function scheduleTimeout(fn: () => void, ms: number): TimerHandle {
    const id = nextId++;
    pending.push({ id, fireAt: now + Math.max(0, ms), fn });
    pending.sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
    return id as unknown as TimerHandle;
  }

  function clearScheduledTimeout(handle: TimerHandle): void {
    const index = pending.findIndex((p) => p.id === (handle as unknown as number));
    if (index !== -1) pending.splice(index, 1);
  }

  /** Polls the pending-timer queue in short real ticks until it has gone a full stable window
   * with no change (or the overall cap is hit), rather than assuming a fixed delay is enough —
   * see the module doc above. Only ever called right after firing a callback — never before
   * checking what's next due — so a fired callback that triggers no further async work at all
   * costs nothing extra on the *next* iteration's check. */
  async function settle(): Promise<void> {
    let waited = 0;
    let stableFor = 0;
    let previousLength = pending.length;
    while (waited < SETTLE_MAX_WAIT_MS && stableFor < SETTLE_STABLE_WINDOW_MS) {
      await realTick(SETTLE_STEP_MS);
      waited += SETTLE_STEP_MS;
      if (pending.length === previousLength) {
        stableFor += SETTLE_STEP_MS;
      } else {
        stableFor = 0;
        previousLength = pending.length;
      }
    }
  }

  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    for (;;) {
      const next = pending[0];
      if (!next || next.fireAt > target) break;
      pending.shift();
      now = next.fireAt;
      next.fn();
      // A callback's own async chain — a real HTTP round trip, or a retry's real, un-fakeable
      // backoff — may still enqueue something due within this same window once it finishes.
      await settle();
    }
    now = target;
  }

  return {
    setTimeout: scheduleTimeout,
    clearTimeout: clearScheduledTimeout,
    now: () => now,
    random: () => 0.5,
    advance,
    pendingCount: () => pending.length,
  };
}
