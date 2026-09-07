import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { PodClient } from '../src/pod/client.js';
import {
  PodAbortError,
  PodBadRequestError,
  PodHttpError,
  PodNetworkError,
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

/**
 * A raw `node:http` server whose response only goes out once the test calls `release()` —
 * gives full deterministic control over when the physical request settles, needed to prove
 * the two S1 directions below without racing on real timing.
 */
async function listeningGatedServer(): Promise<{
  port: number;
  requestCount: () => number;
  release: () => void;
  close: () => Promise<void>;
}> {
  let requestCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer((_req, res) => {
    requestCount += 1;
    void gate.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(deviceStatusFixture));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    requestCount: () => requestCount,
    release: () => release(),
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('GET dedupe does not couple caller aborts (S1)', () => {
  it('caller A aborting rejects only caller A, never a caller B deduped onto the same in-flight GET', async () => {
    const gated = await listeningGatedServer();
    const client = new PodClient({ host: '127.0.0.1', port: gated.port, timeoutMs: 5000 });
    try {
      const controllerA = new AbortController();
      const promiseA = client.getDeviceStatus(controllerA.signal);
      const promiseB = client.getDeviceStatus(); // dedupes onto the same in-flight GET

      controllerA.abort();
      await expect(promiseA).rejects.toBeInstanceOf(PodAbortError);

      gated.release();
      await expect(promiseB).resolves.toEqual(deviceStatusFixture);
      expect(gated.requestCount()).toBe(1);
    } finally {
      await gated.close();
    }
  });

  it('a caller whose signal is already aborted rejects immediately, while the shared request still proceeds for a concurrent caller', async () => {
    const gated = await listeningGatedServer();
    const client = new PodClient({ host: '127.0.0.1', port: gated.port, timeoutMs: 5000 });
    try {
      const controller = new AbortController();
      controller.abort();

      const aborted = client.getDeviceStatus(controller.signal);
      const other = client.getDeviceStatus(); // dedupes onto the same physical request

      await expect(aborted).rejects.toBeInstanceOf(PodAbortError);

      gated.release();
      await expect(other).resolves.toEqual(deviceStatusFixture);
      // Proves the physical request went out despite the pre-aborted caller.
      expect(gated.requestCount()).toBe(1);
    } finally {
      await gated.close();
    }
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
    await expect(client.getDeviceStatus()).rejects.toThrow(PodHttpError);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('a timeout that fires mid-body-read (after headers arrive) is PodTimeoutError, and retries', async () => {
    const pod = await start();
    // Headers and a partial, deliberately unterminated body chunk go out, then the response
    // stalls — reproducing a timeout firing after `fetch()` has already resolved a `Response`,
    // while `response.text()` is still awaiting the rest of the body (B2 in the pod-client
    // code review).
    pod.fault('GET /api/deviceStatus', { kind: 'hangMidBody', times: 1 });
    const client = clientFor(pod, 150);
    const result = await client.getDeviceStatus();
    expect(result).toEqual(deviceStatusFixture);
    // One request timed out mid-body, one retry succeeded.
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  }, 10_000);

  it('a timeout mid-body-read that outlasts both attempts rejects with PodTimeoutError', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'hangMidBody', times: 2 });
    const client = clientFor(pod, 150);
    await expect(client.getDeviceStatus()).rejects.toThrow(PodTimeoutError);
  }, 10_000);

  it('a connection reset then success yields 2 requests', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 1 });
    const client = clientFor(pod);
    const result = await client.getDeviceStatus();
    expect(result).toEqual(deviceStatusFixture);
    expect(pod.requests.filter((r) => r.path === '/api/deviceStatus')).toHaveLength(2);
  });

  it('a connection reset on both attempts surfaces as PodNetworkError (S4)', async () => {
    const pod = await start();
    pod.fault('GET /api/deviceStatus', { kind: 'reset', times: 2 });
    const client = clientFor(pod);
    let caught: unknown;
    try {
      await client.getDeviceStatus();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PodNetworkError);
  });

  it('connecting to a closed port surfaces as PodNetworkError from a real client call (S4)', async () => {
    // A real `node:http` server, bound then immediately closed, so the port is guaranteed to
    // have nothing listening on it — an end-to-end reproduction that does not go through the
    // mock at all.
    const server = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const client = new PodClient({ host: '127.0.0.1', port: address.port, timeoutMs: 2000 });
    let caught: unknown;
    try {
      await client.getDeviceStatus();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PodNetworkError);
  });

  it('aborting a write during its retry backoff rejects promptly with PodAbortError (N2)', async () => {
    const pod = await start();
    // The first attempt fails with a retryable 500, putting the client into its ~500-700ms
    // backoff wait before the retry. Writes (unlike GETs) pass the caller's own signal
    // straight through to the transport, with no dedup layer in between — the right place to
    // prove the backoff sleep itself is abort-aware, not just the GET-dedupe race (S1).
    pod.fault('POST /api/deviceStatus', { kind: 'status', status: 500, times: 1 });
    const client = clientFor(pod);
    const controller = new AbortController();
    const promise = client.postDeviceStatus({ left: { targetTemperatureF: 70 } }, controller.signal);
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(promise).rejects.toThrow(PodAbortError);
    // Well under the ~500-700ms backoff window — proves the abort didn't have to wait out
    // the sleep before being observed.
    expect(Date.now() - started).toBeLessThan(300);
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

describe('presence and vitals reads (occupancy change, #19, tasks.md 3.1/3.2)', () => {
  it('getPresence resolves with the seeded fixture', async () => {
    const pod = await start();
    const client = clientFor(pod);
    expect(await client.getPresence()).toEqual(loadFixture('metricsPresence.json'));
  });

  it('getVitals with no filters returns rows for both sides and sends no query string', async () => {
    const pod = await start();
    const client = clientFor(pod);
    const result = await client.getVitals();
    expect(result).toEqual(loadFixture('metricsVitals.json'));
  });

  it('getVitals sends exactly the given filters as query params, omitting the rest', async () => {
    // `RecordedRequest.path` is the routing pathname only, with no query string (mockPod.ts) —
    // so the actual URL each call reached the transport with is captured directly off `fetch`
    // instead, the same technique the per-endpoint-serialisation tests above already use.
    const pod = await start();
    const client = clientFor(pod);
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      urls.push(String(args[0]));
      return realFetch(...args);
    }) as typeof fetch;

    try {
      await client.getVitals({ side: 'left' });
      await client.getVitals({ startTime: '2026-09-06T00:00:00Z', endTime: '2026-09-06T23:59:59Z' });
      await client.getVitals({ side: 'right', startTime: '2026-09-06T00:00:00Z', endTime: '2026-09-06T23:59:59Z' });
      await client.getVitals();
    } finally {
      globalThis.fetch = realFetch;
    }

    const searches = urls.map((u) => new URL(u).search);

    expect(new URLSearchParams(searches[0]).get('side')).toBe('left');
    expect(new URLSearchParams(searches[0]).has('startTime')).toBe(false);

    expect(new URLSearchParams(searches[1]).has('side')).toBe(false);
    expect(new URLSearchParams(searches[1]).get('startTime')).toBe('2026-09-06T00:00:00Z');
    expect(new URLSearchParams(searches[1]).get('endTime')).toBe('2026-09-06T23:59:59Z');

    expect(new URLSearchParams(searches[2]).get('side')).toBe('right');
    expect(new URLSearchParams(searches[2]).get('startTime')).toBe('2026-09-06T00:00:00Z');
    expect(new URLSearchParams(searches[2]).get('endTime')).toBe('2026-09-06T23:59:59Z');

    expect(searches[3]).toBe('');
  });

  it('the client offers no write to either endpoint', async () => {
    const client = new (await import('../src/pod/client.js')).PodClient({ host: '127.0.0.1' });
    expect((client as unknown as Record<string, unknown>).postPresence).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).postVitals).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// B1 regression: the per-endpoint serialisation map must not grow with the query string
// ---------------------------------------------------------------------------------------

describe('B1: the serialisation chain map is keyed on path only, never the query string', () => {
  /** Reaches into `PodClient`'s private `chains` map — the same "cast to a plain record" style
   * already used above for `postPresence`/`postVitals` — because the leak this test guards
   * against is only observable from inside that map, not from any public return value. */
  function chainsSizeOf(client: PodClient): number {
    const chains = (client as unknown as { chains: Map<string, unknown> }).chains;
    return chains.size;
  }

  it('N sequential getVitals calls with an ever-advancing rolling window leave exactly one chains entry', async () => {
    const pod = await start();
    const client = clientFor(pod);

    // Mirrors the poller's own vitals class: a fixed path, but a `startTime`/`endTime` query
    // that advances on every call — before B1's fix, each distinct query string minted its own
    // permanent `chains` entry (26 entries after 25 polls in the reviewer's reproduction; at a
    // 60s vitals cadence that is ~525k leaked entries a year), because the map was keyed on the
    // full `pathname` (query included) rather than the path alone.
    for (let i = 0; i < 25; i++) {
      const now = Date.parse('2026-09-06T00:00:00Z') + i * 60_000;
      await client.getVitals({
        startTime: new Date(now - 180_000).toISOString(),
        endTime: new Date(now).toISOString(),
      });
    }

    expect(chainsSizeOf(client)).toBe(1);
  });

  it('a GET and a POST to different paths still get their own independent chain entries', async () => {
    const pod = await start();
    const client = clientFor(pod);

    await client.getDeviceStatus();
    await client.getVitals({ side: 'left' });
    await client.getVitals({ side: 'right' }); // same path, different query — still one entry
    await client.postDeviceStatus({ left: { isOn: true } });

    // 3 distinct `${method} ${path}` pairs: `GET /api/deviceStatus`, `GET /api/metrics/vitals`,
    // `POST /api/deviceStatus` — not 4, which is what the pre-fix, query-inclusive key would
    // have produced for the two differently-queried `getVitals` calls.
    expect(chainsSizeOf(client)).toBe(3);
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
