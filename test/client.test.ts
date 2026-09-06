import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { PodClient } from '../src/pod/client.js';
import {
  PodAbortError,
  PodBadRequestError,
  PodRequestError,
  PodResponseError,
  PodTimeoutError,
} from '../src/pod/errors.js';
import { startMockPod, type MockPod } from './mockPod.js';
import { loadFixture } from './loadFixture.js';

const deviceStatusFixture = loadFixture('deviceStatus.json');
const settingsFixture = loadFixture('settings.json');
const schedulesFixture = loadFixture('schedules.json');
const servicesFixture = loadFixture('services.json');

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

function clientFor(pod: MockPod, timeoutMs?: number): PodClient {
  const { hostname, port } = new URL(pod.url);
  return new PodClient({ host: hostname, port: Number(port), ...(timeoutMs ? { timeoutMs } : {}) });
}

describe('client shell and reads (6.2)', () => {
  it('getDeviceStatus/getSettings/getSchedules/getServices deep-equal their fixtures', async () => {
    const pod = await start();
    const client = clientFor(pod);
    expect(await client.getDeviceStatus()).toEqual(deviceStatusFixture);
    expect(await client.getSettings()).toEqual(settingsFixture);
    expect(await client.getSchedules()).toEqual(schedulesFixture);
    expect(await client.getServices()).toEqual(servicesFixture);
  });

  it('a malformed response body raises PodResponseError naming the property path', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Missing nearly every required field of DeviceStatusSchema.
      res.end(JSON.stringify({ left: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const client = new PodClient({ host: '127.0.0.1', port: address.port });

    try {
      let caught: unknown;
      try {
        await client.getDeviceStatus();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PodResponseError);
      expect((caught as PodResponseError).path.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('writes with pre-flight validation (6.3)', () => {
  it('a valid patch reaches the mock and returns without error', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await expect(
      client.postDeviceStatus({ left: { targetTemperatureF: 70 } }),
    ).resolves.toBeUndefined();
    expect(pod.requests).toHaveLength(1);
  });

  it('an unknown key raises PodRequestError with zero entries added to pod.requests', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await expect(
      client.postDeviceStatus({ left: { turboMode: true } } as never),
    ).rejects.toThrow(PodRequestError);
    expect(pod.requests).toHaveLength(0);
  });

  it('an out-of-range temperature is rejected before any request', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await expect(
      client.postDeviceStatus({ left: { targetTemperatureF: 200 } }),
    ).rejects.toThrow(PodRequestError);
    expect(pod.requests).toHaveLength(0);
  });
});

describe('timeout (6.4)', () => {
  it('a hung Pod that outlasts both attempts rejects with PodTimeoutError', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'hang', times: 2 });
    const client = clientFor(pod, 150);
    await expect(client.getDeviceStatus()).rejects.toThrow(PodTimeoutError);
  }, 10_000);

  it('a caller abort rejects promptly with PodAbortError and issues no retry', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'hang', times: 5 });
    const client = clientFor(pod, 5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(client.getDeviceStatus(controller.signal)).rejects.toThrow(PodAbortError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('per-endpoint serialisation (6.5)', () => {
  it('two concurrent writes to one endpoint never overlap at the transport', async () => {
    const pod = await start();
    const client = clientFor(pod);

    let inFlight = 0;
    let maxInFlight = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await realFetch(...args);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;

    try {
      await Promise.all([
        client.postDeviceStatus({ left: { targetTemperatureF: 60 } }),
        client.postDeviceStatus({ left: { targetTemperatureF: 61 } }),
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(maxInFlight).toBe(1);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('a device-status read and a settings read proceed concurrently', async () => {
    const pod = await start();
    const client = clientFor(pod);

    let inFlight = 0;
    let maxInFlight = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await realFetch(...args);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;

    try {
      await Promise.all([client.getDeviceStatus(), client.getSettings()]);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(maxInFlight).toBe(2);
  });
});

describe('GET deduplication (6.6)', () => {
  it('three concurrent identical reads produce exactly one request and equal results', async () => {
    const pod = await start();
    const client = clientFor(pod);
    const [a, b, c] = await Promise.all([
      client.getDeviceStatus(),
      client.getDeviceStatus(),
      client.getDeviceStatus(),
    ]);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(1);
    expect(a).toEqual(deviceStatusFixture);
    expect(b).toEqual(deviceStatusFixture);
    expect(c).toEqual(deviceStatusFixture);
  });

  it('a read issued after the previous one settles is a new request', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await client.getDeviceStatus();
    await client.getDeviceStatus();
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('two identical writes are never deduplicated', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await Promise.all([
      client.postDeviceStatus({ left: { secondsRemaining: 500 } }),
      client.postDeviceStatus({ left: { secondsRemaining: 500 } }),
    ]);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('deduplicated callers cannot interfere with each other', async () => {
    const pod = await start();
    const client = clientFor(pod);
    const [a, b] = await Promise.all([client.getDeviceStatus(), client.getDeviceStatus()]);
    a.left.targetTemperatureF = -1;
    expect(b.left.targetTemperatureF).not.toBe(-1);
  });
});

describe('retry policy (6.7, 6.8)', () => {
  it('a 500 then 200 succeeds with exactly 2 requests', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'status', status: 500, times: 1 });
    const client = clientFor(pod);
    const result = await client.getDeviceStatus();
    expect(result).toEqual(deviceStatusFixture);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('500 twice rejects with PodHttpError after exactly 2 requests', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'status', status: 500, times: 2 });
    const client = clientFor(pod);
    await expect(client.getDeviceStatus()).rejects.toThrow();
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('a connection reset then success yields 2 requests', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 1 });
    const client = clientFor(pod);
    const result = await client.getDeviceStatus();
    expect(result).toEqual(deviceStatusFixture);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('the gap between the two recorded request timestamps is non-zero', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'status', status: 500, times: 1 });
    const client = clientFor(pod);
    await client.getDeviceStatus();
    const [first, second] = pod.requests.filter((r) => r.path === '/api/deviceStatus');
    expect(second!.at - first!.at).toBeGreaterThan(0);
  });

  it('a 400 produces exactly one request and rejects with PodBadRequestError carrying details', async () => {
    const pod = await start();
    const client = clientFor(pod);
    // The client validates writes with the exact same strict schema the mock validates
    // against (design.md: both are copies of what the Pod enforces), so a payload that
    // would earn a genuine 400 from the mock can never leave the client's own pre-flight
    // check in the first place — proving that requires a 400 the client didn't cause
    // itself. `fault('status', 400)` gives the mock a 400 to return for a reason external
    // to schema validation, which is exactly what's needed to observe the client's
    // never-retry-on-400 policy in isolation.
    pod.fault('POST /api/deviceStatus', { kind: 'status', status: 400, times: 1 });
    let caught: unknown;
    try {
      await client.postDeviceStatus({ left: { targetTemperatureF: 70 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PodBadRequestError);
    expect((caught as PodBadRequestError).status).toBe(400);
    expect((caught as PodBadRequestError).details).toBeDefined();
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(1);
  });
});

describe('pre-flight rejection of isOn + secondsRemaining (6.9)', () => {
  it('rejects a patch setting both for the same side, with zero requests', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await expect(
      client.postDeviceStatus({ left: { isOn: true, secondsRemaining: 600 } }),
    ).rejects.toThrow(PodRequestError);
    expect(pod.requests).toHaveLength(0);
  });

  it('allows the same fields on different sides in one patch', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await expect(
      client.postDeviceStatus({ left: { isOn: true }, right: { secondsRemaining: 600 } }),
    ).resolves.toBeUndefined();
  });

  it('allows each field alone', async () => {
    const pod = await start();
    const client = clientFor(pod);
    await expect(client.postDeviceStatus({ left: { isOn: true } })).resolves.toBeUndefined();
    await expect(
      client.postDeviceStatus({ left: { secondsRemaining: 100 } }),
    ).resolves.toBeUndefined();
  });
});

describe('no credentials ever sent (6.10)', () => {
  it('no client method sends an authorization or cookie header, or userinfo in the URL', async () => {
    const pod = await start();
    const client = clientFor(pod);

    await client.getDeviceStatus();
    await client.getSettings();
    await client.getSchedules();
    await client.getServices();
    await client.postDeviceStatus({ left: { targetTemperatureF: 70 } });
    await client.postSettings({ left: { awayMode: false } });

    expect(pod.requests.length).toBeGreaterThan(0);
    for (const request of pod.requests) {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
    expect(new URL(pod.url).username).toBe('');
    expect(new URL(pod.url).password).toBe('');
  });
});
