/**
 * `FreeSleepPlatform` — the `DynamicPlatformPlugin` that publishes and maintains the
 * plugin's bridged HomeKit accessories (design.md, "Restore flow").
 *
 * After this change every accessory carries only `AccessoryInformation` — no thermostat,
 * sensor, or switch service exists yet (that is `thermostat-and-offline`). This module owns:
 * stable UUID/SerialNumber derivation from the *configured* host, `configureAccessory`
 * restore with prune-on-restore, unregistering the unused side when `sides !== 'both'`,
 * one-time display-name seeding from `GET /api/settings`, and the bail-without-host startup
 * guard (specs/platform/spec.md).
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
import type { Settings } from './pod/types.ts';
import { DEFAULT_TIMEOUT_MS, PodClient, RETRY_BASE_DELAY_MS, RETRY_JITTER_MS } from './pod/client.ts';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.ts';

const require = createRequire(import.meta.url);
/** This package's own version — see design.md's AccessoryInformation table, `FirmwareRevision`. */
const packageJson = require('../package.json') as { version: string };

export type Role = 'left' | 'right' | 'hub';

/**
 * The subset of `PodClient`'s public interface this change calls. A hand-written fake
 * satisfying just this shape stands in for the real client in tests (design.md,
 * "Testability without a paired Home app") — no dependency on `pod-client`'s own mock Pod,
 * since nothing here needs real transport behavior.
 */
export interface MinimalPodClient {
  getSettings(signal?: AbortSignal): Promise<Settings>;
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
 * `${Service.UUID}:${subtype}` compound keys. Empty for every role after this change — no
 * accessory carries anything beyond `AccessoryInformation` yet (proposal.md's "done when").
 * `thermostat-and-offline` extends this table as it adds services; `pruneServices` below reads
 * it and never needs to change shape itself (design.md, "Restore flow").
 */
const ENABLED_SERVICE_KEYS: Readonly<Record<Role, ReadonlySet<string>>> = {
  left: new Set(),
  right: new Set(),
  hub: new Set(),
};

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

  constructor(log: Logging, rawConfig: PlatformConfig, api: API, podClient?: MinimalPodClient) {
    this.log = log;
    this.api = api;

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
    this.podClient = podClient ?? new PodClient({ host: parsed.data.host });

    this.api.on('didFinishLaunching', () => {
      return this.discoverAccessories().catch((error: unknown) => {
        this.log.error(`FreeSleep: unexpected error during accessory discovery: ${describeError(error)}`);
      });
    });
  }

  /** Homebridge calls this once per cached accessory, before `didFinishLaunching` fires. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedByUuid.set(accessory.UUID, accessory);
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

    const needsSettings = wanted.some((w) => w.role !== 'hub' && !this.cachedByUuid.has(w.uuid));
    const settings = needsSettings ? await this.tryReadSettings() : undefined;

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
        newAccessories.push(accessory);
      } catch (error) {
        this.log.error(
          `FreeSleep: failed to create the '${w.role}' accessory (${describeError(error)}); ` +
            'continuing with the remaining accessories.',
        );
      }
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
   * currently-enabled set (`ENABLED_SERVICE_KEYS`). `AccessoryInformation` has no subtype and
   * is always enabled, so it is never a removal candidate. Every role's enabled set is empty
   * today, so every non-`AccessoryInformation` service is pruned — a no-op in practice,
   * exercised by a unit test with a synthetic extra service, so `thermostat-and-offline` only
   * has to grow `ENABLED_SERVICE_KEYS`, never this method (design.md, "Restore flow").
   *
   * Returns whether any service was actually removed, so callers (F4) can persist the mutation
   * with `updatePlatformAccessories` only when there is something to persist.
   */
  private pruneServices(accessory: PlatformAccessory, role: Role): boolean {
    const accessoryInformationUuid = this.api.hap.Service.AccessoryInformation.UUID;
    const enabled = ENABLED_SERVICE_KEYS[role];
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
