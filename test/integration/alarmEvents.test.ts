/**
 * `alarm-events` (#16) end-to-end integration tests (tasks.md group 9): real HTTP against a real
 * mock Pod, `vi.useFakeTimers()` plus `timerHarness.ts`'s `advanceFakeTime` — the same convention
 * `test/platform.wiring.test.ts`'s own alarm-events wiring tests already use, not `test/
 * manualTimers.ts`'s `ManualTimers`. `ManualTimers`'s per-callback settle-to-quiescence (`test/
 * manualTimers.ts`'s own doc: a real ~900ms minimum wait per fired timer) is far too slow for the
 * multi-hundred-thousand-millisecond virtual spans an alarm window and a schedule-edit
 * responsiveness check both need to cross — `advanceFakeTime`'s short-real-tick-per-chunk design
 * scales to that comfortably instead.
 *
 * Every test aligns `vi.setSystemTime` to a whole-minute boundary first — `schedules.*.alarm.time`
 * is `HH:mm` (minute granularity only), so aligning up front means a computed `instantMs` needs no
 * further rounding to reason about.
 */
import { describe, expect, it, vi } from 'vitest';

import type { PlatformConfig } from 'homebridge';

import { PodClient } from '../../src/pod/client.js';
import { FreeSleepPlatform } from '../../src/platform.js';
import { SchedulesSchema, SettingsSchema, type Schedules } from '../../src/pod/types.js';
import { ALARM_DISMISS_SUBTYPE, ALARM_PRESS_SUBTYPE } from '../../src/services/alarm.js';
import { PLATFORM_NAME } from '../../src/settings.js';
import { createFakeLogging, FakeHomebridgeApi, type FakePlatformAccessory } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { startMockPod, type MockPod } from '../mockPod.js';
import { advanceFakeTime, createTimerHarness, type TimerHarness } from '../timerHarness.js';

const fixtureSchedules = SchedulesSchema.parse(loadFixture('schedules.json'));
const fixtureSettings = SettingsSchema.parse(loadFixture('settings.json'));

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Default alarmPollIntervalMs (src/config.ts) and the design.md-fixed ±3 min window margin. */
const ALARM_POLL_INTERVAL_MS = 3000;
const WINDOW_MARGIN_MS = 180_000;

function clientFor(pod: MockPod): PodClient {
  const { hostname, port } = new URL(pod.url);
  return new PodClient({ host: hostname, port: Number(port) });
}

function baseConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return { platform: PLATFORM_NAME, host: 'pod.local', ...overrides };
}

/** The shared schedules fixture (every day power/alarm disabled by default) cloned with exactly
 * one eligible left-side weekday/time, computed from `instantMs` in UTC — no calendar-day shift
 * (`power.off: '20:00'`); paired with a `settings.timeZone: 'UTC'` override so the instant equals
 * `instantMs` directly. */
function schedulesWithOneAlarmAt(instantMs: number): Schedules {
  const d = new Date(instantMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const weekday = WEEKDAYS[d.getUTCDay()]!;
  const schedules = structuredClone(fixtureSchedules);
  schedules.left[weekday] = {
    ...schedules.left[weekday],
    power: { ...schedules.left[weekday].power, enabled: true, off: '20:00' },
    alarm: { ...schedules.left[weekday].alarm, enabled: true, time: `${hh}:${mm}` },
  };
  return schedules;
}

interface Session {
  pod: MockPod;
  api: FakeHomebridgeApi;
  timers: TimerHarness;
  platform: FreeSleepPlatform;
}

async function bootSession(
  configOverrides: Record<string, unknown>,
  podStateOverrides: Parameters<typeof startMockPod>[0] = {},
): Promise<Session> {
  const pod = await startMockPod(podStateOverrides);
  const timers = createTimerHarness();
  timers.random = () => 0.5; // zero jitter, matching this file's sibling suites' convention
  const client = clientFor(pod);
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const platform = new FreeSleepPlatform(log, baseConfig(configOverrides), api.asApi(), client, timers);
  await api.fireDidFinishLaunching();
  return { pod, api, timers, platform };
}

function accessoryByName(api: FakeHomebridgeApi, name: string): FakePlatformAccessory {
  const accessory = api.registeredAccessories.find((a) => a.displayName === name);
  if (!accessory) throw new Error(`no registered accessory named ${name}`);
  return accessory;
}

function deviceStatusGetCount(pod: MockPod): number {
  return pod.requests.filter((r) => r.method === 'GET' && r.path === '/api/deviceStatus').length;
}

// ---------------------------------------------------------------------------------------
// 9.1 — the full end-to-end proof for issue #16's own "done when" bar
// ---------------------------------------------------------------------------------------

describe('end-to-end: schedule -> fast-poll window -> alarm fires -> press + dismiss -> dismiss write -> deceleration (tasks.md 9.1)', () => {
  it('drives the whole alarm lifecycle against the real mock Pod', async () => {
    vi.useFakeTimers();
    const nowMs = Math.ceil(Date.now() / 60_000) * 60_000;
    vi.setSystemTime(nowMs);
    const ALARM_INSTANT_MS = nowMs + 600_000; // 10 minutes out
    const schedules = schedulesWithOneAlarmAt(ALARM_INSTANT_MS);
    const { pod, api, timers } = await bootSession({}, { state: { settings: { timeZone: 'UTC' }, schedules } });
    try {
      const left = accessoryByName(api, fixtureSettings.left.name);
      const hap = api.hap;
      const pressChar = left
        .getServiceById(hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!
        .getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent);
      const dismissChar = left
        .getServiceById(hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!
        .getCharacteristic(hap.Characteristic.On);
      const pressSpy = vi.spyOn(pressChar, 'updateValue');

      // Cross into the window's start (instant - 180_000ms) -> polling should accelerate to
      // alarmPollIntervalMs (3000ms, exact under this harness's zero-jitter random()).
      await advanceFakeTime(ALARM_INSTANT_MS - WINDOW_MARGIN_MS - timers.now(), 2000);
      const atWindowStart = deviceStatusGetCount(pod);
      await advanceFakeTime(3 * ALARM_POLL_INTERVAL_MS, 200);
      const accelerated = deviceStatusGetCount(pod) - atWindowStart;
      expect(accelerated).toBeGreaterThanOrEqual(2);
      expect(accelerated).toBeLessThanOrEqual(4);

      // The Pod's own scheduler "fires" the alarm — fault-injection, no HTTP round trip.
      pod.setAlarmVibrating('left', true);

      // The next accelerated-cadence poll observes it.
      await advanceFakeTime(ALARM_POLL_INTERVAL_MS + 500, 200);
      expect(pressSpy).toHaveBeenCalledTimes(1);
      expect(pressSpy).toHaveBeenCalledWith(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
      expect(await dismissChar.handleGetRequest()).toBe(true);

      // Dismiss it — through a real WriteQueue against the mock, the same HAP path a real
      // Home-app tap takes.
      const dismissPending = dismissChar.handleSetRequest(false);
      await advanceFakeTime(500, 100); // writeQueue's own debounce (400ms) -> dispatch
      await dismissPending;

      expect(pod.state.deviceStatus.left.isAlarmVibrating).toBe(false);
      expect(pod.commands.some((c) => c.name === 'ALARM_CLEAR')).toBe(true);
      expect(await dismissChar.handleGetRequest()).toBe(false);
      // The falling edge (dismissed) never fires a second press.
      expect(pressSpy).toHaveBeenCalledTimes(1);

      // Well past the window's end (instant + 180_000ms) -> polling decelerates again.
      await advanceFakeTime(ALARM_INSTANT_MS + WINDOW_MARGIN_MS - timers.now() + 30_000, 2000);
      const afterWindow = deviceStatusGetCount(pod);
      await advanceFakeTime(3 * ALARM_POLL_INTERVAL_MS, 200);
      const decelerated = deviceStatusGetCount(pod) - afterWindow;
      // At the (now-restored) base ~30s cadence, three alarmPollIntervalMs-widths (9s) produce
      // at most one more poll — a fraction of what the accelerated phase produced above.
      expect(decelerated).toBeLessThan(accelerated);
    } finally {
      vi.useRealTimers();
      await pod.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// 9.2 — the pre-existing-vibration guard
// ---------------------------------------------------------------------------------------

describe('pre-existing vibration observed at startup fires no press (tasks.md 9.2)', () => {
  it('bootstrapping against a mock already reporting isAlarmVibrating: true reads the dismiss switch on with zero presses', async () => {
    const { pod, api } = await bootSession({}, { state: { deviceStatus: { left: { isAlarmVibrating: true } } } });
    try {
      const left = accessoryByName(api, fixtureSettings.left.name);
      const hap = api.hap;
      const pressChar = left
        .getServiceById(hap.Service.StatelessProgrammableSwitch, ALARM_PRESS_SUBTYPE)!
        .getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent);
      const dismissChar = left
        .getServiceById(hap.Service.Switch, ALARM_DISMISS_SUBTYPE)!
        .getCharacteristic(hap.Characteristic.On);
      const pressSpy = vi.spyOn(pressChar, 'updateValue');

      expect(await dismissChar.handleGetRequest()).toBe(true);
      expect(pressSpy).not.toHaveBeenCalled();
    } finally {
      await pod.close();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 9.3 — schedule-edit responsiveness (pod-alarm-scheduler spec's "A schedule edit is eventually
// reflected")
// ---------------------------------------------------------------------------------------

describe('a schedule edited after startup is eventually reflected, without a restart (tasks.md 9.3)', () => {
  it("a near-term alarm added directly to the mock's schedules state activates a fast-poll window within two recompute cycles", async () => {
    vi.useFakeTimers();
    const nowMs = Math.ceil(Date.now() / 60_000) * 60_000;
    vi.setSystemTime(nowMs);
    const { pod, timers } = await bootSession({}, { state: { settings: { timeZone: 'UTC' } } }); // no alarm enabled anywhere
    try {
      // Nothing upcoming — advance a while at the ordinary base cadence first.
      await advanceFakeTime(100_000, 2000);
      const baseline = deviceStatusGetCount(pod);
      await advanceFakeTime(9_000, 500);
      expect(deviceStatusGetCount(pod) - baseline).toBeLessThanOrEqual(1); // still base ~30s cadence

      // The schedule changes out from under the running platform — mutated directly on the
      // mock's own live state (design.md, "Mock shape"), the same way free-sleep's own web UI
      // editing a schedule would eventually be observed via the next `schedules` poll.
      const mutatedAt = timers.now();
      const instantMs = mutatedAt + 700_000; // safely beyond one schedules-poll cycle (300_000ms)
      // plus one alarm-recompute ceiling cycle (300_000ms) combined
      pod.state.schedules = schedulesWithOneAlarmAt(instantMs);

      // One slowPollIntervalMs (300_000ms, schedules re-observed) plus one RECOMPUTE_CEILING_MS
      // (300_000ms, the scheduler's own next look at it) worst case, plus margin to land solidly
      // inside the window (instant ± 180_000ms).
      await advanceFakeTime(650_000, 2000);

      const atWindow = deviceStatusGetCount(pod);
      await advanceFakeTime(3 * ALARM_POLL_INTERVAL_MS, 200);
      const accelerated = deviceStatusGetCount(pod) - atWindow;
      expect(accelerated).toBeGreaterThanOrEqual(2);
      expect(accelerated).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
      await pod.close();
    }
  }, 30_000);
});
