import { afterEach, describe, expect, it } from 'vitest';

import { startMockPod, type MockPod } from './mockPod.js';
import { loadFixture } from './loadFixture.js';
import { ServerStatusSchema, type ServerStatus } from '../src/pod/types.js';

const deviceStatusFixture = loadFixture('deviceStatus.json');
const settingsFixture = loadFixture('settings.json') as { id: string };
const schedulesFixture = loadFixture('schedules.json');
const servicesFixture = loadFixture('services.json');
const serverStatusFixture: ServerStatus = ServerStatusSchema.parse(loadFixture('serverStatus.json'));

let pods: MockPod[] = [];

async function start(...args: Parameters<typeof startMockPod>): Promise<MockPod> {
  const pod = await startMockPod(...args);
  pods.push(pod);
  return pod;
}

afterEach(async () => {
  await Promise.all(pods.map((pod) => pod.close()));
  pods = [];
});

describe('transport', () => {
  it('listens on an ephemeral port and serves the fixture over real HTTP', async () => {
    const pod = await start();
    expect(pod.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${pod.url}/api/deviceStatus`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(deviceStatusFixture);
  });

  it('close() resolves', async () => {
    const pod = await startMockPod();
    await expect(pod.close()).resolves.toBeUndefined();
  });

  it('seeds all four GET endpoints from the fixtures', async () => {
    const pod = await start();
    const [deviceStatus, settings, schedules, services] = await Promise.all([
      fetch(`${pod.url}/api/deviceStatus`).then((r) => r.json()),
      fetch(`${pod.url}/api/settings`).then((r) => r.json()),
      fetch(`${pod.url}/api/schedules`).then((r) => r.json()),
      fetch(`${pod.url}/api/services`).then((r) => r.json()),
    ]);
    expect(deviceStatus).toEqual(deviceStatusFixture);
    expect(settings).toEqual(settingsFixture);
    expect(schedules).toEqual(schedulesFixture);
    expect(services).toEqual(servicesFixture);
  });

  it('an override at startup is reflected in a read', async () => {
    const pod = await start({ state: { settings: { left: { awayMode: true } } } });
    const settings = (await fetch(`${pod.url}/api/settings`).then((r) => r.json())) as {
      left: { awayMode: boolean };
    };
    expect(settings.left.awayMode).toBe(true);
  });

  it('reset() after a write restores the seed and empties requests/commands', async () => {
    const pod = await start();
    await fetch(`${pod.url}/api/deviceStatus`, {
      method: 'POST',
      body: JSON.stringify({ left: { isOn: false } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(pod.requests.length).toBeGreaterThan(0);

    pod.reset();
    expect(pod.requests).toEqual([]);
    expect(pod.commands).toEqual([]);
    const deviceStatus = await fetch(`${pod.url}/api/deviceStatus`).then((r) => r.json());
    expect(deviceStatus).toEqual(deviceStatusFixture);
  });

  it('three mocks started concurrently get distinct ports and independent state', async () => {
    const [a, b, c] = await Promise.all([
      start({ state: { settings: { left: { awayMode: true } } } }),
      start(),
      start(),
    ]);
    const ports = [a.url, b.url, c.url];
    expect(new Set(ports).size).toBe(3);

    const aSettings = (await fetch(`${a.url}/api/settings`).then((r) => r.json())) as {
      left: { awayMode: boolean };
    };
    const bSettings = (await fetch(`${b.url}/api/settings`).then((r) => r.json())) as {
      left: { awayMode: boolean };
    };
    expect(aSettings.left.awayMode).toBe(true);
    expect(bSettings.left.awayMode).toBe(false);
  });

  it('records method, path, headers, parsed body, status, and timestamp for both a valid and an invalid write', async () => {
    const pod = await start();

    await fetch(`${pod.url}/api/deviceStatus`, {
      method: 'POST',
      body: JSON.stringify({ left: { targetTemperatureF: 70 } }),
      headers: { 'content-type': 'application/json' },
    });
    await fetch(`${pod.url}/api/deviceStatus`, {
      method: 'POST',
      body: JSON.stringify({ left: { bogusField: true } }),
      headers: { 'content-type': 'application/json' },
    });

    expect(pod.requests).toHaveLength(2);
    expect(pod.requests[0]?.status).toBe(204);
    expect(pod.requests[0]?.method).toBe('POST');
    expect(pod.requests[0]?.path).toBe('/api/deviceStatus');
    expect(pod.requests[0]?.headers['content-type']).toBe('application/json');
    expect(pod.requests[0]?.at).toBeTypeOf('number');

    expect(pod.requests[1]?.status).toBe(400);
    expect(pod.requests[1]?.body).toEqual({ left: { bogusField: true } });
  });

  describe('fault injection', () => {
    it('a scripted 500 is followed by a normal 200 once exhausted', async () => {
      const pod = await start();
      pod.fault('GET /api/deviceStatus', { kind: 'status', status: 500, times: 1 });

      const first = await fetch(`${pod.url}/api/deviceStatus`);
      expect(first.status).toBe(500);

      const second = await fetch(`${pod.url}/api/deviceStatus`);
      expect(second.status).toBe(200);
    });

    it('a hang is ended by the caller\'s own timeout', async () => {
      const pod = await start();
      pod.fault('GET /api/deviceStatus', { kind: 'hang', times: 1 });

      await expect(
        fetch(`${pod.url}/api/deviceStatus`, { signal: AbortSignal.timeout(200) }),
      ).rejects.toThrow();
    });

    it('a reset surfaces as a network-level fetch failure', async () => {
      const pod = await start();
      pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 1 });

      await expect(fetch(`${pod.url}/api/deviceStatus`)).rejects.toThrow();

      // normal service resumes once the fault is exhausted
      const response = await fetch(`${pod.url}/api/deviceStatus`);
      expect(response.status).toBe(200);
    });

    it('a typo\'d endpoint throws loudly instead of silently never firing (N3)', async () => {
      const pod = await start();
      expect(() => pod.fault('GET /api/deviceStatis', { kind: 'status', times: 1 })).toThrow();
      expect(() => pod.fault('DELETE /api/deviceStatus', { kind: 'status', times: 1 })).toThrow();
    });

    it('every endpoint the mock actually routes is accepted by fault()', async () => {
      const pod = await start();
      for (const endpoint of [
        'GET /api/deviceStatus',
        'GET /api/settings',
        'GET /api/schedules',
        'GET /api/services',
        'GET /api/serverStatus',
        'POST /api/deviceStatus',
        'POST /api/settings',
        'POST /api/alarm',
      ]) {
        expect(() => pod.fault(endpoint, { kind: 'status', times: 1 })).not.toThrow();
      }
    });
  });
});

async function postDeviceStatus(pod: MockPod, body: unknown): Promise<Response> {
  return fetch(`${pod.url}/api/deviceStatus`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function postSettings(pod: MockPod, body: unknown): Promise<Response> {
  return fetch(`${pod.url}/api/settings`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

type PartialDeviceStatus = {
  left: { isOn: boolean; secondsRemaining: number; targetTemperatureF: number };
  right: { isOn: boolean; secondsRemaining: number; targetTemperatureF: number };
};

async function getDeviceStatus(pod: MockPod): Promise<PartialDeviceStatus> {
  const response = await fetch(`${pod.url}/api/deviceStatus`);
  return (await response.json()) as PartialDeviceStatus;
}

describe('strict request validation (5.1)', () => {
  it('an unknown key gives 400 naming the key, with no state change', async () => {
    const pod = await start();
    const before = await getDeviceStatus(pod);

    const response = await postDeviceStatus(pod, { left: { turboMode: true } });
    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as { error: string; details: unknown[] };
    expect(responseBody.error).toBe('Invalid request data');
    expect(JSON.stringify(responseBody.details)).toMatch(/turboMode/);

    const after = await getDeviceStatus(pod);
    expect(after).toEqual(before);
  });

  it('an out-of-range temperature gives 400', async () => {
    const pod = await start();
    const response = await postDeviceStatus(pod, { left: { targetTemperatureF: 200 } });
    expect(response.status).toBe(400);
  });

  describe('accepts every field upstream\'s DeviceStatusSchema.deepPartial() accepts (S3)', () => {
    // PodClient's own outgoing DeviceStatusPatchSchema never sends these — it only has a
    // defined write policy for a handful of fields — but a real Pod's request validation
    // (`DeviceStatusSchema.deepPartial().safeParse(body)`) structurally accepts the rest of
    // `DeviceStatusSchema` too. The mock must not 400 a body a real Pod would accept.
    it.each([
      ['a side-level currentTemperatureF', { left: { currentTemperatureF: 71 } }],
      ['a side-level currentTemperatureLevel', { left: { currentTemperatureLevel: 5 } }],
      ['a side-level taps object', { left: { taps: { doubleTap: 1, tripleTap: 2, quadTap: 3 } } }],
      ['a top-level waterLevel', { waterLevel: 'true' }],
      ['a top-level coverVersion', { coverVersion: 'Pod 5' }],
      ['a top-level hubVersion', { hubVersion: 'Pod 5' }],
      ['a top-level freeSleep object', { freeSleep: { version: '2.1.5', branch: 'main' } }],
      ['a top-level wifiStrength', { wifiStrength: 90 }],
    ])('%s gives 204, not 400', async (_label, patch) => {
      const pod = await start();
      const response = await postDeviceStatus(pod, patch);
      expect(response.status).toBe(204);
    });

    it('a field this schema still does not recognize gives 400 naming it', async () => {
      const pod = await start();
      const response = await postDeviceStatus(pod, { turboMode: true });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { details: unknown[] };
      expect(JSON.stringify(body.details)).toMatch(/turboMode/);
    });
  });

  it('a valid device-status write gives 204 with an empty body', async () => {
    const pod = await start();
    const response = await postDeviceStatus(pod, { left: { targetTemperatureF: 70 } });
    expect(response.status).toBe(204);
    const text = await response.text();
    expect(text).toBe('');
  });

  it('a valid settings write gives 200 with the stored id intact in the response', async () => {
    const pod = await start();
    const before = await fetch(`${pod.url}/api/settings`).then((r) => r.json()) as { id: string };
    const response = await postSettings(pod, { left: { awayMode: true } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // settings.ts deletes `id` only from the *request* body before merging; the response is
    // `res.json(settingsDB.data)` — the stored document, id intact.
    expect(body.id).toBe(before.id);
    expect(body.left).toMatchObject({ awayMode: true });
  });

  it('a settings write cannot overwrite the stored id even if the request body sends one', async () => {
    const pod = await start();
    const before = await fetch(`${pod.url}/api/settings`).then((r) => r.json()) as { id: string };
    const response = await postSettings(pod, { id: 'attacker-supplied', left: { awayMode: true } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(before.id);
    expect(body.id).not.toBe('attacker-supplied');
  });
});

describe('zero-duration silent no-op and power-off (5.2)', () => {
  it('secondsRemaining: 0 does not turn a side off', async () => {
    const pod = await start();
    await postDeviceStatus(pod, { left: { secondsRemaining: 600 } });
    const response = await postDeviceStatus(pod, { left: { secondsRemaining: 0 } });
    expect(response.status).toBe(204);

    const after = await getDeviceStatus(pod);
    expect(after.left.isOn).toBe(true);
    expect(after.left.secondsRemaining).toBe(600);
  });

  it('isOn: false does turn a side off', async () => {
    const pod = await start();
    await postDeviceStatus(pod, { left: { secondsRemaining: 600 } });
    await postDeviceStatus(pod, { left: { isOn: false } });

    const after = await getDeviceStatus(pod);
    expect(after.left.isOn).toBe(false);
    expect(after.left.secondsRemaining).toBe(0);
  });

  it('secondsRemaining: 900 sets 900', async () => {
    const pod = await start();
    await postDeviceStatus(pod, { left: { secondsRemaining: 900 } });
    const after = await getDeviceStatus(pod);
    expect(after.left.secondsRemaining).toBe(900);
    expect(after.left.isOn).toBe(true);
  });
});

describe('twelve-hour expansion and derived power state (5.3)', () => {
  it('isOn: true sets 43200 and reads isOn: true', async () => {
    const pod = await start();
    await postDeviceStatus(pod, { left: { isOn: true } });
    const after = await getDeviceStatus(pod);
    expect(after.left.secondsRemaining).toBe(43200);
    expect(after.left.isOn).toBe(true);
  });

  it('power state follows remaining time directly, with no stored flag', async () => {
    const pod = await start();
    await postDeviceStatus(pod, { left: { secondsRemaining: 1 } });
    expect((await getDeviceStatus(pod)).left.isOn).toBe(true);

    await postDeviceStatus(pod, { left: { isOn: false } });
    expect((await getDeviceStatus(pod)).left.isOn).toBe(false);
  });
});

describe('away-mode both-sides mirroring (5.4)', () => {
  it('a write to one side hits both when the other is in away mode', async () => {
    const pod = await start({ state: { settings: { right: { awayMode: true } } } });
    await postDeviceStatus(pod, { left: { targetTemperatureF: 70 } });
    const after = await getDeviceStatus(pod);
    expect(after.left.targetTemperatureF).toBe(70);
    expect(after.right.targetTemperatureF).toBe(70);
  });

  it('with neither side away, a write to one side affects only that side', async () => {
    const pod = await start();
    const before = await getDeviceStatus(pod);
    await postDeviceStatus(pod, { left: { targetTemperatureF: 70 } });
    const after = await getDeviceStatus(pod);
    expect(after.left.targetTemperatureF).toBe(70);
    expect(after.right.targetTemperatureF).toBe(before.right.targetTemperatureF);
  });
});

describe('fixed command expansion and ordering (5.5)', () => {
  it('a body with properties in reverse order still produces the canonical sequence', async () => {
    const pod = await start();
    await postDeviceStatus(pod, {
      left: { isAlarmVibrating: false, secondsRemaining: 300, targetTemperatureF: 68, isOn: true },
    });
    const names = pod.commands.map((c) => c.name);
    expect(names).toEqual([
      'LEFT_TEMP_DURATION', // isOn
      'TEMP_LEVEL_LEFT', // targetTemperatureF
      'LEFT_TEMP_DURATION', // secondsRemaining
      'ALARM_CLEAR', // isAlarmVibrating
    ]);
  });

  it('ALARM_CLEAR is recorded with no side, matching executeFunction(\'ALARM_CLEAR\', \'empty\') (N4)', async () => {
    const pod = await start();
    await postDeviceStatus(pod, { left: { isAlarmVibrating: false } });
    const alarmClear = pod.commands.find((c) => c.name === 'ALARM_CLEAR');
    expect(alarmClear).toBeDefined();
    expect(alarmClear!.side).toBeUndefined();
  });

  it('a body setting fields on both sides logs all left commands before all right', async () => {
    const pod = await start();
    await postDeviceStatus(pod, {
      left: { targetTemperatureF: 68 },
      right: { targetTemperatureF: 72 },
    });
    const sides = pod.commands.map((c) => c.side);
    expect(sides).toEqual(['left', 'right']);
  });

  it('{left: {isOn: true, secondsRemaining: 600}} logs 43200 then 600, and leaves the side at 600', async () => {
    const pod = await start();
    await postDeviceStatus(pod, { left: { isOn: true, secondsRemaining: 600 } });
    const durationCommands = pod.commands.filter((c) => c.name === 'LEFT_TEMP_DURATION');
    expect(durationCommands.map((c) => c.value)).toEqual(['43200', '600']);

    const after = await getDeviceStatus(pod);
    expect(after.left.secondsRemaining).toBe(600);
  });

  it('top level: PRIME -> left -> right -> settings', async () => {
    const pod = await start();
    await postDeviceStatus(pod, {
      isPriming: true,
      left: { targetTemperatureF: 68 },
      right: { targetTemperatureF: 72 },
      settings: { ledBrightness: 10 },
    });
    expect(pod.commands.map((c) => c.name)).toEqual([
      'PRIME',
      'TEMP_LEVEL_LEFT',
      'TEMP_LEVEL_RIGHT',
      'SET_SETTINGS',
    ]);
  });
});

describe('no plugin policy (5.6)', () => {
  it('two identical writes both apply and both appear in pod.requests', async () => {
    const pod = await start();
    const first = await postDeviceStatus(pod, { left: { secondsRemaining: 500 } });
    const second = await postDeviceStatus(pod, { left: { secondsRemaining: 500 } });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('a write to a side in away mode is applied (mirrored), not suppressed', async () => {
    const pod = await start({ state: { settings: { left: { awayMode: true } } } });
    const response = await postDeviceStatus(pod, { right: { targetTemperatureF: 66 } });
    expect(response.status).toBe(204);
    const after = await getDeviceStatus(pod);
    expect(after.left.targetTemperatureF).toBe(66);
    expect(after.right.targetTemperatureF).toBe(66);
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: subsystem health (GET /api/serverStatus)
// ---------------------------------------------------------------------------------------

describe('subsystem health (6.2)', () => {
  it('the default response reports no failed subsystem', async () => {
    const pod = await start();
    const response = await fetch(`${pod.url}/api/serverStatus`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ServerStatus;
    expect(body).toEqual(serverStatusFixture);
    for (const info of Object.values(body)) {
      expect(info?.status).not.toBe('failed');
    }
  });

  it('a startup override injecting a failed subsystem is served back unchanged', async () => {
    const failed: ServerStatus = { ...serverStatusFixture, database: { ...serverStatusFixture.database, status: 'failed' } };
    const pod = await start({ state: { serverStatus: failed } });
    const response = await fetch(`${pod.url}/api/serverStatus`);
    const body = (await response.json()) as ServerStatus;
    expect(body.database.status).toBe('failed');
  });

  it('reset() restores the seeded (including override) subsystem-health document, matching every other document\'s own reset behavior', async () => {
    const failed: ServerStatus = { ...serverStatusFixture, database: { ...serverStatusFixture.database, status: 'failed' } };
    const pod = await start({ state: { serverStatus: failed } });
    pod.reset();
    const response = await fetch(`${pod.url}/api/serverStatus`);
    const body = (await response.json()) as ServerStatus;
    expect(body.database.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: alarm trigger (POST /api/alarm)
// ---------------------------------------------------------------------------------------

async function postAlarm(pod: MockPod, body: unknown): Promise<Response> {
  return fetch(`${pod.url}/api/alarm`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('alarm trigger (6.3)', () => {
  it('a forced trigger against an off, away side is still recorded as a command', async () => {
    const pod = await start({ state: { settings: { left: { awayMode: true } }, deviceStatus: { left: { secondsRemaining: 0 } } } });
    const response = await postAlarm(pod, {
      side: 'left',
      vibrationIntensity: 60,
      vibrationPattern: 'double',
      duration: 10,
      force: true,
    });
    expect(response.status).toBe(200);
    expect(pod.commands.some((c) => c.name === 'ALARM_LEFT')).toBe(true);
  });

  it('a non-forced trigger against an off side is a no-op with respect to hardware commands', async () => {
    const pod = await start({ state: { deviceStatus: { left: { secondsRemaining: 0 } } } });
    const response = await postAlarm(pod, {
      side: 'left',
      vibrationIntensity: 60,
      vibrationPattern: 'double',
      duration: 10,
      force: false,
    });
    expect(response.status).toBe(200);
    expect(pod.commands.some((c) => c.name === 'ALARM_LEFT')).toBe(false);
  });

  it('a non-forced trigger against an on, non-away side fires', async () => {
    const pod = await start({ state: { deviceStatus: { left: { secondsRemaining: 600 } } } });
    const response = await postAlarm(pod, {
      side: 'left',
      vibrationIntensity: 60,
      vibrationPattern: 'double',
      duration: 10,
      force: false,
    });
    expect(response.status).toBe(200);
    expect(pod.commands.some((c) => c.name === 'ALARM_LEFT')).toBe(true);
  });

  it('the request is always recorded, regardless of whether it was allowed to fire', async () => {
    const pod = await start({ state: { deviceStatus: { left: { secondsRemaining: 0 } } } });
    await postAlarm(pod, { side: 'left', vibrationIntensity: 60, vibrationPattern: 'double', duration: 10, force: false });
    expect(pod.requests.some((r) => r.path === '/api/alarm')).toBe(true);
  });

  it('an out-of-bounds request gives 400 naming the field', async () => {
    const pod = await start();
    const response = await postAlarm(pod, {
      side: 'left',
      vibrationIntensity: 0,
      vibrationPattern: 'double',
      duration: 10,
      force: true,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: unknown[] };
    expect(JSON.stringify(body.details)).toMatch(/vibrationIntensity/);
  });

  it('responds 200 with the current schedules document', async () => {
    const pod = await start();
    const response = await postAlarm(pod, {
      side: 'right',
      vibrationIntensity: 60,
      vibrationPattern: 'rise',
      duration: 10,
      force: true,
    });
    const body = await response.json();
    expect(body).toEqual(schedulesFixture);
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: priming-trigger field write semantics (6.4)
// ---------------------------------------------------------------------------------------

describe('priming-trigger field write semantics (6.4)', () => {
  it('a false priming-trigger field changes nothing and records no priming-related command', async () => {
    const pod = await start({ state: { deviceStatus: { isPriming: true } } });
    const response = await postDeviceStatus(pod, { isPriming: false });
    expect(response.status).toBe(204);
    const after = await fetch(`${pod.url}/api/deviceStatus`).then((r) => r.json()) as { isPriming: boolean };
    expect(after.isPriming).toBe(true); // an in-progress prime is not stopped
    expect(pod.commands.some((c) => c.name === 'PRIME')).toBe(false);
  });

  it('a true priming-trigger field starts a prime', async () => {
    const pod = await start();
    const response = await postDeviceStatus(pod, { isPriming: true });
    expect(response.status).toBe(204);
    expect(pod.commands.some((c) => c.name === 'PRIME')).toBe(true);
  });
});
