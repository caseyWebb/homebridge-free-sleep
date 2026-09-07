/**
 * `settings-switches` (#17/#18) end-to-end coverage (tasks.md 6.1): boots the whole platform —
 * exactly like `test/integration/session.test.ts`'s own harness — against the real, stateful
 * mock Pod (`test/mockPod.ts`), and drives both new switches through HAP's own real
 * `handleSetRequest`/`handleGetRequest`. No live Pod, no fake client — this is the same
 * real-HTTP-virtual-clock discipline `session.test.ts` established.
 */
import { describe, expect, it } from 'vitest';

import type { PlatformConfig } from 'homebridge';

import { PodClient } from '../../src/pod/client.js';
import { FreeSleepPlatform } from '../../src/platform.js';
import { SettingsSchema } from '../../src/pod/types.js';
import { AWAY_MODE_SUBTYPE } from '../../src/services/awayMode.js';
import { SKIP_ALARM_SUBTYPE } from '../../src/services/skipAlarm.js';
import { PLATFORM_NAME } from '../../src/settings.js';
import { createFakeLogging, FakeHomebridgeApi, FakePlatformAccessory } from '../fakeHomebridgeApi.js';
import { loadFixture } from '../loadFixture.js';
import { createManualTimers, type ManualTimers } from '../manualTimers.js';
import { startMockPod, type MockPod } from '../mockPod.js';

const fixtureSettings = SettingsSchema.parse(loadFixture('settings.json'));
const LEFT_NAME = fixtureSettings.left.name;
const RIGHT_NAME = fixtureSettings.right.name;

function clientFor(pod: MockPod): PodClient {
  const { hostname, port } = new URL(pod.url);
  return new PodClient({ host: hostname, port: Number(port) });
}

function baseConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return { platform: PLATFORM_NAME, host: 'pod.local', ...overrides };
}

interface Session {
  pod: MockPod;
  api: FakeHomebridgeApi;
  timers: ManualTimers;
  platform: FreeSleepPlatform;
}

async function bootSession(overrides: Record<string, unknown> = {}, podOverrides: Parameters<typeof startMockPod>[0] = {}): Promise<Session> {
  const pod = await startMockPod(podOverrides);
  const timers = createManualTimers();
  const client = clientFor(pod);
  const api = new FakeHomebridgeApi();
  const log = createFakeLogging();
  const platform = new FreeSleepPlatform(log, baseConfig(overrides), api.asApi(), client, timers);
  await api.fireDidFinishLaunching();
  return { pod, api, timers, platform };
}

function accessoryByName(api: FakeHomebridgeApi, name: string): FakePlatformAccessory {
  const accessory = api.registeredAccessories.find((a) => a.displayName === name);
  if (!accessory) throw new Error(`no registered accessory named ${name}`);
  return accessory;
}

describe('Away Mode switch end-to-end (tasks.md 6.1)', () => {
  it("toggling Away Mode on changes settings.left.awayMode in the mock's stored state", async () => {
    const { pod, api, timers } = await bootSession();
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const onChar = left.getServiceById(api.hap.Service.Switch, AWAY_MODE_SUBTYPE)!.getCharacteristic(api.hap.Characteristic.On);

      expect(pod.state.settings.left.awayMode).toBe(false);
      const pending = onChar.handleSetRequest(true);
      await timers.advance(3000); // service debounce (2s) + writeQueue's own settings-lane debounce/dispatch
      await pending;

      expect(pod.state.settings.left.awayMode).toBe(true);
    } finally {
      await pod.close();
    }
  });

  it("under the default 'mirror' policy, a subsequent side write while away is mirrored to the other side too", async () => {
    const { pod, api, timers } = await bootSession();
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const right = accessoryByName(api, RIGHT_NAME);
      const onChar = left.getServiceById(api.hap.Service.Switch, AWAY_MODE_SUBTYPE)!.getCharacteristic(api.hap.Characteristic.On);

      const awayPending = onChar.handleSetRequest(true);
      await timers.advance(3000);
      await awayPending;
      expect(pod.state.settings.left.awayMode).toBe(true);

      // Now a normal thermostat write to the right side — the away-mode guard's default
      // 'mirror' policy should also apply it to the left side's cached targetTemperatureF.
      const targetTempChar = right
        .getServiceById(api.hap.Service.Thermostat, 'thermostat')!
        .getCharacteristic(api.hap.Characteristic.TargetTemperature);
      const tempPending = targetTempChar.handleSetRequest(21); // 21C ~= 70F
      await timers.advance(1000);
      await tempPending;

      const statusPosts = pod.requests.filter((r) => r.method === 'POST' && r.path === '/api/deviceStatus');
      // The addressed right write, plus this queue's own mirror to left.
      expect(statusPosts.length).toBeGreaterThanOrEqual(2);
      expect(pod.state.deviceStatus.left.targetTemperatureF).toBe(pod.state.deviceStatus.right.targetTemperatureF);
    } finally {
      await pod.close();
    }
  });

  it('awayModeSwitch: false publishes no Away Mode switch on either side', async () => {
    const { pod, api } = await bootSession({ awayModeSwitch: false });
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const right = accessoryByName(api, RIGHT_NAME);
      expect(left.getServiceById(api.hap.Service.Switch, AWAY_MODE_SUBTYPE)).toBeUndefined();
      expect(right.getServiceById(api.hap.Service.Switch, AWAY_MODE_SUBTYPE)).toBeUndefined();
    } finally {
      await pod.close();
    }
  });
});

describe('Skip Next Alarm switch end-to-end (tasks.md 6.1)', () => {
  it("toggling Skip Next Alarm on produces a future expiresAt in the mock's settings, scoped to that side only", async () => {
    const { pod, api, timers } = await bootSession();
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const onChar = left
        .getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!
        .getCharacteristic(api.hap.Characteristic.On);

      // `timers` is `ManualTimers` — a virtual clock starting near 0, not real wall-clock time
      // (`test/manualTimers.ts`) — so the computed `expiresAt` is only ever "future" relative to
      // `timers.now()`, never to real `Date.now()`.
      const beforeMs = timers.now();
      const pending = onChar.handleSetRequest(true);
      await timers.advance(2500); // service debounce (2s) + writeQueue's own settings-lane debounce/dispatch
      await pending;

      const left1 = pod.state.settings.left.scheduleOverrides.alarm;
      expect(left1.disabled).toBe(true);
      expect(left1.timeOverride).toBe('');
      expect(left1.expiresAt).not.toBe('');
      expect(Date.parse(left1.expiresAt)).toBeGreaterThan(beforeMs);

      // Unaffected: the right side's own override, and this same side's controlBothSides/
      // alarm-skip-unrelated fields (awayMode) are untouched by this write.
      expect(pod.state.settings.right.scheduleOverrides.alarm.expiresAt).toBe('');
      expect(pod.state.settings.left.awayMode).toBe(false);
    } finally {
      await pod.close();
    }
  });

  it('toggling Skip Next Alarm off clears the override', async () => {
    const { pod, api, timers } = await bootSession();
    try {
      // Live-mutate the mock's own stored state directly (its own doc: "live, readable and
      // writable by the test directly") — an existing unexpired override, as if a prior toggle
      // (or free-sleep's own web UI) had already set one; `SideSettingsOverride`'s own
      // constructor-time override shape has no `scheduleOverrides` field to seed this at boot.
      pod.state.settings.left.scheduleOverrides.alarm = {
        disabled: true,
        timeOverride: '',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      const left = accessoryByName(api, LEFT_NAME);
      const onChar = left
        .getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)!
        .getCharacteristic(api.hap.Characteristic.On);

      const pending = onChar.handleSetRequest(false);
      await timers.advance(2500);
      await pending;

      const alarmOverride = pod.state.settings.left.scheduleOverrides.alarm;
      expect(alarmOverride).toEqual({ disabled: false, timeOverride: '', expiresAt: '' });
    } finally {
      await pod.close();
    }
  });

  it('skipAlarmSwitch: false publishes no Skip Next Alarm switch on either side', async () => {
    const { pod, api } = await bootSession({ skipAlarmSwitch: false });
    try {
      const left = accessoryByName(api, LEFT_NAME);
      const right = accessoryByName(api, RIGHT_NAME);
      expect(left.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)).toBeUndefined();
      expect(right.getServiceById(api.hap.Service.Switch, SKIP_ALARM_SUBTYPE)).toBeUndefined();
    } finally {
      await pod.close();
    }
  });
});
