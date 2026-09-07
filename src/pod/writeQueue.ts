/**
 * `WriteQueue` — turns user intent into the smallest, safest possible amount of Pod traffic
 * (pod-write-queue spec).
 *
 * Pipeline: submit → per-lane trailing-edge debounce with field merging → the
 * power/duration reduction → one global FIFO mutex across every lane and both write endpoints
 * → dispatch → settle (design.md, "Write queue pipeline"). The optimistic overlay is installed
 * on the snapshot at submission (not dispatch) so the cached view never goes stale while a
 * write is queued, re-based to the settle time on success, and cleared immediately on failure —
 * *except* the away-mode-guard mirror's own dispatch (`mirrorToOtherSide` below), whose overlay
 * is kept and rebased even when its POST fails, since the addressed write it followed already
 * succeeded and free-sleep's `controlBothSides` already applied it to both sides server-side
 * (see `settleWrite`'s doc, the shared tail both dispatches share, parameterized by this
 * distinction — F1 fix).
 *
 * Each write cycle (one lane's accumulating patch, from its first submission through its
 * dispatch settling) owns its overlay handles in a Map private to that cycle — never a
 * queue-wide table keyed only by side+field. Two write cycles for the same lane can be live at
 * once (one still dispatching while the next is already accumulating, or already dispatching
 * behind the mutex), each installing overlays for the same field; keying ownership by cycle
 * rather than by field is what keeps a later cycle's install, rebase, or clear from ever
 * touching an earlier cycle's still-live overlay for that same field.
 *
 * Imports `client.ts`, `snapshot.ts`, `errors.ts`, `types.ts` and — as of the away-mode-guard
 * change — `awayModeGuard.ts` (never `poller.ts`; design.md, "Module dependency direction").
 * Requesting the post-write confirmation goes through the injected `requestFastPoll(lane,
 * untilMs)` callback instead — `lane` distinguishes a `deviceStatus`-endpoint write (wired to
 * `poller.requestMode('deviceStatus', …)`, the extended fast-poll window) from a
 * `settings`-endpoint write (wired to `poller.refresh('settings')`, a single confirming read — a
 * settings write has no reason to accelerate `deviceStatus` polling).
 *
 * **Away-mode guard (tech-lead resolution 2, away-mode-guard/design.md's final "Resolutions"
 * section):** every side-lane dispatch consults the injected `AwayModeGuard` — deliberately
 * *inside* `dispatch()`, not as a front-door wrapper callers must remember to use, so that
 * `submitSide` protects every originator (thermostat, keep-alive, any future caller) uniformly.
 * This does narrow the pod-write-queue spec's original "the queue holds no policy about away
 * mode" requirement (see that spec's own delta in this change) — the queue still originates no
 * write of its own on behalf of a *caller* and still never reads schedules; it now *does* apply
 * the configured away-mode policy to a side write it is asked to dispatch. The decision itself
 * is a synchronous snapshot read with no `await`, and `dispatch()` already runs serialized behind
 * the write mutex for its entire async lifetime (see `pumpMutex` below) — so no separate
 * `runExclusive` call is needed to make the check atomic against another in-flight dispatch.
 */

import { AwayModeGuard, AwayModeBlockedError, type AwayModeDecision } from './awayModeGuard.ts';
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

/**
 * Which confirmation path a successful dispatch needs. `left`/`right`/`device` all write
 * through `POST /api/deviceStatus`, confirmed by accelerating the poller's `deviceStatus` class;
 * `settings` writes through `POST /api/settings` and is confirmed by a single re-read of that
 * class instead — accelerating `deviceStatus` would buy it nothing.
 */
export type FastPollLane = 'deviceStatus' | 'settings';

export interface WriteQueueOptions {
  client: PodClient;
  snapshot: SnapshotStore;
  /** Called on success only, naming which class's confirmation the dispatch needs. */
  requestFastPoll: (lane: FastPollLane, untilMs: number) => void;
  /**
   * Consulted on every side-lane dispatch (away-mode-guard change, tech-lead resolution 2).
   * Defaults to an internally-constructed guard using `policy: 'mirror'` (the config default)
   * against the same `snapshot` — so a caller that doesn't care about away mode (most existing
   * tests, and any future caller that never configures the policy) gets exactly today's
   * behavior: `decide()` returns `'plain'` whenever neither side is away, at zero extra cost.
   */
  awayModeGuard?: AwayModeGuard;
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
  /**
   * The overlay handles *this write cycle* has installed, keyed by `${side}:${field}` — replaced
   * with a fresh, empty `Map` each time a new cycle starts accumulating (see `submit`). Reading
   * and writing this table only ever touches the current cycle's own installs, which is what
   * keeps a later cycle's overlay sync from clearing an earlier, still-settling cycle's handle
   * for the same field (see the module doc above).
   */
  overlayOwnership: Map<string, OverlayHandle>;
}

interface MutexTask {
  run: () => Promise<void>;
  abandon: () => void;
}

type SideOverlayField = 'targetTemperatureF' | 'isOn' | 'isAlarmVibrating' | 'awayMode';

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WriteQueue {
  private readonly client: PodClient;
  private readonly snapshot: SnapshotStore;
  private readonly requestFastPoll: (lane: FastPollLane, untilMs: number) => void;
  private readonly awayModeGuard: AwayModeGuard;
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

  /**
   * Every write cycle's `overlayOwnership` map, from the moment it starts accumulating until its
   * dispatch settles — including cycles still sitting in `mutexQueue` behind another lane's
   * dispatch. `stop()` walks this set to clear every overlay still live anywhere in the queue,
   * regardless of which cycle (pending, queued, or in-flight) installed it.
   */
  private readonly liveOverlayBatches = new Set<Map<string, OverlayHandle>>();

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

    this.awayModeGuard =
      options.awayModeGuard ?? new AwayModeGuard({ snapshot: options.snapshot, policy: 'mirror', logger: this.logger });
  }

  // -----------------------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------------------

  submitSide(side: Side, patch: SidePatch): Promise<void> {
    const rt = side === 'left' ? this.left : this.right;
    return this.submit(side, rt, patch, () =>
      this.syncSideOverlays(side, reduceDurationFields(rt.pending ?? {}), rt.overlayOwnership),
    );
  }

  submitDeviceSettings(patch: DevicePatch): Promise<void> {
    return this.submit('device', this.device, patch, () => {
      /* no overlayable fields on the device lane */
    });
  }

  submitSettings(patch: SettingsPatch): Promise<void> {
    return this.submit('settings', this.settingsLane, patch, () =>
      this.syncAwayModeOverlays(this.settingsLane.pending ?? {}, this.settingsLane.overlayOwnership),
    );
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
        // A new write cycle starts here — its own overlay-ownership table, tracked separately
        // from any still-settling earlier cycle for this lane (module doc above).
        rt.overlayOwnership = new Map();
        this.liveOverlayBatches.add(rt.overlayOwnership);
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

  private syncSideOverlays(side: Side, reduced: SidePatch, ownership: Map<string, OverlayHandle>): void {
    this.applyOrClearOverlay(ownership, side, 'targetTemperatureF', reduced.targetTemperatureF);
    this.applyOrClearOverlay(ownership, side, 'isOn', reduced.isOn);
    this.applyOrClearOverlay(ownership, side, 'isAlarmVibrating', reduced.isAlarmVibrating);
  }

  private syncAwayModeOverlays(patch: SettingsPatch, ownership: Map<string, OverlayHandle>): void {
    this.applyOrClearOverlay(ownership, 'left', 'awayMode', patch.left?.awayMode);
    this.applyOrClearOverlay(ownership, 'right', 'awayMode', patch.right?.awayMode);
  }

  /**
   * Installs or clears one field's overlay against `ownership` — the *current write cycle's own*
   * table, never a queue-wide one. Clearing here (the field is absent from this cycle's reduced
   * patch) only ever finds and clears a handle this same cycle previously installed; it can
   * never reach into a different cycle's entry for the same field, because that entry lives in a
   * different `Map` object entirely.
   */
  private applyOrClearOverlay(
    ownership: Map<string, OverlayHandle>,
    side: Side,
    field: SideOverlayField,
    value: number | boolean | undefined,
  ): void {
    const key = `${side}:${field}`;
    if (value === undefined) {
      const existing = ownership.get(key);
      if (existing) {
        this.snapshot.clearOverlay(existing);
        ownership.delete(key);
      }
      return;
    }
    const handle =
      field === 'targetTemperatureF'
        ? this.snapshot.setOverlay(side, field, value as number, this.writeSettleMs)
        : this.snapshot.setOverlay(side, field, value as boolean, this.writeSettleMs);
    ownership.set(key, handle);
  }

  /**
   * Re-installs every overlay entry this write cycle owns with the *same* value but a fresh
   * `writeSettleMs` window measured from now (dispatch-settle time) — pod-write-queue spec,
   * "The settle window starts when the write lands". Reading the value back off the current
   * effective snapshot is safe: nothing else can have changed it between submission and this
   * dispatch settling, since this queue is the only writer of these overlay entries.
   */
  private rebaseOwnership(ownership: Map<string, OverlayHandle>): void {
    for (const [key, handle] of ownership) {
      const value = this.snapshot.get()[handle.side][handle.field];
      if (value === undefined) continue;
      const refreshed =
        handle.field === 'targetTemperatureF'
          ? this.snapshot.setOverlay(handle.side, handle.field, value as number, this.writeSettleMs)
          : this.snapshot.setOverlay(handle.side, handle.field, value as boolean, this.writeSettleMs);
      ownership.set(key, refreshed);
    }
  }

  private clearOwnership(ownership: Map<string, OverlayHandle>): void {
    for (const handle of ownership.values()) {
      this.snapshot.clearOverlay(handle);
    }
    ownership.clear();
  }

  // -----------------------------------------------------------------------------------
  // Debounce flush → dispatch
  // -----------------------------------------------------------------------------------

  private flush<P extends object>(lane: LaneId, rt: LaneRuntime<P>): void {
    if (rt.pending === null) return;
    const patch = rt.pending;
    const waiters = rt.waiters;
    const ownership = rt.overlayOwnership;
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
    this.enqueueDispatch(lane, patch, waiters, ownership);
  }

  private enqueueDispatch(lane: LaneId, patch: object, waiters: Waiter[], ownership: Map<string, OverlayHandle>): void {
    const task: MutexTask = {
      run: () => this.dispatch(lane, patch, waiters, ownership),
      abandon: () => waiters.forEach((w) => w.reject(new WriteQueueStoppedError())),
    };
    this.mutexQueue.push(task);
    this.pumpMutex();
  }

  private async dispatch(lane: LaneId, patch: object, waiters: Waiter[], ownership: Map<string, OverlayHandle>): Promise<void> {
    let body: object;
    let sideReduced: SidePatch | undefined;
    let awayDecision: AwayModeDecision = 'plain';
    if (isSideLane(lane)) {
      sideReduced = reduceDurationFields(patch as SidePatch);
      this.logger.debug(`writeQueue: ${lane} submitted ${JSON.stringify(patch)}, dispatching ${JSON.stringify(sideReduced)}`);
      body = { [lane]: sideReduced };

      // Away-mode guard consultation (see the module doc's "Away-mode guard" section): a
      // synchronous decision, made and acted on before any request for this write is issued.
      awayDecision = this.awayModeGuard.decide();
      if (awayDecision === 'block') {
        if (!this.stopped) this.clearOwnership(ownership);
        this.liveOverlayBatches.delete(ownership);
        waiters.forEach((w) => w.reject(new AwayModeBlockedError()));
        return;
      }
    } else if (lane === 'device') {
      body = { settings: patch };
    } else {
      body = patch;
    }

    const fastPollLane: FastPollLane = lane === 'settings' ? 'settings' : 'deviceStatus';
    try {
      await this.settleWrite(
        ownership,
        fastPollLane,
        () =>
          lane === 'settings'
            ? this.client.postSettings(body as SettingsPatch)
            : this.client.postDeviceStatus(body as DeviceStatusPatch),
        'clear',
      );
      if (!this.stopped && isSideLane(lane) && awayDecision === 'mirror' && sideReduced) {
        this.mirrorToOtherSide(lane, sideReduced);
      }
      waiters.forEach((w) => w.resolve());
    } catch (error) {
      waiters.forEach((w) => w.reject(error));
    }
  }

  /**
   * The shared post → rebase/clear → requestFastPoll tail every dispatch (addressed or
   * mirrored) ends with, parameterized by what a *failed* POST should do to `ownership`'s
   * overlay (F1 fix):
   *
   * - `'clear'` (the addressed dispatch): if the Pod never received this write, its overlay is
   *   the only record of an intent that never took effect — keeping it would show the caller a
   *   value the Pod doesn't have, so it is cleared immediately, reverting `get()` to raw truth.
   * - `'rebase'` (the mirror's own one-shot dispatch, see `mirrorToOtherSide` below): the mirror
   *   only ever runs *after* the addressed POST already succeeded, and free-sleep's
   *   `controlBothSides` applies that addressed write to **both** sides server-side (`docs/
   *   POD-API.md`) — so even when this second, mirrored POST itself fails, the overlay's value
   *   is still more truthful than falling back to the stale raw cache. It is kept and rebased
   *   exactly like a success, rather than cleared.
   *
   * Success always rebases and requests the fast poll, regardless of policy — `onFailure` only
   * changes what happens when `post()` rejects. `liveOverlayBatches` bookkeeping happens here
   * once, for every caller, instead of being duplicated at each call site.
   */
  private async settleWrite(
    ownership: Map<string, OverlayHandle>,
    fastPollLane: FastPollLane,
    post: () => Promise<void>,
    onFailure: 'clear' | 'rebase',
  ): Promise<void> {
    let error: unknown;
    try {
      await post();
    } catch (caught) {
      error = caught;
    }
    const succeeded = error === undefined;
    if (!this.stopped) {
      if (succeeded || onFailure === 'rebase') {
        this.rebaseOwnership(ownership);
        this.requestFastPoll(fastPollLane, this.timers.now() + this.fastPollDurationMs);
      } else {
        this.clearOwnership(ownership);
      }
    }
    this.liveOverlayBatches.delete(ownership);
    if (!succeeded) throw error;
  }

  /**
   * The `'mirror'` policy's extra write (design.md, "Mirroring reuses `submitSide`, not a second
   * overlay writer"): reuses this queue's own overlay-install/rebase/clear/fast-poll machinery
   * for the mirrored side, but as a dedicated, one-shot mutex task rather than by re-entering
   * `submitSide`/`dispatch()` for the other side.
   *
   * This is deliberate, not merely an optimization: re-entering `dispatch()` for the mirrored
   * side would consult `awayModeGuard.decide()` again there too, and — since the policy and the
   * away-mode state have not changed — it would decide `'mirror'` again and mirror *back* to the
   * originating side, and so on forever. Moving the guard consultation inside `dispatch()`
   * (resolution 2) makes every side-lane dispatch a candidate for guarding, including one this
   * method itself creates; this method sidesteps that by never routing its own write back
   * through the guarded path at all — it only ever installs the overlay and dispatches once.
   *
   * Only the overlayable fields (`targetTemperatureF`, `isOn`, `isAlarmVibrating`) are mirrored —
   * `secondsRemaining` is never overlayable (`snapshot.ts`'s `OverlayableField`) and is not a
   * "user-visible field" the away-mode-guard spec asks to be reflected.
   */
  private mirrorToOtherSide(side: Side, reduced: SidePatch): void {
    const otherSide: Side = side === 'left' ? 'right' : 'left';
    const mirrorPatch: SidePatch = {};
    if (reduced.targetTemperatureF !== undefined) mirrorPatch.targetTemperatureF = reduced.targetTemperatureF;
    if (reduced.isOn !== undefined) mirrorPatch.isOn = reduced.isOn;
    if (reduced.isAlarmVibrating !== undefined) mirrorPatch.isAlarmVibrating = reduced.isAlarmVibrating;
    if (Object.keys(mirrorPatch).length === 0) return;

    const ownership = new Map<string, OverlayHandle>();
    this.liveOverlayBatches.add(ownership);
    // Installed synchronously, right now — before the mirrored request is even issued — so the
    // cached view (and HomeKit) reflects the other side's change without waiting for a poll,
    // matching every other overlay install this queue makes (module doc, "The optimistic overlay
    // is installed on the snapshot at submission").
    this.syncSideOverlays(otherSide, mirrorPatch, ownership);

    const task: MutexTask = {
      run: async () => {
        try {
          await this.settleWrite(
            ownership,
            'deviceStatus',
            () => this.client.postDeviceStatus({ [otherSide]: mirrorPatch } as DeviceStatusPatch),
            // F1 fix: a failed mirror POST keeps (rebases) the overlay rather than clearing it —
            // see `settleWrite`'s doc for why the overlay is still more truthful than raw cache
            // here, unlike the addressed dispatch's 'clear' policy.
            'rebase',
          );
        } catch (error) {
          this.logger.debug(`writeQueue: mirrored away-mode write to ${otherSide} failed: ${describeError(error)}`);
        }
      },
      abandon: () => {
        this.clearOwnership(ownership);
        this.liveOverlayBatches.delete(ownership);
      },
    };
    this.mutexQueue.push(task);
    this.pumpMutex();
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
    // Clears every write cycle's overlays — pending, queued behind the mutex, or in-flight alike
    // — since `liveOverlayBatches` holds all of them regardless of which stage they're at.
    for (const ownership of this.liveOverlayBatches) {
      this.clearOwnership(ownership);
    }
    this.liveOverlayBatches.clear();
  }
}

function emptyLane<P>(): LaneRuntime<P> {
  return { pending: null, waiters: [], debounceTimer: null, maxWaitTimer: null, overlayOwnership: new Map() };
}
