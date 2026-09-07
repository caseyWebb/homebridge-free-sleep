/**
 * A fully in-process, controllable stand-in for `PodClient`, used by `poller.test.ts` and
 * `writeQueue.test.ts` for tests about *scheduling* and *dispatch* logic — jitter arithmetic,
 * backoff cadence, mode stacking, mutex ordering — where going over a real socket to
 * `startMockPod()` would add nothing but the real `PodClient`'s own internal retry-on-5xx
 * timing (a real, un-fakeable ~500-700ms backoff; see `src/pod/client.ts`,
 * `RETRY_BASE_DELAY_MS`) to every test that wants a controlled failure.
 *
 * Tests that are specifically about real request/response shape or the actual HTTP mock
 * (pod-poller spec's request-budget guardrail, the `#10` mock-as-oracle proof, the mutex's
 * true non-overlap over a real socket) still use `startMockPod()` + a real `PodClient`
 * directly — this file is only for the pure-logic half of the suite.
 */

import type { PodClient } from '../src/pod/client.ts';
import type {
  DeviceStatus,
  DeviceStatusPatch,
  PresenceData,
  Schedules,
  Services,
  Settings,
  SettingsPatch,
  VitalsResponse,
} from '../src/pod/types.ts';

type Outcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'hang' }
  | { kind: 'deferred'; promise: Promise<T> };

export interface DeferredControl<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

class FakeEndpoint<T> {
  calls = 0;
  private queue: Outcome<T>[] = [];
  private fallback: Outcome<T> | null = null;

  queueValue(value: T): void {
    this.queue.push({ kind: 'value', value });
  }

  queueError(error: unknown): void {
    this.queue.push({ kind: 'error', error });
  }

  /** Never settles on its own — only via the request's `AbortSignal` firing (i.e. `stop()`). */
  queueHang(): void {
    this.queue.push({ kind: 'hang' });
  }

  /** Settles only when the returned controls are invoked — full manual control of timing. */
  queueDeferred(): DeferredControl<T> {
    let resolveFn!: (value: T) => void;
    let rejectFn!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.queue.push({ kind: 'deferred', promise });
    return { resolve: resolveFn, reject: rejectFn };
  }

  setFallback(value: T): void {
    this.fallback = { kind: 'value', value };
  }

  /** Drops every queued outcome not yet consumed — the next call falls through to the fallback. */
  clearQueue(): void {
    this.queue = [];
  }

  async run(signal?: AbortSignal): Promise<T> {
    this.calls += 1;
    const outcome = this.queue.shift() ?? this.fallback;
    if (!outcome) {
      throw new Error('FakeEndpoint: no outcome queued and no fallback set');
    }
    if (outcome.kind === 'hang') {
      return new Promise<T>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('fake endpoint aborted')), { once: true });
      });
    }
    if (outcome.kind === 'deferred') {
      return outcome.promise;
    }
    if (outcome.kind === 'error') {
      throw outcome.error;
    }
    return outcome.value;
  }
}

export interface FakePodClient {
  client: PodClient;
  deviceStatus: FakeEndpoint<DeviceStatus>;
  settings: FakeEndpoint<Settings>;
  schedules: FakeEndpoint<Schedules>;
  services: FakeEndpoint<Services>;
  /** Occupancy change (#19). */
  presence: FakeEndpoint<PresenceData>;
  /** Occupancy change (#19). */
  vitals: FakeEndpoint<VitalsResponse>;
  postDeviceStatusCalls: DeviceStatusPatch[];
  postSettingsCalls: SettingsPatch[];
  postDeviceStatusOutcome: { kind: 'success' } | { kind: 'error'; error: unknown };
  postSettingsOutcome: { kind: 'success' } | { kind: 'error'; error: unknown };
  /** Every `getVitals` call's query, recorded in order (occupancy change, #19). */
  vitalsQueries: Array<{ side?: string; startTime?: string; endTime?: string }>;
}

export interface FakePodClientFixtures {
  deviceStatus: DeviceStatus;
  settings: Settings;
  schedules: Schedules;
  services: Services;
  /** Occupancy change (#19). Optional — most tests don't exercise these classes. */
  presence?: PresenceData;
  /** Occupancy change (#19). Optional — most tests don't exercise these classes. */
  vitals?: VitalsResponse;
}

export function createFakePodClient(fixtures: FakePodClientFixtures): FakePodClient {
  const deviceStatus = new FakeEndpoint<DeviceStatus>();
  const settings = new FakeEndpoint<Settings>();
  const schedules = new FakeEndpoint<Schedules>();
  const services = new FakeEndpoint<Services>();
  const presence = new FakeEndpoint<PresenceData>();
  const vitals = new FakeEndpoint<VitalsResponse>();
  deviceStatus.setFallback(fixtures.deviceStatus);
  settings.setFallback(fixtures.settings);
  schedules.setFallback(fixtures.schedules);
  services.setFallback(fixtures.services);
  if (fixtures.presence !== undefined) presence.setFallback(fixtures.presence);
  if (fixtures.vitals !== undefined) vitals.setFallback(fixtures.vitals);

  const postDeviceStatusCalls: DeviceStatusPatch[] = [];
  const postSettingsCalls: SettingsPatch[] = [];
  const vitalsQueries: Array<{ side?: string; startTime?: string; endTime?: string }> = [];
  const state: FakePodClient = {
    client: undefined as unknown as PodClient,
    deviceStatus,
    settings,
    schedules,
    services,
    presence,
    vitals,
    postDeviceStatusCalls,
    postSettingsCalls,
    postDeviceStatusOutcome: { kind: 'success' },
    postSettingsOutcome: { kind: 'success' },
    vitalsQueries,
  };

  const client = {
    getDeviceStatus: (signal?: AbortSignal) => deviceStatus.run(signal),
    getSettings: (signal?: AbortSignal) => settings.run(signal),
    getSchedules: (signal?: AbortSignal) => schedules.run(signal),
    getServices: (signal?: AbortSignal) => services.run(signal),
    getPresence: (signal?: AbortSignal) => presence.run(signal),
    getVitals: (query?: { side?: string; startTime?: string; endTime?: string }, signal?: AbortSignal) => {
      vitalsQueries.push(query ?? {});
      return vitals.run(signal);
    },
    postDeviceStatus: async (patch: DeviceStatusPatch) => {
      postDeviceStatusCalls.push(patch);
      if (state.postDeviceStatusOutcome.kind === 'error') throw state.postDeviceStatusOutcome.error;
    },
    postSettings: async (patch: SettingsPatch) => {
      postSettingsCalls.push(patch);
      if (state.postSettingsOutcome.kind === 'error') throw state.postSettingsOutcome.error;
    },
  } as unknown as PodClient;

  state.client = client;
  return state;
}
