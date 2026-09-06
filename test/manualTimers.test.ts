import { describe, expect, it } from 'vitest';

import { createManualTimers } from './manualTimers.js';

describe('ManualTimers (tasks.md 8.1)', () => {
  it('fires callbacks in due order, breaking ties by scheduling order', async () => {
    const timers = createManualTimers();
    const order: string[] = [];
    timers.setTimeout(() => order.push('b-100'), 100);
    timers.setTimeout(() => order.push('a-50'), 50);
    timers.setTimeout(() => order.push('c-100-second'), 100);

    await timers.advance(150);

    expect(order).toEqual(['a-50', 'b-100', 'c-100-second']);
  });

  it('now() only moves under advance(), never on its own', async () => {
    const timers = createManualTimers();
    expect(timers.now()).toBe(0);
    timers.setTimeout(() => {}, 1000);
    // No advance yet — now() must still read 0, however much real wall-clock time elapses.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(timers.now()).toBe(0);

    await timers.advance(1000);
    expect(timers.now()).toBe(1000);
  });

  it('advance() past a callback fires it exactly once and never re-fires it on a later advance', async () => {
    const timers = createManualTimers();
    let calls = 0;
    timers.setTimeout(() => {
      calls += 1;
    }, 100);

    await timers.advance(100);
    expect(calls).toBe(1);

    await timers.advance(1000);
    expect(calls).toBe(1);
  });

  it('clearTimeout prevents a scheduled callback from ever firing', async () => {
    const timers = createManualTimers();
    let fired = false;
    const handle = timers.setTimeout(() => {
      fired = true;
    }, 50);
    timers.clearTimeout(handle);

    await timers.advance(1000);

    expect(fired).toBe(false);
  });

  it('pendingCount reflects scheduled-but-not-yet-fired-or-cleared timers', async () => {
    const timers = createManualTimers();
    expect(timers.pendingCount()).toBe(0);
    const a = timers.setTimeout(() => {}, 100);
    timers.setTimeout(() => {}, 200);
    expect(timers.pendingCount()).toBe(2);

    timers.clearTimeout(a);
    expect(timers.pendingCount()).toBe(1);

    await timers.advance(200);
    expect(timers.pendingCount()).toBe(0);
  });

  it('random() always returns 0.5 — zero jitter', () => {
    const timers = createManualTimers();
    expect(timers.random()).toBe(0.5);
    expect(timers.random()).toBe(0.5);
  });

  it('a self-rescheduling callback set during advance() is picked up within the same advance if due', async () => {
    const timers = createManualTimers();
    let ticks = 0;
    function tick(): void {
      ticks += 1;
      if (ticks < 3) timers.setTimeout(tick, 10);
    }
    timers.setTimeout(tick, 10);

    await timers.advance(100);

    expect(ticks).toBe(3);
  });

  it('global timers are completely untouched — a real setTimeout still fires on its own', async () => {
    const timers = createManualTimers();
    void timers; // constructing ManualTimers must not patch any global

    const fired = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 5);
    });

    expect(fired).toBe(true);
  });
});
