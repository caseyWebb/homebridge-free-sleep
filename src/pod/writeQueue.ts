/**
 * `WriteQueue` — turns user intent into the smallest, safest possible amount of Pod traffic
 * (pod-write-queue spec).
 *
 * Pipeline: submit → per-lane trailing-edge debounce with field merging → the
 * power/duration reduction → one global FIFO mutex across every lane and both write endpoints
 * → dispatch → settle (design.md, "Write queue pipeline"). The optimistic overlay is installed
 * on the snapshot at submission (not dispatch) so the cached view never goes stale while a
 * write is queued, re-based to the settle time on success, and cleared immediately on failure.
 *
 * Imports `client.ts`, `snapshot.ts`, `errors.ts` and `types.ts` only — never `poller.ts`
 * (design.md, "Module dependency direction"). Requesting the post-write fast cadence goes
 * through the injected `requestFastPoll` callback instead.
 */

import type { PodClient } from './client.ts';
import { defaultLogger, defaultTimerApi, type Logger, type OverlayHandle, type SnapshotStore, type TimerApi, type TimerHandle } from './snapshot.ts';
import type { DeviceStatusPatch, SettingsPatch, Side } from './types.ts';

/** Raised for a submission still queued (debouncing or waiting in the mutex) when `stop()` runs. */
export class WriteQueueStoppedError extends Error {
  constructor(message = 'WriteQueue stopped before this write was dispatched') {
    super(message);
    this.name = new.target.name;
  }
}

export type SidePatch = Partial<{
  targetTemperatureF: number;
  isOn: boolean;
  secondsRemaining: number;
  isAlarmVibrating: boolean;
}>;

export type DevicePatch = Partial<{ v: number; gainLeft: number; gainRight: number; ledBrightness: number }>;

type LaneId = 'left' | 'right' | 'device' | 'settings';

export interface WriteQueueOptions {
  client: PodClient;
  snapshot: SnapshotStore;
  /** Called with `now() + fastPollDurationMs` after a successful dispatch, on success only. */
  requestFastPoll: (untilMs: number) => void;
  timers?: TimerApi;
  logger?: Logger;
  /** Trailing-edge debounce per lane. Default 400, enforced minimum 100. */
  writeDebounceMs?: number;
  /** Hard cap on how long a continuing batch can be postponed. Default 2000. */
  writeMaxDebounceMs?: number;
  /** Optimistic-overlay window, re-based at dispatch settle. Default 15000. */
  writeSettleMs?: number;
  /** Post-write fast-poll window handed to `requestFastPoll`. Default 90000. */
  fastPollDurationMs?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface LaneRuntime<P> {
  pending: P | null;
  waiters: Waiter[];
  debounceTimer: TimerHandle | null;
  maxWaitTimer: TimerHandle | null;
}

interface MutexTask {
  run: () => Promise<void>;
  abandon: () => void;
}

type SideOverlayField = 'targetTemperatureF' | 'isOn' | 'isAlarmVibrating' | 'awayMode';

interface OverlayFieldRef {
  key: string;
  side: Side;
  field: SideOverlayField;
}

/**
 * The four-case reduction (design.md, "The isOn/secondsRemaining reduction, and why it is not
 * simply 'drop isOn'"). `updateSide` applies power first and remaining-seconds last, and
 * silently no-ops a zero duration — so keeping `secondsRemaining` when it is non-zero and
 * `isOn` otherwise reproduces the Pod's own outcome in all four combinations.
 */
function reduceDurationFields(patch: SidePatch): SidePatch {
  if (patch.isOn === undefined || patch.secondsRemaining === undefined) return patch;
  const reduced = { ...patch };
  if (patch.secondsRemaining !== 0) {
    delete reduced.isOn;
  } else {
    delete reduced.secondsRemaining;
  }
  return reduced;
}

function isSideLane(lane: LaneId): lane is Side {
  return lane === 'left' || lane === 'right';
}

export class WriteQueue {
  private readonly client: PodClient;
  private readonly snapshot: SnapshotStore;
  private readonly requestFastPoll: (untilMs: number) => void;
  private readonly timers: TimerApi;
  private readonly logger: Logger;

  private readonly writeDebounceMs: number;
  private readonly writeMaxDebounceMs: number;
  private readonly writeSettleMs: number;
  private readonly fastPollDurationMs: number;

  private readonly left: LaneRuntime<SidePatch> = emptyLane();
  private readonly right: LaneRuntime<SidePatch> = emptyLane();
  private readonly device: LaneRuntime<DevicePatch> = emptyLane();
  private readonly settingsLane: LaneRuntime<SettingsPatch> = emptyLane();

  private readonly ownedOverlayHandles = new Map<string, OverlayHandle>();

  private readonly mutexQueue: MutexTask[] = [];
  private mutexBusy = false;

  private stopped = false;

  constructor(options: WriteQueueOptions) {
    this.client = options.client;
    this.snapshot = options.snapshot;
    this.requestFastPoll = options.requestFastPoll;
    this.timers = options.timers ?? defaultTimerApi;
    this.logger = options.logger ?? defaultLogger;

    this.writeDebounceMs = Math.max(100, options.writeDebounceMs ?? 400);
    this.writeMaxDebounceMs = options.writeMaxDebounceMs ?? 2000;
    this.writeSettleMs = options.writeSettleMs ?? 15_000;
    this.fastPollDurationMs = options.fastPollDurationMs ?? 90_000;
  }

  // -----------------------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------------------

  submitSide(side: Side, patch: SidePatch): Promise<void> {
    const rt = side === 'left' ? this.left : this.right;
    return this.submit(side, rt, patch, () => this.syncSideOverlays(side, reduceDurationFields(rt.pending ?? {})));
  }

  submitDeviceSettings(patch: DevicePatch): Promise<void> {
    return this.submit('device', this.device, patch, () => {
      /* no overlayable fields on the device lane */
    });
  }

  submitSettings(patch: SettingsPatch): Promise<void> {
    return this.submit('settings', this.settingsLane, patch, () => this.syncAwayModeOverlays(this.settingsLane.pending ?? {}));
  }

  private submit<P extends object>(
    lane: LaneId,
    rt: LaneRuntime<P>,
    patch: P,
    syncOverlays: () => void,
  ): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new WriteQueueStoppedError());
    }
    return new Promise<void>((resolve, reject) => {
      if (rt.pending === null) {
        rt.pending = { ...patch };
        rt.maxWaitTimer = this.timers.setTimeout(() => this.flush(lane, rt), this.writeMaxDebounceMs);
      } else {
        Object.assign(rt.pending, patch);
      }
      rt.waiters.push({ resolve, reject });
      if (rt.debounceTimer !== null) this.timers.clearTimeout(rt.debounceTimer);
      rt.debounceTimer = this.timers.setTimeout(() => this.flush(lane, rt), this.writeDebounceMs);
      syncOverlays();
    });
  }

  // -----------------------------------------------------------------------------------
  // Overlay install at submission (pod-write-queue spec, "…applied on submission…")
  // -----------------------------------------------------------------------------------

  private syncSideOverlays(side: Side, reduced: SidePatch): void {
    this.applyOrClearOverlay(side, 'targetTemperatureF', reduced.targetTemperatureF);
    this.applyOrClearOverlay(side, 'isOn', reduced.isOn);
    this.applyOrClearOverlay(side, 'isAlarmVibrating', reduced.isAlarmVibrating);
  }

  private syncAwayModeOverlays(patch: SettingsPatch): void {
    this.applyOrClearOverlay('left', 'awayMode', patch.left?.awayMode);
    this.applyOrClearOverlay('right', 'awayMode', patch.right?.awayMode);
  }

  private applyOrClearOverlay(side: Side, field: SideOverlayField, value: number | boolean | undefined): void {
    const key = `${side}:${field}`;
    if (value === undefined) {
      const existing = this.ownedOverlayHandles.get(key);
      if (existing) {
        this.snapshot.clearOverlay(existing);
        this.ownedOverlayHandles.delete(key);
      }
      return;
    }
    const handle =
      field === 'targetTemperatureF'
        ? this.snapshot.setOverlay(side, field, value as number, this.writeSettleMs)
        : this.snapshot.setOverlay(side, field, value as boolean, this.writeSettleMs);
    this.ownedOverlayHandles.set(key, handle);
  }

  private clearOwnedOverlaysFor(keys: readonly string[]): void {
    for (const key of keys) {
      const handle = this.ownedOverlayHandles.get(key);
      if (handle) {
        this.snapshot.clearOverlay(handle);
        this.ownedOverlayHandles.delete(key);
      }
    }
  }

  /**
   * Re-installs each overlay entry this dispatch owns with the *same* value but a fresh
   * `writeSettleMs` window measured from now (dispatch-settle time) — pod-write-queue spec,
   * "The settle window starts when the write lands". Reading the value back off the current
   * effective snapshot is safe: nothing else can have changed it between submission and this
   * dispatch settling, since this queue is the only writer of these overlay entries.
   */
  private rebaseOwnedOverlaysFor(keys: readonly OverlayFieldRef[]): void {
    for (const { key, side, field } of keys) {
      const handle = this.ownedOverlayHandles.get(key);
      if (!handle) continue;
      const value = this.snapshot.get()[side][field];
      if (value === undefined) continue;
      const refreshed =
        field === 'targetTemperatureF'
          ? this.snapshot.setOverlay(side, field, value as number, this.writeSettleMs)
          : this.snapshot.setOverlay(side, field, value as boolean, this.writeSettleMs);
      this.ownedOverlayHandles.set(key, refreshed);
    }
  }

  // -----------------------------------------------------------------------------------
  // Debounce flush → dispatch
  // -----------------------------------------------------------------------------------

  private flush<P extends object>(lane: LaneId, rt: LaneRuntime<P>): void {
    if (rt.pending === null) return;
    const patch = rt.pending;
    const waiters = rt.waiters;
    rt.pending = null;
    rt.waiters = [];
    if (rt.debounceTimer !== null) {
      this.timers.clearTimeout(rt.debounceTimer);
      rt.debounceTimer = null;
    }
    if (rt.maxWaitTimer !== null) {
      this.timers.clearTimeout(rt.maxWaitTimer);
      rt.maxWaitTimer = null;
    }
    this.enqueueDispatch(lane, patch, waiters);
  }

  private enqueueDispatch(lane: LaneId, patch: object, waiters: Waiter[]): void {
    const task: MutexTask = {
      run: () => this.dispatch(lane, patch, waiters),
      abandon: () => waiters.forEach((w) => w.reject(new WriteQueueStoppedError())),
    };
    this.mutexQueue.push(task);
    this.pumpMutex();
  }

  private overlayKeysFor(lane: LaneId, patch: object): OverlayFieldRef[] {
    if (isSideLane(lane)) {
      const p = patch as SidePatch;
      const out: OverlayFieldRef[] = [];
      if (p.targetTemperatureF !== undefined) out.push({ key: `${lane}:targetTemperatureF`, side: lane, field: 'targetTemperatureF' });
      if (p.isOn !== undefined) out.push({ key: `${lane}:isOn`, side: lane, field: 'isOn' });
      if (p.isAlarmVibrating !== undefined) out.push({ key: `${lane}:isAlarmVibrating`, side: lane, field: 'isAlarmVibrating' });
      return out;
    }
    if (lane === 'settings') {
      const p = patch as SettingsPatch;
      const out: OverlayFieldRef[] = [];
      if (p.left?.awayMode !== undefined) out.push({ key: 'left:awayMode', side: 'left', field: 'awayMode' });
      if (p.right?.awayMode !== undefined) out.push({ key: 'right:awayMode', side: 'right', field: 'awayMode' });
      return out;
    }
    return [];
  }

  private async dispatch(lane: LaneId, patch: object, waiters: Waiter[]): Promise<void> {
    const overlayKeys = this.overlayKeysFor(lane, patch);
    let body: object;
    if (isSideLane(lane)) {
      const reduced = reduceDurationFields(patch as SidePatch);
      this.logger.debug(`writeQueue: ${lane} submitted ${JSON.stringify(patch)}, dispatching ${JSON.stringify(reduced)}`);
      body = { [lane]: reduced };
    } else if (lane === 'device') {
      body = { settings: patch };
    } else {
      body = patch;
    }

    try {
      if (lane === 'settings') {
        await this.client.postSettings(body as SettingsPatch);
      } else {
        await this.client.postDeviceStatus(body as DeviceStatusPatch);
      }
      if (!this.stopped) {
        this.rebaseOwnedOverlaysFor(overlayKeys);
        this.requestFastPoll(this.timers.now() + this.fastPollDurationMs);
      }
      waiters.forEach((w) => w.resolve());
    } catch (error) {
      if (!this.stopped) {
        this.clearOwnedOverlaysFor(overlayKeys.map((k) => k.key));
      }
      waiters.forEach((w) => w.reject(error));
    }
  }

  // -----------------------------------------------------------------------------------
  // Mutex
  // -----------------------------------------------------------------------------------

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.stopped) {
        reject(new WriteQueueStoppedError());
        return;
      }
      const task: MutexTask = {
        run: async () => {
          try {
            resolve(await fn());
          } catch (error) {
            reject(error);
          }
        },
        abandon: () => reject(new WriteQueueStoppedError()),
      };
      this.mutexQueue.push(task);
      this.pumpMutex();
    });
  }

  private pumpMutex(): void {
    if (this.mutexBusy) return;
    const task = this.mutexQueue.shift();
    if (!task) return;
    this.mutexBusy = true;
    task
      .run()
      .catch(() => {
        /* individual tasks resolve/reject their own promises; nothing to do here */
      })
      .finally(() => {
        this.mutexBusy = false;
        this.pumpMutex();
      });
  }

  // -----------------------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------------------

  stop(): void {
    this.stopped = true;
    for (const [lane, rt] of [
      ['left', this.left],
      ['right', this.right],
      ['device', this.device],
      ['settings', this.settingsLane],
    ] as const) {
      void lane;
      if (rt.debounceTimer !== null) this.timers.clearTimeout(rt.debounceTimer);
      if (rt.maxWaitTimer !== null) this.timers.clearTimeout(rt.maxWaitTimer);
      rt.debounceTimer = null;
      rt.maxWaitTimer = null;
      if (rt.pending !== null) {
        const waiters = rt.waiters;
        rt.pending = null;
        rt.waiters = [];
        waiters.forEach((w) => w.reject(new WriteQueueStoppedError()));
      }
    }
    const queued = this.mutexQueue.splice(0, this.mutexQueue.length);
    for (const task of queued) task.abandon();
    for (const handle of this.ownedOverlayHandles.values()) {
      this.snapshot.clearOverlay(handle);
    }
    this.ownedOverlayHandles.clear();
  }
}

function emptyLane<P>(): LaneRuntime<P> {
  return { pending: null, waiters: [], debounceTimer: null, maxWaitTimer: null };
}
