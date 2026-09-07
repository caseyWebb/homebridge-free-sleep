/**
 * `FreeSleepPlatform` — the `DynamicPlatformPlugin` that publishes and maintains the
 * plugin's bridged HomeKit accessories (design.md, "Restore flow").
 *
 * Every side accessory carries a `Thermostat`; the hub carries the "Pod Connection"
 * `ContactSensor` (`thermostat-and-offline`, specs/platform/spec.md). This module owns:
 * stable UUID/SerialNumber derivation from the *configured* host, `configureAccessory`
 * restore with prune-on-restore, unregistering the unused side when `sides !== 'both'`,
 * one-time display-name seeding from `GET /api/settings`, the bail-without-host startup
 * guard, and constructing and owning the snapshot store, poller, write queue, (as of the
 * away-mode-guard change) away-mode guard, and (as of the `keep-alive` change, #12) the
 * keep-alive component for the whole platform's lifetime, bootstrapping before any HAP handler
 * is registered, routing snapshot change events to the services that publish them, and stopping
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
  AlarmRequest,
  DeviceStatus,
  DeviceStatusPatch,
  PresenceData,
  Schedules,
  ServerStatus,
  Services as PodServices,
  Settings,
  SettingsPatch,
  Side,
  VitalsResponse,
} from './pod/types.ts';
import { AwayModeGuard } from './pod/awayModeGuard.ts';
import { DEFAULT_TIMEOUT_MS, PodClient, RETRY_BASE_DELAY_MS, RETRY_JITTER_MS } from './pod/client.ts';
import { KeepAlive } from './pod/keepAlive.ts';
import { PodPoller } from './pod/poller.ts';
import { defaultTimerApi, SnapshotStore, type Change, type TimerApi } from './pod/snapshot.ts';
import { WriteQueue } from './pod/writeQueue.ts';
import { CONNECTION_SUBTYPE, ConnectionService } from './services/connection.ts';
import { LED_SUBTYPE, LedService } from './services/led.ts';
import { isOccupancyChange, OCCUPANCY_SUBTYPE, OccupancySensorService } from './services/occupancy.ts';
import { PRIME_SUBTYPE, PrimeService } from './services/prime.ts';
import { SERVER_FAULT_SUBTYPE, ServerFaultService } from './services/serverFault.ts';
import { TEST_ALARM_LEFT_SUBTYPE, TEST_ALARM_RIGHT_SUBTYPE, TestAlarmService } from './services/testAlarm.ts';
import { isThermostatChange, THERMOSTAT_SUBTYPE, ThermostatService } from './services/thermostat.ts';
import type { ServiceContext } from './services/types.ts';
import { WATER_LOW_SUBTYPE, WaterLowService } from './services/waterLow.ts';
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
  /** Widened by `hub-accessory`: needed by `PodPoller`'s `serverStatus` class. */
  getServerStatus(signal?: AbortSignal): Promise<ServerStatus>;
  /**
   * Widened by `hub-accessory`: `TestAlarmService` is the first service to call the client
   * directly (via `ServiceContext.podClient`) rather than solely through
   * `writeQueue`/`snapshot` — `postAlarm` is a one-off fire-and-forget write, not a
   * debounced/merged field the write queue's lane model fits.
   */
  postAlarm(request: AlarmRequest, signal?: AbortSignal): Promise<void>;
  /**
   * Occupancy change (#19). Optional — only called by `PodPoller`'s `presence`/`vitals` classes,
   * which are themselves only ever enabled when `occupancySource` names them (default `'none'`
   * never enables either), so every existing fake `MinimalPodClient` that predates this change
   * and omits these two methods keeps working unchanged.
   */
  getPresence?(signal?: AbortSignal): Promise<PresenceData>;
  getVitals?(
    query?: { side?: Side; startTime?: string; endTime?: string },
    signal?: AbortSignal,
  ): Promise<VitalsResponse>;
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
 * `${Service.UUID}:${subtype}` compound keys — side accessories enable the thermostat subtype
 * and, when `occupancySource` is not `'none'`, the occupancy subtype too; the hub enables the
 * connection sensor and the water-low sensor unconditionally, plus whichever of the prime
 * switch, LED lightbulb, test-alarm switch, and server-fault sensor `config` currently enables
 * (`hub-accessory`, tasks.md 9.1; occupancy change, #19, design.md's "`occupancySource: 'none'`
 * publishes no `OccupancySensor` at all"). Computed from `hap` and `config` rather than a
 * module-level constant, since the UUIDs come from `api.hap.Service.*`, never a direct
 * `@homebridge/hap-nodejs` import (docs/HOMEKIT.md). `pruneServices` below reads this and never
 * needs to change shape itself as more services are added (design.md, "Restore flow") —
 * switching between two non-`'none'` `occupancySource` values does not change this set at all,
 * only what the already-published service's own internal source-selection logic reads.
 */
function enabledServiceKeysFor(hap: HAP, role: Role, config: FreeSleepConfig): ReadonlySet<string> {
  if (role === 'hub') {
    const waterLowServiceCtor = config.waterLowSensorType === 'leak' ? hap.Service.LeakSensor : hap.Service.ContactSensor;
    const keys = [
      `${hap.Service.ContactSensor.UUID}:${CONNECTION_SUBTYPE}`,
      `${waterLowServiceCtor.UUID}:${WATER_LOW_SUBTYPE}`,
    ];
    if (config.primeSwitch) keys.push(`${hap.Service.Switch.UUID}:${PRIME_SUBTYPE}`);
    if (config.ledLightbulb) keys.push(`${hap.Service.Lightbulb.UUID}:${LED_SUBTYPE}`);
    // G0 (tech-lead ruling, PR #44 review): two independent per-side switches, not one
    // both-sides switch — still gated by the single `testAlarmSwitch` boolean.
    if (config.testAlarmSwitch) {
      keys.push(`${hap.Service.Switch.UUID}:${TEST_ALARM_LEFT_SUBTYPE}`, `${hap.Service.Switch.UUID}:${TEST_ALARM_RIGHT_SUBTYPE}`);
    }
    if (config.serverFaultSensor) keys.push(`${hap.Service.ContactSensor.UUID}:${SERVER_FAULT_SUBTYPE}`);
    return new Set(keys);
  }
  const keys = [`${hap.Service.Thermostat.UUID}:${THERMOSTAT_SUBTYPE}`];
  if (config.occupancySource !== 'none') {
    keys.push(`${hap.Service.OccupancySensor.UUID}:${OCCUPANCY_SUBTYPE}`);
  }
  return new Set(keys);
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
  /** Consulted by `writeQueue` itself on every side-lane dispatch (away-mode-guard change,
   * tech-lead resolution 2) — also threaded through `ServiceContext` (see `serviceContextFor`). */
  private readonly awayModeGuard: AwayModeGuard | undefined;
  /** Owns its own timer for the platform's lifetime, stopped alongside `poller`/`writeQueue` on
   * shutdown (`keep-alive` change, #12). `undefined` only when `config` itself failed to parse —
   * unlike `poller`/`writeQueue`, it is still constructed (inert) when `keepAlive` is `false`;
   * its own constructor schedules nothing at all in that case (design.md). */
  private readonly keepAlive: KeepAlive | undefined;
  private unsubscribeSnapshot: (() => void) | undefined;

  private readonly thermostats = new Map<Side, ThermostatService>();
  /** Occupancy change (#19). Populated only when `config.occupancySource !== 'none'`. */
  private readonly occupancySensors = new Map<Side, OccupancySensorService>();
  private connectionService: ConnectionService | undefined;
  private waterLowService: WaterLowService | undefined;
  private primeService: PrimeService | undefined;
  // S2 fix (PR #44 review): `LedService` is now retained — `ledBrightness` became a watched
  // `DeviceChangeField` (`src/pod/snapshot.ts`) so an externally-changed brightness/on-off reaches
  // the "Pod LED" tile, and `handleSnapshotChanges` needs this reference to route to it.
  private ledService: LedService | undefined;
  // G0 (tech-lead ruling, PR #44 review): one `TestAlarmService` per side, not one shared,
  // both-sides instance — mirrors `thermostats`' own per-`Side` map.
  private readonly testAlarmServices = new Map<Side, TestAlarmService>();
  private serverFaultService: ServerFaultService | undefined;

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
      serverFaultSensorEnabled: parsed.data.serverFaultSensor,
      // Occupancy change (#19): a plain value, following the same "poller doesn't import
      // config.ts" discipline every existing option already follows (design.md).
      occupancySource: parsed.data.occupancySource,
    });
    this.poller = poller;

    // One `AwayModeGuard` per launch, sharing the same snapshot — consulted by `writeQueue`
    // itself on every side-lane dispatch, regardless of which service originates the write
    // (away-mode-guard change, tech-lead resolution 2: enforcement lives inside `WriteQueue`,
    // not in a front-door wrapper a caller could forget to use).
    const awayModeGuard = new AwayModeGuard({ snapshot, policy: parsed.data.awayModeWritePolicy });
    this.awayModeGuard = awayModeGuard;

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
      // S4 fix (PR #44 review): a bounded pre-dispatch refresh for the device lane, via the same
      // lane-aware callback-injection pattern `requestFastPoll` above already establishes —
      // `writeQueue.ts` still never imports `poller.ts` (design.md, "Module dependency
      // direction").
      refreshDeviceStatus: () => poller.refresh('deviceStatus'),
      awayModeGuard,
      timers: this.timers,
      ...(pollOptions.writeDebounceMs !== undefined ? { writeDebounceMs: pollOptions.writeDebounceMs } : {}),
      ...(pollOptions.deviceWriteDebounceMs !== undefined
        ? { deviceWriteDebounceMs: pollOptions.deviceWriteDebounceMs }
        : {}),
      ...(pollOptions.writeMaxDebounceMs !== undefined ? { writeMaxDebounceMs: pollOptions.writeMaxDebounceMs } : {}),
      writeSettleMs: parsed.data.writeSettleMs,
      ...(pollOptions.fastPollDurationMs !== undefined ? { fastPollDurationMs: pollOptions.fastPollDurationMs } : {}),
    });
    this.writeQueue = writeQueue;

    // One `KeepAlive` per launch (#12), sharing the same snapshot and write queue — its own
    // re-arm writes pass through `writeQueue.submitSide` under the `'keepAlive'` origin, so they
    // inherit debouncing, the mutex, and the away-mode guard uniformly with every other caller
    // (design.md, "Re-arm writes go through submitSide, not runExclusive").
    this.keepAlive = new KeepAlive({
      snapshot,
      writeQueue,
      timers: this.timers,
      keepAliveMs: parsed.data.keepAliveMs,
      keepAliveThresholdMs: parsed.data.keepAliveThresholdMs,
      enabled: parsed.data.keepAlive,
    });

    // Subscribed exactly once (specs/platform/spec.md, tasks.md 7.3); each service call is
    // individually wrapped so one throwing service does not stop the others from being
    // notified.
    this.unsubscribeSnapshot = snapshot.subscribe((changes) => this.handleSnapshotChanges(changes));

    this.api.on('didFinishLaunching', () => {
      return this.discoverAccessories().catch((error: unknown) => {
        this.log.error(`FreeSleep: unexpected error during accessory discovery: ${describeError(error)}`);
      });
    });

    // Stop polling, stop the write path, drop the snapshot subscription, and clear any pending
    // per-thermostat away-mode-revert timer (F2 fix) — no pending timer, no in-flight work that
    // could still touch HomeKit (specs/platform/spec.md, tasks.md 7.4 and 2.3).
    this.api.on('shutdown', () => {
      this.poller?.stop();
      this.writeQueue?.stop();
      this.keepAlive?.stop();
      for (const thermostat of this.thermostats.values()) {
        thermostat.stop();
      }
      this.primeService?.stop();
      for (const testAlarmService of this.testAlarmServices.values()) {
        testAlarmService.stop();
      }
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
        // Three independent `if`s, deliberately not chained as `else if`: `isThermostatChange`
        // and `isOccupancyChange` share the same (imprecise, but harmless in isolation) type
        // predicate shape `Change & { scope: 'side'; side: Side }` — chaining them would make
        // TypeScript's negative narrowing of the first collapse the second's operand to `never`,
        // since neither predicate's *type* discriminates on which side-scope field actually
        // matched, only its runtime check does. At most one of the three ever matches a given
        // change in practice (design.md's routing table), so this is behaviorally identical to
        // an if/else-if chain.
        if (isThermostatChange(change)) {
          this.thermostats.get(change.side)?.refresh();
        }
        if (isOccupancyChange(change)) {
          this.occupancySensors.get(change.side)?.refresh();
        }
        if (change.scope === 'device' && change.field === 'connectionOnline') {
          this.connectionService?.refresh();
        } else if (change.scope === 'device' && change.field === 'waterLevelState') {
          this.waterLowService?.refresh();
        } else if (change.scope === 'device' && change.field === 'isPriming') {
          this.primeService?.refresh();
        } else if (change.scope === 'device' && change.field === 'serverFault') {
          this.serverFaultService?.refresh();
        } else if (change.scope === 'device' && change.field === 'serverStatusOnline') {
          // S1 fix (PR #44 review): the reachability axis, independent of the payload signal
          // above — both route to the same service's `refresh()`, which reads both.
          this.serverFaultService?.refresh();
        } else if (change.scope === 'device' && change.field === 'ledBrightness') {
          // S2 fix (PR #44 review): an externally-changed brightness/on-off must reach the tile.
          this.ledService?.refresh();
        }
        // isAlarmVibrating, awayMode: no published service watches these fields yet — ignored,
        // without error (design.md's routing table; #13/#16/#19/#20).
      } catch (error) {
        this.log.warn(`FreeSleep: a service failed to handle a snapshot change: ${describeError(error)}`);
      }
    }
  }

  /**
   * N5: the platform's single source of truth for the configured occupancy source — used
   * identically by `constructServicesFor` (deciding whether to construct an
   * `OccupancySensorService`) and `pruneServices` (deciding whether to prune one), which
   * previously each derived `this.config?.occupancySource ?? 'none'` independently. Both call
   * sites now read through here so the two can never disagree about what is currently
   * configured.
   */
  private occupancySource(): FreeSleepConfig['occupancySource'] {
    return this.config?.occupancySource ?? 'none';
  }

  private serviceContextFor(accessory: PlatformAccessory): ServiceContext | undefined {
    if (!this.config || !this.snapshot || !this.writeQueue || !this.awayModeGuard || !this.podClient) return undefined;
    return {
      api: this.api,
      log: this.log,
      accessory,
      snapshot: this.snapshot,
      writeQueue: this.writeQueue,
      awayModeGuard: this.awayModeGuard,
      timers: this.timers,
      config: this.config,
      podClient: this.podClient,
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
      this.waterLowService = new WaterLowService(ctx);
      if (ctx.config.primeSwitch) this.primeService = new PrimeService(ctx);
      if (ctx.config.ledLightbulb) this.ledService = new LedService(ctx);
      if (ctx.config.testAlarmSwitch) {
        this.testAlarmServices.set('left', new TestAlarmService(ctx, 'left'));
        this.testAlarmServices.set('right', new TestAlarmService(ctx, 'right'));
      }
      if (ctx.config.serverFaultSensor) this.serverFaultService = new ServerFaultService(ctx);
    } else {
      this.thermostats.set(role, new ThermostatService(ctx, role, this.platformStartedAt));
      // Occupancy change (#19): constructed alongside the thermostat only when a source is
      // configured — `'none'` (the default) leaves `occupancySensors` empty for this side, and
      // `enabledServiceKeysFor` above already excludes the subtype so restore never carries one
      // to prune in the first place.
      //
      // N5: reads the same `this.occupancySource()` helper `pruneServices` below uses, rather
      // than each site independently re-deriving `config?.occupancySource ?? 'none'` — so the
      // two can never observe a different value from each other.
      if (this.occupancySource() !== 'none') {
        this.occupancySensors.set(role, new OccupancySensorService(ctx, role));
      }
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
        const pruned = this.pruneServices(existing, w.role, config);
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
  private pruneServices(accessory: PlatformAccessory, role: Role, config: FreeSleepConfig): boolean {
    const accessoryInformationUuid = this.api.hap.Service.AccessoryInformation.UUID;
    const enabled = enabledServiceKeysFor(this.api.hap, role, config);
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
