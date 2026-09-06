import { afterEach, describe, expect, it } from 'vitest';

import { main, parseHostArg } from '../scripts/smoke.js';
import { startMockPod, type MockPod } from './mockPod.js';

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

/**
 * N7 in the pod-client code review: a regression test for the smoke script's headline claim
 * ("performs zero writes of any kind") — the read-only design has never actually been
 * exercised by the suite before this.
 */
describe('smoke script is read-only (N7)', () => {
  it('every request it issues against a mock Pod is a GET', async () => {
    const pod = await start();
    const { hostname, port } = new URL(pod.url);

    const exitCode = await main(['node', 'scripts/smoke.ts', `${hostname}:${port}`]);

    expect(exitCode).toBe(0);
    expect(pod.requests.length).toBeGreaterThan(0);
    expect(pod.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('prints a usage message and returns 1 when no host argument is given', async () => {
    const exitCode = await main(['node', 'scripts/smoke.ts']);
    expect(exitCode).toBe(1);
  });
});

/**
 * N6 in the pod-client code review: `parseHostArg` split `<host>:<port>` on the *last*
 * colon, which mis-parses a bare IPv6 literal — itself full of colons — as `host:port`.
 */
describe('parseHostArg handles IPv6 literals (N6)', () => {
  it('parses bracketed IPv6 with a port', () => {
    expect(parseHostArg('[::1]:3000')).toEqual({ host: '::1', port: 3000 });
  });

  it('parses bracketed IPv6 with no port', () => {
    expect(parseHostArg('[::1]')).toEqual({ host: '::1' });
  });

  it('parses a bracketed full IPv6 address with a port', () => {
    expect(parseHostArg('[2001:db8::1]:3000')).toEqual({ host: '2001:db8::1', port: 3000 });
  });

  it('treats a bare (unbracketed) IPv6 literal as host-only, never splitting off a port', () => {
    expect(parseHostArg('::1')).toEqual({ host: '::1' });
    expect(parseHostArg('2001:db8::1')).toEqual({ host: '2001:db8::1' });
  });

  it('still splits an ordinary host:port', () => {
    expect(parseHostArg('192.168.1.42:3000')).toEqual({ host: '192.168.1.42', port: 3000 });
  });

  it('still treats a bare hostname with no colon as host-only', () => {
    expect(parseHostArg('pod.local')).toEqual({ host: 'pod.local' });
  });
});
