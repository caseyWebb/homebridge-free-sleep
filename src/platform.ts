/**
 * `FreeSleepPlatform` — the `DynamicPlatformPlugin` that publishes and maintains the
 * plugin's bridged HomeKit accessories (design.md, "Restore flow").
 *
 * Every side accessory carries a `Thermostat`; the hub carries the "Pod Connection"
 * `ContactSensor` (`thermostat-and-offline`, specs/platform/spec.md). This module owns:
 * stable UUID/SerialNumber derivation from the *configured* host, `configureAccessory`
 * restore with prune-on-restore, unregistering the unused side when `sides !== 'both'`,
 * one-time display-name seeding from `GET /api/settings`, the bail-without-host startup
 * guard, and — new in this change — constructing and owning the snapshot store, poller and
 * write queue for the whole platform's lifetime, bootstrapping before any HAP handler is
 * registered, routing snapshot change events to the services that publish them, and stopping
 * everything on Homebridge shutdown (design.md, "Platform wiring").
 *
 * Per docs/HOMEKIT.md's Homebridge 2.x API notes: HAP **types** come from `homebridge`;
 * runtime enums/classes always come from `api.hap`, never a direct `@homebridge/hap-nodejs`
 * import (that stays devDependency-only, for tests).
 */

import { createRequire } from 'node:module';

import type {
  API,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { FreeSleepConfigSchema, unrecognizedConfigKeys, type FreeSleepConfig } from './config.ts';
import type {
  DeviceStatus,
  DeviceStatusPatch,
  Schedules,
  Services as PodServices,
  Settings,
  SettingsPatch,
  Side,
} from './pod/types.ts';
import { DEFAULT_TIMEOUT_MS, PodClient, RETRY_BASE_DELAY_MS, RETRY_JITTER_MS } from './pod/client.ts';
import { PodPoller } from './pod/poller.ts';
import { defaultTimerApi, SnapshotStore, type Change, type TimerApi } from './pod/snapshot.ts';
import { WriteQueue } from './pod/writeQueue.ts';
import { CONNECTION_SUBTYPE, ConnectionService } from './services/connection.ts';
import { isThermostatChange, THERMOSTAT_SUBTYPE, ThermostatService } from './services/thermostat.ts';
import type { ServiceContext } from './services/types.ts';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.ts';

const require = createRequire(import.meta.url);
/** This package's own version — see design.md's AccessoryInformation table, `FirmwareRevision`. */
const packageJson = require('../package.json') as { version: string };

export type Role = 'left' | 'right' | 'hub';

/** Base interval a write-triggered fast-poll window runs at — matches `PodPoller`'s own
 * `fastPollIntervalMs` default (`src/pod/poller.ts`), duplicated here rather than imported
 * because nothing in `poller.ts` exports it; kept in sync by `pollIntervals.fastPollIntervalMs`
 * overriding both call sites identically when configured. */
const DEFAULT_FAST_POLL_INTERVAL_MS = 5000;

/**
 * The subset of `PodClient`'s public interface this change calls — now the full read/write
 * surface, since `thermostat-and-offline` shares this one injected client between the
 * one-time settings-name-seeding read, the poller, and the write queue (design.md's coupling
 * points: `PodPoller`/`WriteQueue` both take a concrete `PodClient`, so a fake satisfying this
 * structural shape is handed to them via `as unknown as PodClient` — the same escape hatch
 * `test/fakePodClient.ts` already uses). A hand-written fake satisfying just this shape stands
 * in for the real client in tests (design.md, "Testability without a paired Home app") — no
 * dependency on `pod-client`'s own mock Pod, since nothing here needs real transport behavior.
 */
export interface MinimalPodClient {
  getDeviceStatus(signal?: AbortSignal): Promise<DeviceStatus>;
  getSettings(signal?: AbortSignal): Promise<Settings>;
  getSchedules(signal?: AbortSignal): Promise<Schedules>;
  getServices(signal?: AbortSignal): Promise<PodServices>;
  postDeviceStatus(patch: DeviceStatusPatch, signal?: AbortSignal): Promise<void>;
  postSettings(patch: SettingsPatch, signal?: AbortSignal): Promise<void>;
}

/**
 * Derived from `pod-client`'s own exported worst-case retry constants (design.md, "Timeout
 * budget") rather than a hand-picked number that can silently drift out of sync with them: two
 * full per-attempt timeouts (the first attempt, plus the one retry `pod-client` makes on a
 * network error, timeout, or 5xx) plus the worst-case backoff wait between them
 * (`RETRY_BASE_DELAY_MS + RETRY_JITTER_MS`), plus a small fixed margin so this budget is never
 * exactly equal to the client's own worst case. Bounding the wait here — rather than trusting
 * every possible `MinimalPodClient` implementation to always settle on its own — is what keeps
 * "startup is not blocked waiting indefinitely" true regardless of what the injected client
 * does.
 */
const SETTINGS_TIMEOUT_MARGIN_MS = 300;
export const SETTINGS_READ_TIMEOUT_MS =
  2 * DEFAULT_TIMEOUT_MS + RETRY_BASE_DELAY_MS + RETRY_JITTER_MS + SETTINGS_TIMEOUT_MARGIN_MS;

const FALLBACK_NAME: Record<'left' | 'right', string> = {
  left: 'Pod Left',
  right: 'Pod Right',
};

/** Exported for direct unit testing (tasks.md 4.1) as well as internal use below. */
export function seed(host: string, role: Role): string {
  return `${PLUGIN_NAME}:${host}:${role}`;
}

export function uuidFor(hap: HAP, host: string, role: Role): string {
  return hap.uuid.generate(seed(host, role));
}

export function serialNumberFor(host: string, role: Role): string {
  return `${host}:${role}`;
}

export function categoryFor(hap: HAP, role: Role) {
  return role === 'hub' ? hap.Categories.OTHER : hap.Categories.THERMOSTAT;
}

function rolesForSides(sides: FreeSleepConfig['sides']): Array<'left' | 'right'> {
  if (sides === 'both') return ['left', 'right'];
  return [sides];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WantedAccessory {
  role: Role;
  uuid: string;
}

/**
 * The currently-enabled non-`AccessoryInformation` services, per role, as
 * `${Service.UUID}:${subtype}` compound keys — side accessories enable the thermostat subtype,
 * the hub enables the connection-sensor subtype (tasks.md 1.2). Computed from `hap` rather than
 * a module-level constant, since the UUIDs come from `api.hap.Service.*`, never a direct
 * `@homebridge/hap-nodejs` import (docs/HOMEKIT.md). `pruneServices` below reads this and never
 * needs to change shape itself as more services are added (design.md, "Restore flow").
 */
function enabledServiceKeysFor(hap: HAP, role: Role): ReadonlySet<string> {
  if (role === 'hub') {
    return new Set([`${hap.Service.ContactSensor.UUID}:${CONNECTION_SUBTYPE}`]);
  }
  return new Set([`${hap.Service.Thermostat.UUID}:${THERMOSTAT_SUBTYPE}`]);
}

export class FreeSleepPlatform implements DynamicPlatformPlugin {
  private readonly cachedByUuid = new Map<string, PlatformAccessory>();
  private readonly config: FreeSleepConfig | undefined;
  private readonly podClient: MinimalPodClient | undefined;
  /**
   * Explicit fields rather than TS constructor parameter properties (N14 in the
   * platform-foundation code review): parameter properties are not pure type syntax — they
   * require the compiler to emit a `this.x = x` assignment — so they are not erasable, and
   * `scripts/smoke.ts` runs `src/` directly under `node --experimental-strip-types`, which only
   * strips types and cannot perform that emit.
   */
  private readonly log: Logging;
  private readonly api: API;

  /** Shared with the poller, the write queue and every service (design.md's `ServiceContext`). */
  private readonly timers: TimerApi;
  /** The escalation predicate's fallback `since` when the Pod has never been observed reachable
   * this launch (design.md, "No Response"). */
  private readonly platformStartedAt: number;

  /** Constructed once, only when `config` parses successfully (tasks.md 7.1). */
  private readonly snapshot: SnapshotStore | undefined;
  private readonly poller: PodPoller | undefined;
  private readonly writeQueue: WriteQueue | undefined;
  private unsubscribeSnapshot: (() => void) | undefined;

  private readonly thermostats = new Map<Side, ThermostatService>();
  private connectionService: ConnectionService | undefined;

  constructor(
    log: Logging,
    rawConfig: PlatformConfig,
    api: API,
    podClient?: MinimalPodClient,
    timers?: TimerApi,
  ) {
    this.log = log;
    this.api = api;
    this.timers = timers ?? defaultTimerApi;
    this.platformStartedAt = this.timers.now();

    for (const key of unrecognizedConfigKeys(rawConfig as unknown as Record<string, unknown>)) {
      this.log.warn(
        `FreeSleep: unrecognized config key '${key}' will be ignored. Check config.json for a typo.`,
      );
    }

    const parsed = FreeSleepConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      this.log.error(
        `FreeSleep: invalid configuration (${issues}). The platform will not start until this ` +
          'is fixed in config.json.',
      );
      return;
    }

    this.config = parsed.data;
    const client = podClient ?? new PodClient({ host: parsed.data.host });
    this.podClient = client;

    // One cached-snapshot store, one poller and one write queue per launch, shared across
    // every accessory and service (specs/platform/spec.md, tasks.md 7.1). `client` satisfies
    // `MinimalPodClient`'s structural shape, which is a strict subset of `PodClient`'s public
    // surface — the `as unknown as PodClient` cast is the same escape hatch
    // `test/fakePodClient.ts` already uses to hand a fake into these two, which both declare
    // `client: PodClient` (a concrete class, not an interface).
    const snapshot = new SnapshotStore({ timers: this.timers });
    this.snapshot = snapshot;

    const pollOptions = parsed.data.pollIntervals;
    const poller = new PodPoller({
      client: client as unknown as PodClient,
      snapshot,
      timers: this.timers,
      ...(pollOptions.pollIntervalMs !== undefined ? { pollIntervalMs: pollOptions.pollIntervalMs } : {}),
      ...(pollOptions.slowPollIntervalMs !== undefined ? { slowPollIntervalMs: pollOptions.slowPollIntervalMs } : {}),
      ...(pollOptions.fastPollIntervalMs !== undefined ? { fastPollIntervalMs: pollOptions.fastPollIntervalMs } : {}),
      ...(pollOptions.maxBackoffMs !== undefined ? { maxBackoffMs: pollOptions.maxBackoffMs } : {}),
      ...(pollOptions.bootstrapTimeoutMs !== undefined ? { bootstrapTimeoutMs: pollOptions.bootstrapTimeoutMs } : {}),
    });
    this.poller = poller;

    const fastPollIntervalMs = pollOptions.fastPollIntervalMs ?? DEFAULT_FAST_POLL_INTERVAL_MS;
    const writeQueue = new WriteQueue({
      client: client as unknown as PodClient,
      snapshot,
      // `left`/`right` writes accelerate deviceStatus polling for a confirming read; a
      // `settings` write (unused by this change) is confirmed by a single re-read instead
      // (design.md's coupling points; `pod-write-queue`'s own module doc).
      requestFastPoll: (lane, untilMs) => {
        if (lane === 'deviceStatus') {
          poller.requestMode('deviceStatus', { intervalMs: fastPollIntervalMs, untilMs, reason: 'write' });
        } else {
          void poller.refresh('settings');
        }
      },
      timers: this.timers,
      ...(pollOptions.writeDebounceMs !== undefined ? { writeDebounceMs: pollOptions.writeDebounceMs } : {}),
      ...(pollOptions.writeMaxDebounceMs !== undefined ? { writeMaxDebounceMs: pollOptions.writeMaxDebounceMs } : {}),
      writeSettleMs: parsed.data.writeSettleMs,
      ...(pollOptions.fastPollDurationMs !== undefined ? { fastPollDurationMs: pollOptions.fastPollDurationMs } : {}),
    });
    this.writeQueue = writeQueue;

    // Subscribed exactly once (specs/platform/spec.md, tasks.md 7.3); each service call is
    // individually wrapped so one throwing service does not stop the others from being
    // notified.
    this.unsubscribeSnapshot = snapshot.subscribe((changes) => this.handleSnapshotChanges(changes));

    this.api.on('didFinishLaunching', () => {
      return this.discoverAccessories().catch((error: unknown) => {
        this.log.error(`FreeSleep: unexpected error during accessory discovery: ${describeError(error)}`);
      });
    });

    // Stop polling, stop the write path, and drop the snapshot subscription — no pending
    // timer, no in-flight work that could still touch HomeKit (specs/platform/spec.md,
    // tasks.md 7.4).
    this.api.on('shutdown', () => {
      this.poller?.stop();
      this.writeQueue?.stop();
      this.unsubscribeSnapshot?.();
      this.unsubscribeSnapshot = undefined;
    });
  }

  /** Homebridge calls this once per cached accessory, before `didFinishLaunching` fires. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedByUuid.set(accessory.UUID, accessory);
  }

  private handleSnapshotChanges(changes: readonly Change[]): void {
    for (const change of changes) {
      try {
        if (isThermostatChange(change)) {
          this.thermostats.get(change.side)?.refresh();
        } else if (change.scope === 'device' && change.field === 'connectionOnline') {
          this.connectionService?.refresh();
        }
        // isAlarmVibrating, awayMode, waterLevelState, isPriming: no published service watches
        // these fields yet — ignored, without error (design.md's routing table; #13/#16/#19/#20).
      } catch (error) {
        this.log.warn(`FreeSleep: a service failed to handle a snapshot change: ${describeError(error)}`);
      }
    }
  }

  private serviceContextFor(accessory: PlatformAccessory): ServiceContext | undefined {
    if (!this.config || !this.snapshot || !this.writeQueue) return undefined;
    return {
      api: this.api,
      log: this.log,
      accessory,
      snapshot: this.snapshot,
      writeQueue: this.writeQueue,
      timers: this.timers,
      config: this.config,
    };
  }

  /** Adds (or restores, via each service's own `getServiceById`) the service(s) `role` enables
   * on `accessory` — a thermostat for a side, the connection sensor for the hub. Called only
   * after the poller's bootstrap has settled (tasks.md 7.2), so the very first `onGet` a
   * controller makes already has real data. */
  private constructServicesFor(role: Role, accessory: PlatformAccessory): void {
    const ctx = this.serviceContextFor(accessory);
    if (!ctx) return;
    if (role === 'hub') {
      this.connectionService = new ConnectionService(ctx);
    } else {
      this.thermostats.set(role, new ThermostatService(ctx, role, this.platformStartedAt));
    }
  }

  private async discoverAccessories(): Promise<void> {
    const config = this.config;
    if (!config) return;

    const hap = this.api.hap;
    const host = config.host;

    const wanted: WantedAccessory[] = [
      ...rolesForSides(config.sides).map((role) => ({ role, uuid: uuidFor(hap, host, role) })),
      { role: 'hub' as const, uuid: uuidFor(hap, host, 'hub') },
    ];
    const wantedUuids = new Set(wanted.map((w) => w.uuid));

    // Prune: unregister any cached accessory not in the wanted set (sides narrowed).
    const toUnregister = [...this.cachedByUuid.values()].filter((a) => !wantedUuids.has(a.UUID));
    if (toUnregister.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toUnregister);
      for (const accessory of toUnregister) {
        this.cachedByUuid.delete(accessory.UUID);
      }
    }

    // Kicked off now rather than awaited immediately: the bootstrap read is independent of the
    // one-time name-seeding read below, and overlapping the two bounded waits keeps a
    // fully-unreachable-Pod worst case bounded by whichever budget is larger, not their sum.
    // Still settled — per specs/platform/spec.md — before any service (and so any HAP handler)
    // is constructed, a few lines below.
    const bootstrapSettled = this.poller?.bootstrap() ?? Promise.resolve();

    const needsSettings = wanted.some((w) => w.role !== 'hub' && !this.cachedByUuid.has(w.uuid));
    const settings = needsSettings ? await this.tryReadSettings() : undefined;

    interface Planned {
      role: Role;
      accessory: PlatformAccessory;
    }
    const planned: Planned[] = [];
    const newAccessories: PlatformAccessory[] = [];
    for (const w of wanted) {
      const existing = this.cachedByUuid.get(w.uuid);
      if (existing) {
        // F2: a restored accessory carries Homebridge's own placeholder FirmwareRevision
        // ('0', stamped by bridgeService.js immediately before configureAccessory is called)
        // until something overwrites it — re-apply AccessoryInformation on every restart so it
        // never sticks at that placeholder forever.
        this.setAccessoryInformation(existing, host, w.role);
        const pruned = this.pruneServices(existing, w.role);
        if (pruned) {
          // F4: persist the prune so it survives an unclean shutdown (one that never reaches
          // Homebridge's normal cached-accessories flush). Only when something actually
          // changed — an update call on every restart, even a no-op one, is a gratuitous disk
          // write.
          this.api.updatePlatformAccessories([existing]);
        }
        planned.push({ role: w.role, accessory: existing });
        continue;
      }

      // F1: one bad accessory must not discard the whole batch — the constructor's
      // `didFinishLaunching` handler only logs-and-swallows at the top level, so without a
      // per-accessory boundary here, a single throw (e.g. an hap-nodejs assertion on a bad
      // display name) would abort discovery before any accessory registers.
      try {
        const name = this.nameFor(w.role, settings);
        const accessory = new this.api.platformAccessory(name, w.uuid, categoryFor(hap, w.role));
        this.setAccessoryInformation(accessory, host, w.role);
        this.cachedByUuid.set(w.uuid, accessory);
        planned.push({ role: w.role, accessory });
        newAccessories.push(accessory);
      } catch (error) {
        this.log.error(
          `FreeSleep: failed to create the '${w.role}' accessory (${describeError(error)}); ` +
            'continuing with the remaining accessories.',
        );
      }
    }

    // Bootstrap before wiring any handler (specs/platform/spec.md; design.md, "Platform
    // wiring"). A bootstrap that fails or times out still resolves — `PodPoller.bootstrap()`
    // races every enabled class against its own deadline — so this never blocks publishing.
    await bootstrapSettled;

    // Construct services after the bootstrap settles and before `registerPlatformAccessories`
    // — every `setProps` call inside a service's constructor must happen before the accessory
    // is published (tasks.md 2.3).
    for (const p of planned) {
      this.constructServicesFor(p.role, p.accessory);
    }

    if (newAccessories.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
    }
  }

  /**
   * F1: `GET /api/settings` can legitimately return an empty (or whitespace-only) `name` —
   * `SideSettingsSchema` only requires a string, not a non-empty one (`src/pod/types.ts`). Hap-nodejs
   * asserts a non-empty `displayName` when an accessory is constructed, so handing it `''` or
   * `'   '` throws and — without this fallback — discarded every accessory in the batch (see
   * the per-accessory try/catch above, which now also guards against this class of bug for any
   * future cause of a bad name).
   */
  private nameFor(role: Role, settings: Settings | undefined): string {
    if (role === 'hub') return 'Pod';
    return settings?.[role]?.name?.trim() || FALLBACK_NAME[role];
  }

  /**
   * One bounded, best-effort attempt at `GET /api/settings`, only when at least one new side
   * accessory needs a name (design.md, "One-time, best-effort settings read for name
   * seeding"). Any rejection — network error, timeout, or exceeding
   * `SETTINGS_READ_TIMEOUT_MS` — resolves to `undefined` rather than throwing out of
   * `discoverAccessories`; logged at `debug`, not `error`, because an unreachable Pod at
   * first boot is an expected state (docs/POD-API.md), not a plugin defect.
   */
  private async tryReadSettings(): Promise<Settings | undefined> {
    const client = this.podClient;
    if (!client) return undefined;

    // N9: tied to the race timeout below so a timed-out read actually aborts the underlying
    // HTTP attempt instead of leaving it running in the background after this method has
    // already given up on it and moved on to fallback names.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`settings read exceeded the ${SETTINGS_READ_TIMEOUT_MS}ms startup budget`));
        }, SETTINGS_READ_TIMEOUT_MS);
      });
      return await Promise.race([client.getSettings(controller.signal), timeout]);
    } catch (error) {
      this.log.debug(
        `FreeSleep: one-time settings read for name seeding did not complete ` +
          `(${describeError(error)}); new accessories will use fallback names.`,
      );
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Removes any service on `accessory` whose `(UUID, subtype)` pair is not part of `role`'s
   * currently-enabled set (`enabledServiceKeysFor`). `AccessoryInformation` has no subtype and
   * is always enabled, so it is never a removal candidate. A side accessory's thermostat and
   * the hub's connection sensor both survive; a synthetic extra service does not — exercised by
   * a unit test, so a later change only has to grow `enabledServiceKeysFor`, never this method
   * (design.md, "Restore flow").
   *
   * Returns whether any service was actually removed, so callers (F4) can persist the mutation
   * with `updatePlatformAccessories` only when there is something to persist.
   */
  private pruneServices(accessory: PlatformAccessory, role: Role): boolean {
    const accessoryInformationUuid = this.api.hap.Service.AccessoryInformation.UUID;
    const enabled = enabledServiceKeysFor(this.api.hap, role);
    let removedAny = false;
    for (const service of [...accessory.services]) {
      if (service.UUID === accessoryInformationUuid) continue;
      const key = `${service.UUID}:${service.subtype ?? ''}`;
      if (!enabled.has(key)) {
        accessory.removeService(service);
        removedAny = true;
      }
    }
    return removedAny;
  }

  private setAccessoryInformation(accessory: PlatformAccessory, host: string, role: Role): void {
    const hap = this.api.hap;
    const info = accessory.getService(hap.Service.AccessoryInformation);
    if (!info) return;
    info
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Eight Sleep')
      .setCharacteristic(hap.Characteristic.Model, role === 'hub' ? 'Pod Hub' : 'Pod')
      .setCharacteristic(hap.Characteristic.SerialNumber, serialNumberFor(host, role))
      .setCharacteristic(hap.Characteristic.FirmwareRevision, packageJson.version);
  }
}
