/**
 * `SnapshotStore` — the plugin's single cached, immutable, device-unit view of a Pod.
 *
 * Every HAP `onGet` this plugin will ever register reads `get()` and nothing else: it is
 * synchronous, performs no I/O, and never blocks on an in-flight poll (pod-snapshot spec, "A
 * snapshot read is synchronous and performs no I/O"). `PodPoller` (`./poller.ts`) is the only
 * writer of observed truth; `WriteQueue` (`./writeQueue.ts`) is the only writer of the
 * optimistic overlay. Neither is imported here — this is the dependency graph's leaf module
 * alongside `types.ts` (design.md, "Module dependency direction"), and it is also where the
 * shared timer/randomness injection plumbing and the tiny logger interface both live, because
 * every one of the three modules needs both and this is the one none of the others import.
 *
 * The state model is layered (design.md, "The snapshot is a layered value"):
 *
 *   raw:      last-observed truth per endpoint class, plus derived connection state
 *   overlay:  a bounded-lifetime pin on a handful of exactly-predictable fields
 *   effective = raw with overlay entries applied where present — what `get()` returns
 *
 * Every mutation — a poll result landing, an overlay being installed/refreshed/cleared, an
 * overlay expiring — is a *commit*: it updates `raw` and/or `overlay`, retires any overlay
 * entry that now agrees with `raw`, recomputes `effective`, deep-freezes it, diffs the watched
 * fields against the previous `effective`, swaps it in, and — if anything watched changed —
 * delivers exactly one notification. This is the single rule that makes overlay suppression
 * and the eventual "truth push" on expiry fall out without special-casing either (design.md,
 * "change events are the diff of the effective view, and nothing else").
 */

import {
  interpretWaterLevel,
  type DeviceStatus,
  type Schedules,
  type Services,
  type Settings,
  type Side,
  type WaterLevel,
} from './types.ts';

// ---------------------------------------------------------------------------------------
// Shared timer / randomness / logging plumbing (tasks.md 1.1)
// ---------------------------------------------------------------------------------------

/** Opaque handle returned by `TimerApi.setTimeout`, accepted back by `TimerApi.clearTimeout`. */
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * Everything in `src/pod/{snapshot,poller,writeQueue}.ts` that would otherwise touch
 * `setTimeout`/`clearTimeout`/`Date.now`/`Math.random` goes through this instead, so a test can
 * drive hours of behaviour deterministically under fake timers with zero jitter (design.md,
 * "Timer, clock and randomness injection"). Enforced by the `no-restricted-globals` /
 * `no-restricted-properties` ESLint rule scoped to those three files (tasks.md 1.3).
 */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Milliseconds, same epoch as `Date.now()`. */
  now(): number;
  /** `[0, 1)`, same contract as `Math.random()`. */
  random(): number;
}

/**
 * Defaults to the real globals — accessed through `globalThis` rather than the bare
 * identifiers, which is what the ESLint rule above actually forbids (a bare `Date` or
 * `setTimeout` reference), not a property access on `globalThis`.
 */
export const defaultTimerApi: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  now: () => globalThis.Date.now(),
  random: () => globalThis.Math.random(),
};

/** Minimal logging seam — no dependency on Homebridge's logger from any of these modules. */
export interface Logger {
  debug(message: string): void;
  warn(message: string): void;
}

export const defaultLogger: Logger = {
  debug: (message) => console.debug(`[pod] ${message}`),
  warn: (message) => console.warn(`[pod] ${message}`),
};

// ---------------------------------------------------------------------------------------
// Connection state and error kinds (pod-snapshot spec, "Connection state is exposed as data")
// ---------------------------------------------------------------------------------------

/**
 * Distinguishes *why* the device-status poll failed, without this module importing
 * `errors.ts` — `PodPoller` (which does import it) classifies its caught `PodError` into one
 * of these before calling `recordDeviceStatusFailure`.
 */
export type ErrorKind =
  | 'network'
  | 'timeout'
  | 'response'
  | 'http'
  | 'badRequest'
  | 'request'
  | 'abort'
  | 'unknown';

export interface ConnectionState {
  online: boolean;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastErrorKind: ErrorKind | null;
}

const initialConnectionState: ConnectionState = {
  online: false,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastErrorKind: null,
};

// ---------------------------------------------------------------------------------------
// Raw layer
// ---------------------------------------------------------------------------------------

interface RawState {
  deviceStatus: DeviceStatus | undefined;
  settings: Settings | undefined;
  schedules: Schedules | undefined;
  services: Services | undefined;
  connection: ConnectionState;
}

function initialRawState(): RawState {
  return {
    deviceStatus: undefined,
    settings: undefined,
    schedules: undefined,
    services: undefined,
    connection: initialConnectionState,
  };
}

// ---------------------------------------------------------------------------------------
// Overlay layer (pod-snapshot spec, "An optimistic overlay takes precedence…")
// ---------------------------------------------------------------------------------------

/** Only these are ever exactly predictable post-write (design.md, "Only exactly-predictable…"). */
export type OverlayableField = 'targetTemperatureF' | 'isOn' | 'isAlarmVibrating' | 'awayMode';

const OVERLAYABLE_FIELDS: ReadonlySet<string> = new Set<OverlayableField>([
  'targetTemperatureF',
  'isOn',
  'isAlarmVibrating',
  'awayMode',
]);

export type OverlayValueFor<F extends OverlayableField> = F extends 'targetTemperatureF' ? number : boolean;

/** Opaque handle identifying one overlay installation, returned by `setOverlay`. */
export interface OverlayHandle {
  readonly side: Side;
  readonly field: OverlayableField;
  readonly generation: number;
}

interface OverlayEntry {
  value: number | boolean;
  generation: number;
  timerHandle: TimerHandle | null;
}

type OverlayKey = `${Side}:${OverlayableField}`;

function overlayKey(side: Side, field: OverlayableField): OverlayKey {
  return `${side}:${field}`;
}

// ---------------------------------------------------------------------------------------
// Effective (public) view
// ---------------------------------------------------------------------------------------

export interface EffectiveSideStatus {
  currentTemperatureF: number | undefined;
  targetTemperatureF: number | undefined;
  secondsRemaining: number | undefined;
  isOn: boolean | undefined;
  isAlarmVibrating: boolean | undefined;
  awayMode: boolean | undefined;
}

/** The full last-observed documents, untouched by the overlay — for anything not flattened above. */
export interface EffectiveDocuments {
  deviceStatus: DeviceStatus | undefined;
  settings: Settings | undefined;
  schedules: Schedules | undefined;
  services: Services | undefined;
}

export interface EffectiveSnapshot {
  left: EffectiveSideStatus;
  right: EffectiveSideStatus;
  waterLevelState: WaterLevel | undefined;
  isPriming: boolean | undefined;
  connection: ConnectionState;
  documents: EffectiveDocuments;
}

// ---------------------------------------------------------------------------------------
// Change notifications (pod-snapshot spec, "Change notifications are typed, batched…")
// ---------------------------------------------------------------------------------------

export type SideChangeField =
  | 'currentTemperatureF'
  | 'targetTemperatureF'
  | 'isOn'
  | 'isAlarmVibrating'
  | 'awayMode';

export type DeviceChangeField = 'waterLevelState' | 'isPriming' | 'connectionOnline';

interface SideChange<F extends SideChangeField, V> {
  scope: 'side';
  field: F;
  side: Side;
  previous: V | undefined;
  current: V;
}

interface DeviceChange<F extends DeviceChangeField, V> {
  scope: 'device';
  field: F;
  previous: V | undefined;
  current: V;
}

/**
 * A discriminated union, keyed on `field` (unique across both scopes so a plain
 * `switch (change.field)` narrows `previous`/`current` — and `side` — without needing to
 * switch on `scope` first too. Deliberately a fixed enumeration rather than a generic diff
 * (design.md, "Watched fields are enumerated…"): `secondsRemaining`, `schedules` and
 * `services` are readable but never watched.
 */
export type Change =
  | SideChange<'currentTemperatureF', number>
  | SideChange<'targetTemperatureF', number>
  | SideChange<'isOn', boolean>
  | SideChange<'isAlarmVibrating', boolean>
  | SideChange<'awayMode', boolean>
  | DeviceChange<'waterLevelState', WaterLevel>
  | DeviceChange<'isPriming', boolean>
  | DeviceChange<'connectionOnline', boolean>;

export type Listener = (changes: readonly Change[]) => void;

const SIDES: readonly Side[] = ['left', 'right'];

// ---------------------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------------------
// SnapshotStore
// ---------------------------------------------------------------------------------------

export interface SnapshotOptions {
  timers?: TimerApi;
  logger?: Logger;
}

/**
 * `PodPoller` never touches the overlay layer, so nothing in this module ever calls a poller's
 * `stop()`; conversely nothing here disposes the overlay's own `setTimeout` handles on its own —
 * `WriteQueue.stop()` is the only place that ever needs "everything torn down" (it is the
 * overlay's sole writer, per the module doc above), and it does so by walking its own
 * per-batch overlay-handle bookkeeping and calling `clearOverlay` on each, which already cancels
 * that handle's expiry timer. `SnapshotStore` deliberately has no equivalent "dispose everything"
 * method of its own.
 */
export class SnapshotStore {
  private readonly timers: TimerApi;
  private readonly logger: Logger;

  private raw: RawState = initialRawState();
  private readonly overlay = new Map<OverlayKey, OverlayEntry>();
  /**
   * A single monotonic counter backing every `OverlayHandle.generation`, reserved synchronously
   * at call time rather than derived from `this.overlay.get(key)?.generation` — the latter would
   * race two `setOverlay` calls for the same key issued back-to-back while a commit is already
   * draining (e.g. two re-entrant installs from inside one notification, design.md "Notification
   * delivery"): both would read the same not-yet-applied prior generation and compute an
   * identical "next" value, aliasing two distinct installations under one generation number and
   * defeating the staleness check in `clearOverlay`/`expireOverlay`. A shared counter across all
   * keys (rather than per-key) is simplest and only makes the uniqueness guarantee stronger.
   */
  private overlayGenerationSeq = 0;
  private effective: EffectiveSnapshot;

  private readonly listeners = new Set<Listener>();

  /** Re-entrancy queue (design.md, "Notification delivery: copy the listener list, queue…"). */
  private readonly pendingMutators: Array<() => void> = [];
  private draining = false;

  constructor(options: SnapshotOptions = {}) {
    this.timers = options.timers ?? defaultTimerApi;
    this.logger = options.logger ?? defaultLogger;
    this.effective = deepFreeze(this.computeEffective());
  }

  // ---- reads -------------------------------------------------------------------------

  /** Synchronous, I/O-free, returns the current frozen commit by reference. */
  get(): EffectiveSnapshot {
    return this.effective;
  }

  // ---- observations (writer: PodPoller) -----------------------------------------------

  observeDeviceStatus(data: DeviceStatus): void {
    this.commit(() => {
      this.raw.deviceStatus = data;
      this.raw.connection = {
        online: true,
        consecutiveFailures: 0,
        lastSuccessAt: this.timers.now(),
        lastErrorKind: this.raw.connection.lastErrorKind,
      };
    });
  }

  observeSettings(data: Settings): void {
    this.commit(() => {
      this.raw.settings = data;
    });
  }

  observeSchedules(data: Schedules): void {
    this.commit(() => {
      this.raw.schedules = data;
    });
  }

  observeServices(data: Services): void {
    this.commit(() => {
      this.raw.services = data;
    });
  }

  recordDeviceStatusFailure(kind: ErrorKind): void {
    this.commit(() => {
      this.raw.connection = {
        online: false,
        consecutiveFailures: this.raw.connection.consecutiveFailures + 1,
        lastSuccessAt: this.raw.connection.lastSuccessAt,
        lastErrorKind: kind,
      };
    });
  }

  // ---- overlay (writer: WriteQueue) ---------------------------------------------------

  setOverlay<F extends OverlayableField>(
    side: Side,
    field: F,
    value: OverlayValueFor<F>,
    ttlMs: number,
  ): OverlayHandle {
    if (!OVERLAYABLE_FIELDS.has(field)) {
      throw new Error(
        `snapshot: "${field}" cannot be overlaid — only ${[...OVERLAYABLE_FIELDS].join(', ')} are ` +
          'exactly predictable post-write (design.md, "Only exactly-predictable, user-visible fields…").',
      );
    }
    const key = overlayKey(side, field);
    const generation = ++this.overlayGenerationSeq;
    this.commit(() => {
      const existing = this.overlay.get(key);
      if (existing?.timerHandle) {
        this.timers.clearTimeout(existing.timerHandle);
      }
      const timerHandle = this.timers.setTimeout(() => this.expireOverlay(key, generation), Math.max(0, ttlMs));
      this.overlay.set(key, { value, generation, timerHandle });
    });
    return { side, field, generation };
  }

  clearOverlay(handle: OverlayHandle): void {
    const key = overlayKey(handle.side, handle.field);
    this.commit(() => {
      const entry = this.overlay.get(key);
      if (entry && entry.generation === handle.generation) {
        if (entry.timerHandle) this.timers.clearTimeout(entry.timerHandle);
        this.overlay.delete(key);
      }
    });
  }

  private expireOverlay(key: OverlayKey, generation: number): void {
    this.commit(() => {
      const entry = this.overlay.get(key);
      if (entry && entry.generation === generation) {
        this.overlay.delete(key);
      }
    });
  }

  // ---- subscription --------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- commit machinery ------------------------------------------------------------------

  /**
   * Every mutation is funnelled through here. A mutator that runs while a notification is
   * already being delivered (i.e. a subscriber calling back into `setOverlay`/`observe*` from
   * inside its own notification) is queued rather than processed re-entrantly, so commits
   * never interleave and `get()` is never observed mid-swap (design.md).
   */
  private commit(mutate: () => void): void {
    this.pendingMutators.push(mutate);
    if (this.draining) return;
    this.draining = true;
    try {
      let next: (() => void) | undefined = this.pendingMutators.shift();
      while (next) {
        next();
        this.retireAgreedOverlaysAgainstRaw();
        const nextEffective = deepFreeze(this.computeEffective());
        const changes = diffWatched(this.effective, nextEffective);
        this.effective = nextEffective;
        if (changes.length > 0) this.notify(changes);
        next = this.pendingMutators.shift();
      }
    } finally {
      this.draining = false;
    }
  }

  private notify(changes: readonly Change[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(changes);
      } catch (error) {
        this.logger.warn(`snapshot listener threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }
  }

  /** Agreement is detected during a raw commit (design.md, "Overlay lifecycle lives in…"). */
  private retireAgreedOverlaysAgainstRaw(): void {
    for (const side of SIDES) {
      const rawSide = this.raw.deviceStatus?.[side];
      const rawSettingsSide = this.raw.settings?.[side];
      this.maybeRetire(side, 'targetTemperatureF', rawSide?.targetTemperatureF);
      this.maybeRetire(side, 'isOn', rawSide?.isOn);
      this.maybeRetire(side, 'isAlarmVibrating', rawSide?.isAlarmVibrating);
      this.maybeRetire(side, 'awayMode', rawSettingsSide?.awayMode);
    }
  }

  private maybeRetire(side: Side, field: OverlayableField, rawValue: number | boolean | undefined): void {
    if (rawValue === undefined) return;
    const key = overlayKey(side, field);
    const entry = this.overlay.get(key);
    if (entry && entry.value === rawValue) {
      if (entry.timerHandle) this.timers.clearTimeout(entry.timerHandle);
      this.overlay.delete(key);
    }
  }

  private computeEffective(observedOnly = false): EffectiveSnapshot {
    const overlay = observedOnly ? new Map<OverlayKey, OverlayEntry>() : this.overlay;
    return {
      left: this.computeSide('left', overlay),
      right: this.computeSide('right', overlay),
      waterLevelState: this.raw.deviceStatus ? interpretWaterLevel(this.raw.deviceStatus.waterLevel) : undefined,
      isPriming: this.raw.deviceStatus?.isPriming,
      connection: this.raw.connection,
      documents: {
        deviceStatus: this.raw.deviceStatus,
        settings: this.raw.settings,
        schedules: this.raw.schedules,
        services: this.raw.services,
      },
    };
  }

  private computeSide(side: Side, overlay: Map<OverlayKey, OverlayEntry>): EffectiveSideStatus {
    const rawSide = this.raw.deviceStatus?.[side];
    const rawSettingsSide = this.raw.settings?.[side];
    const target = overlay.get(overlayKey(side, 'targetTemperatureF'));
    const isOn = overlay.get(overlayKey(side, 'isOn'));
    const alarm = overlay.get(overlayKey(side, 'isAlarmVibrating'));
    const away = overlay.get(overlayKey(side, 'awayMode'));
    return {
      currentTemperatureF: rawSide?.currentTemperatureF,
      targetTemperatureF: (target?.value as number | undefined) ?? rawSide?.targetTemperatureF,
      secondsRemaining: rawSide?.secondsRemaining,
      isOn: (isOn?.value as boolean | undefined) ?? rawSide?.isOn,
      isAlarmVibrating: (alarm?.value as boolean | undefined) ?? rawSide?.isAlarmVibrating,
      awayMode: (away?.value as boolean | undefined) ?? rawSettingsSide?.awayMode,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------------------

function diffWatched(previous: EffectiveSnapshot, current: EffectiveSnapshot): Change[] {
  const changes: Change[] = [];
  for (const side of SIDES) {
    pushSideChange(changes, side, 'currentTemperatureF', previous[side].currentTemperatureF, current[side].currentTemperatureF);
    pushSideChange(changes, side, 'targetTemperatureF', previous[side].targetTemperatureF, current[side].targetTemperatureF);
    pushSideChange(changes, side, 'isOn', previous[side].isOn, current[side].isOn);
    pushSideChange(changes, side, 'isAlarmVibrating', previous[side].isAlarmVibrating, current[side].isAlarmVibrating);
    pushSideChange(changes, side, 'awayMode', previous[side].awayMode, current[side].awayMode);
  }
  pushDeviceChange(changes, 'waterLevelState', previous.waterLevelState, current.waterLevelState);
  pushDeviceChange(changes, 'isPriming', previous.isPriming, current.isPriming);
  pushDeviceChange(changes, 'connectionOnline', previous.connection.online, current.connection.online);
  return changes;
}

function pushSideChange<F extends SideChangeField, V extends number | boolean>(
  changes: Change[],
  side: Side,
  field: F,
  previous: V | undefined,
  current: V | undefined,
): void {
  if (current === undefined || previous === current) return;
  changes.push({ scope: 'side', field, side, previous, current } as Change);
}

function pushDeviceChange<F extends DeviceChangeField, V extends number | boolean | string>(
  changes: Change[],
  field: F,
  previous: V | undefined,
  current: V | undefined,
): void {
  if (current === undefined || previous === current) return;
  changes.push({ scope: 'device', field, previous, current } as Change);
}
