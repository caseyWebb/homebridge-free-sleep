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
 *
 * **Drain-before-decide (`settings-switches` change, #17/#18, tech-lead resolution 1):** the away-
 * mode guard's dispatch-time read above is sufficient only as long as nothing can install a
 * `left.awayMode`/`right.awayMode`-touching overlay *after* a side lane's dispatch has already
 * begun deciding but *before* the settings write that produced it has actually settled — which
 * `submitSettings({awayMode})` (the Away Mode `Switch`'s own write; `src/services/awayMode.ts`)
 * is the first real caller to ever do. Immediately before a side lane's `dispatch()` calls
 * `awayModeGuard.decide()`, it first drains any settings-lane write — still accumulating behind
 * its own debounce, or already flushed and sitting in `mutexQueue` but not yet run — that touches
 * either side's `awayMode`, running it to full settlement *inline*, from within the side lane's
 * own already-held mutex slot, before `decide()` ever runs (`drainAwayModeSettingsIfPending`).
 * This is not a new kind of concurrency the mutex wasn't already designed to serialize: because
 * the side lane still holds `mutexBusy` the entire time, this is equivalent to widening its own
 * exclusive dispatch step by one settings write. Draining *inline* — splicing the settings task
 * out of `mutexQueue` and invoking its `run()` directly, rather than awaiting its own eventual
 * turn through `pumpMutex` — is what avoids deadlock: a task already popped and running under the
 * mutex can never be advanced past by `pumpMutex` awaiting a *different*, still-queued task's turn
 * (nothing shifts `mutexQueue` again until the current task's `run()` promise resolves), so
 * awaiting a separately-queued task from inside a running one would wait forever. The reverse
 * submission order (settings write submitted first) was already safe before this change — its own
 * debounce timer starts first, so its mutex task is enqueued and *runs* first too — and this
 * mechanism costs one cheap field check with no side effect whenever there is nothing to drain,
 * which is true for the overwhelming majority of every side dispatch.
 *
 * **Alarm-only exemption (`alarm-events` change, tech-lead resolution 1):** a reduced side patch
 * whose only field is `isAlarmVibrating` bypasses `awayModeGuard.decide()` entirely — see
 * `isAlarmOnlySidePatch`'s doc below. Upstream never away-scopes this field and never mirrors it
 * either, so this exemption is parity, not a carve-out — without it, the Dismiss-Alarm switch
 * (`src/services/alarm.ts`) would be silently non-functional under the `'block'` policy whenever
 * either side is away, a real regression against issue #16's own "done when" bar.
 *
 * **User-intent priority (`keep-alive`'s design.md, tech-lead resolution 5):** `submitSide`
 * takes an `origin` (`'user'` by default, `'keepAlive'` for `KeepAlive`'s re-arm writes),
 * tracked per field for the lane's currently-accumulating cycle. If that cycle's merged patch
 * ends up carrying both a user-origin `isOn` and a keep-alive-origin `secondsRemaining`, the
 * `secondsRemaining` field is dropped *before* `reduceDurationFields` runs — so a user's
 * explicit power toggle landing in the same debounce window as a keep-alive re-arm always wins,
 * rather than the four-case reduction's ordinary "non-zero `secondsRemaining` beats `isOn`" rule
 * (which exists for a different, single-origin case: `#10`'s own power+temperature merge).
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

/**
 * Who originated a `submitSide` call (`keep-alive`'s design.md, tech-lead resolution 5).
 * `'user'` is the default — every pre-existing caller (`thermostat.ts`'s `onSet` handlers)
 * passes no origin at all and gets exactly today's behavior. `'keepAlive'` is used only by
 * `KeepAlive`'s re-arm writes (`src/pod/keepAlive.ts`).
 */
export type WriteOrigin = 'user' | 'keepAlive';

/**
 * The device-wide lane's patch shape. `isPriming` (hub-accessory) sits alongside the four
 * device-settings fields (poller-and-write-queue) on the same lane — `dispatch()`'s `'device'`
 * branch splits them back apart into a bare top-level `isPriming` and a nested `settings` object
 * at dispatch time, since that's the shape `POST /api/deviceStatus` actually expects (design.md's
 * "Requires a `src/pod/writeQueue.ts` change").
 *
 * S4 (hub-accessory PR #44 review): a caller no longer has to fill in every one of the four
 * `DEVICE_SETTINGS_KEYS` itself to avoid a partial `settings` POST silently dropping the others
 * (`updateSettings` CBOR-encodes exactly the keys it's given, design.md's Decision 5) — `dispatch()`
 * now backfills any key this cycle's patch left unset from a just-refreshed (`refreshDeviceStatus`)
 * observed `settings` object, so a submitter (`LedService`) only ever needs to name the field it is
 * actually changing.
 */
export type DevicePatch = Partial<{
  v: number;
  gainLeft: number;
  gainRight: number;
  ledBrightness: number;
  isPriming: boolean;
}>;

const DEVICE_SETTINGS_KEYS = ['v', 'gainLeft', 'gainRight', 'ledBrightness'] as const;

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
   * S4 (hub-accessory PR #44 review): awaited, when provided, immediately before a `device`-lane
   * dispatch that carries any of `DEVICE_SETTINGS_KEYS` — a bounded read (`poller.refresh
   * ('deviceStatus')` in production, via the same lane-aware callback-injection pattern
   * `requestFastPoll` already establishes so this module never imports `poller.ts`) so the
   * read-modify-write below merges against gains observed as close to dispatch time as possible,
   * not whatever was cached at submission time (up to `pollIntervalMs`, default 30s, stale).
   * Optional — omitted, every existing caller (most tests, and any future one that doesn't wire
   * a poller) gets exactly today's behavior of merging against whatever `snapshot` already holds.
   */
  refreshDeviceStatus?: () => Promise<void>;
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
  /** Trailing-edge debounce per lane. Default 400, enforced minimum 100. Applies to every lane
   * except `device`, which uses `deviceWriteDebounceMs` instead (hub-accessory design.md,
   * Decision 4). */
  writeDebounceMs?: number;
  /**
   * Trailing-edge debounce for the `device` lane specifically. Default 500, enforced minimum
   * 500 — issue #10's own note that a brightness drag (#20) needs a harder debounce than the
   * shared default, without slowing down a side write's own responsiveness (hub-accessory
   * design.md, Decision 4).
   */
  deviceWriteDebounceMs?: number;
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
  /**
   * The origin (`'user'` | `'keepAlive'`) each currently-accumulating field in `pending` was
   * last submitted under — populated only by `submitSide` (device/settings lanes never write to
   * it, and always read back an empty map, which is harmless: `applyOriginPriority` only ever
   * consults it for `isOn`/`secondsRemaining`). Reset to a fresh, empty `Map` at the start of
   * each new write cycle, mirroring `overlayOwnership`'s own per-cycle lifecycle.
   */
  fieldOrigin: Map<string, WriteOrigin>;
}

interface MutexTask {
  run: () => Promise<void>;
  abandon: () => void;
  /**
   * `settings-switches`' drain-before-decide mechanism (module doc's "Drain-before-decide"
   * section): present — and always the settings lane's *own reduced patch object*, never merely
   * a boolean — only for a mutex task created from a settings-lane flush; `undefined` for every
   * `left`/`right`/`device`-lane task and for the mirror's own one-shot task. `dispatch()` reads
   * this to find and drain a not-yet-run settings write touching either side's `awayMode` before
   * a side lane consults `awayModeGuard.decide()` — see `drainAwayModeSettingsIfPending`.
   */
  settingsPatch?: SettingsPatch;
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

/**
 * User-intent priority (`keep-alive`'s design.md, tech-lead resolution 5): runs *before*
 * `reduceDurationFields`. A merged patch carrying both a user-origin `isOn` and a
 * keep-alive-origin `secondsRemaining` has `secondsRemaining` dropped outright, so the
 * duration-field reduction below never even sees it — the user's explicit power toggle is what
 * reaches the Pod, and no optimistic "off" tile installed for it is ever recomputed away. Every
 * other origin combination (both `'user'`, or no `isOn` present in this cycle at all — the
 * ordinary case for a plain re-arm with nothing else pending) is unaffected.
 */
function applyOriginPriority(patch: SidePatch, fieldOrigin: ReadonlyMap<string, WriteOrigin>): SidePatch {
  if (patch.isOn === undefined || patch.secondsRemaining === undefined) return patch;
  const isOnOrigin = fieldOrigin.get('isOn') ?? 'user';
  const secondsRemainingOrigin = fieldOrigin.get('secondsRemaining') ?? 'user';
  // N6: this drops the keep-alive re-arm the same way whether the user's `isOn` is `false` or
  // `true` — a user turning a side back *on* in the same window also wins outright, deliberately:
  // the Pod's own `isOn: true` already gets the full 12h duration (module doc above), so the
  // keep-alive re-arm's more precise duration has nothing to add here either.
  if (isOnOrigin === 'user' && secondsRemainingOrigin === 'keepAlive') {
    const reduced = { ...patch };
    delete reduced.secondsRemaining;
    return reduced;
  }
  return patch;
}

function isSideLane(lane: LaneId): lane is Side {
  return lane === 'left' || lane === 'right';
}

/**
 * `alarm-events` (#16, tech-lead resolution 1): whether a reduced side patch's only field is
 * `isAlarmVibrating` — upstream's own `updateSide` never consults `controlBothSides`/
 * `updateLeft`/`updateRight` for this field at all; it always targets the addressed `side`
 * unconditionally (`test/mockPod.ts`'s `updateSide`, mirroring `server/src/routes/deviceStatus/
 * updateDeviceStatus.ts`). A patch whose only field is `isAlarmVibrating` therefore bypasses the
 * away-mode guard entirely — never blocked, never mirrored — exactly matching that unconditional
 * upstream behavior. Anything else in the patch keeps full guard semantics.
 */
function isAlarmOnlySidePatch(patch: SidePatch): boolean {
  const keys = Object.keys(patch);
  return keys.length === 1 && keys[0] === 'isAlarmVibrating';
}

/**
 * `settings-switches`' drain-before-decide mechanism: whether a settings-lane patch touches
 * either side's `awayMode` — the only settings field this mechanism cares about draining early
 * (design.md's "The ordering hazard"; a patch touching only, say, `primePodDaily` never needs to
 * race a side lane's `decide()` at all).
 */
function touchesAwayMode(patch: SettingsPatch): boolean {
  return patch.left?.awayMode !== undefined || patch.right?.awayMode !== undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WriteQueue {
  private readonly client: PodClient;
  private readonly snapshot: SnapshotStore;
  private readonly requestFastPoll: (lane: FastPollLane, untilMs: number) => void;
  /** S4 fix — see `WriteQueueOptions.refreshDeviceStatus`'s doc. */
  private readonly refreshDeviceStatus: (() => Promise<void>) | undefined;
  private readonly awayModeGuard: AwayModeGuard;
  private readonly timers: TimerApi;
  private readonly logger: Logger;

  private readonly writeDebounceMs: number;
  private readonly deviceWriteDebounceMs: number;
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
    this.refreshDeviceStatus = options.refreshDeviceStatus;
    this.timers = options.timers ?? defaultTimerApi;
    this.logger = options.logger ?? defaultLogger;

    this.writeDebounceMs = Math.max(100, options.writeDebounceMs ?? 400);
    this.deviceWriteDebounceMs = Math.max(500, options.deviceWriteDebounceMs ?? 500);
    this.writeMaxDebounceMs = options.writeMaxDebounceMs ?? 2000;
    this.writeSettleMs = options.writeSettleMs ?? 15_000;
    this.fastPollDurationMs = options.fastPollDurationMs ?? 90_000;

    this.awayModeGuard =
      options.awayModeGuard ?? new AwayModeGuard({ snapshot: options.snapshot, policy: 'mirror', logger: this.logger });
  }

  // -----------------------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------------------

  submitSide(side: Side, patch: SidePatch, origin: WriteOrigin = 'user'): Promise<void> {
    const rt = side === 'left' ? this.left : this.right;
    return this.submit(
      side,
      rt,
      patch,
      () => this.syncSideOverlays(side, this.reducedSidePatch(rt), rt.overlayOwnership),
      (isNewCycle) => {
        if (isNewCycle) rt.fieldOrigin.clear();
        for (const key of Object.keys(patch)) rt.fieldOrigin.set(key, origin);
      },
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

  /** `reduceDurationFields(rt.pending)`, but with user-intent priority (module doc's "User-intent
   * priority" section) applied first — the same order the eventual dispatch uses. */
  private reducedSidePatch(rt: LaneRuntime<SidePatch>): SidePatch {
    return reduceDurationFields(applyOriginPriority(rt.pending ?? {}, rt.fieldOrigin));
  }

  private submit<P extends object>(
    lane: LaneId,
    rt: LaneRuntime<P>,
    patch: P,
    syncOverlays: () => void,
    onMerge?: (isNewCycle: boolean) => void,
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
        onMerge?.(true);
      } else {
        Object.assign(rt.pending, patch);
        onMerge?.(false);
      }
      rt.waiters.push({ resolve, reject });
      if (rt.debounceTimer !== null) this.timers.clearTimeout(rt.debounceTimer);
      const debounceMs = lane === 'device' ? this.deviceWriteDebounceMs : this.writeDebounceMs;
      rt.debounceTimer = this.timers.setTimeout(() => this.flush(lane, rt), debounceMs);
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
    // Captured (and reset) here, not read live at dispatch time — the next cycle's own
    // submissions must never retroactively change what origin *this* flushed cycle dispatches
    // under (module doc's "User-intent priority").
    const fieldOrigin = new Map(rt.fieldOrigin);
    rt.pending = null;
    rt.waiters = [];
    rt.fieldOrigin = new Map();
    if (rt.debounceTimer !== null) {
      this.timers.clearTimeout(rt.debounceTimer);
      rt.debounceTimer = null;
    }
    if (rt.maxWaitTimer !== null) {
      this.timers.clearTimeout(rt.maxWaitTimer);
      rt.maxWaitTimer = null;
    }
    this.enqueueDispatch(lane, patch, waiters, ownership, fieldOrigin);
  }

  private enqueueDispatch(
    lane: LaneId,
    patch: object,
    waiters: Waiter[],
    ownership: Map<string, OverlayHandle>,
    fieldOrigin: ReadonlyMap<string, WriteOrigin>,
  ): void {
    const task: MutexTask = {
      run: () => this.dispatch(lane, patch, waiters, ownership, fieldOrigin),
      abandon: () => waiters.forEach((w) => w.reject(new WriteQueueStoppedError())),
      ...(lane === 'settings' ? { settingsPatch: patch as SettingsPatch } : {}),
    };
    this.mutexQueue.push(task);
    this.pumpMutex();
  }

  /**
   * Drain-before-decide (design.md's "The ordering hazard: mechanism, and why the two candidate
   * fixes differ..."; tech-lead resolution 1): called only from inside `dispatch()`, immediately
   * before a side lane consults `awayModeGuard.decide()` — never from anywhere else, and never
   * for the settings lane's own dispatch (which never calls this). At that call site this method
   * always runs from *inside* an already-running mutex task (`mutexBusy` is `true` for this
   * call's entire duration, since `dispatch()` only ever runs as a `MutexTask.run()` body) — so
   * nothing else can be popped from `mutexQueue` while this `await` is outstanding. Forcing a
   * settings write to run *inline*, right now, rather than merely awaiting its own eventual mutex
   * turn is what avoids deadlock: that write's own task, if already enqueued, is spliced out of
   * `mutexQueue` first and its `run()` is invoked directly (a plain recursive call into
   * `dispatch()` for the settings lane, not a re-entry into `pumpMutex`) — so it is not dispatched
   * a second time later, and the calling side lane's own mutex slot is simply widened by one
   * settings write, exactly as design.md describes, not a new kind of concurrency.
   *
   * Two states are possible for a settings-lane write that touches `awayMode` at the moment a
   * side lane is about to decide (a third — "currently dispatching" — cannot coexist with the
   * side lane's own dispatch already running, since the mutex is exclusive):
   *
   *   1. Still accumulating: `settingsLane.pending` is non-null and its debounce timer has not
   *      yet fired. `flush()` is called directly (bypassing the debounce wait, but not skipping
   *      any of its bookkeeping) to turn it into case 2 immediately.
   *   2. Already flushed, sitting in `mutexQueue` behind (or ahead of, order does not matter)
   *      other queued tasks, not yet run. Found via each task's own `settingsPatch` tag (set by
   *      `enqueueDispatch` only for a settings-lane task) rather than a single dedicated pointer,
   *      since — rarely — more than one settings-lane write can be queued at once (a second
   *      submission's own cycle flushing while an earlier one is still waiting its mutex turn);
   *      the loop below drains every matching one, in order, not just the first.
   *
   * The common case — no settings-lane write pending or queued at all, or one pending/queued that
   * does not touch `awayMode` — costs one cheap field check (`settingsLane.pending`) plus an
   * `Array.prototype.findIndex` over whatever is currently in `mutexQueue` (typically empty or
   * very small), with no side effect and no `await` actually suspending anything.
   */
  private async drainAwayModeSettingsIfPending(): Promise<void> {
    if (this.settingsLane.pending !== null && touchesAwayMode(this.settingsLane.pending)) {
      this.flush('settings', this.settingsLane);
    }
    for (;;) {
      const idx = this.mutexQueue.findIndex((t) => t.settingsPatch !== undefined && touchesAwayMode(t.settingsPatch));
      if (idx === -1) return;
      const [task] = this.mutexQueue.splice(idx, 1);
      if (task) await task.run();
    }
  }

  private async dispatch(
    lane: LaneId,
    patch: object,
    waiters: Waiter[],
    ownership: Map<string, OverlayHandle>,
    fieldOrigin: ReadonlyMap<string, WriteOrigin>,
  ): Promise<void> {
    let body: object;
    let sideReduced: SidePatch | undefined;
    let awayDecision: AwayModeDecision = 'plain';
    if (isSideLane(lane)) {
      sideReduced = reduceDurationFields(applyOriginPriority(patch as SidePatch, fieldOrigin));
      this.logger.debug(`writeQueue: ${lane} submitted ${JSON.stringify(patch)}, dispatching ${JSON.stringify(sideReduced)}`);

      // N8 (alarm-events PR #45 review, tech-lead ruling): a dismiss (`isAlarmVibrating`)
      // coalesced with *any* other field in the same debounce window must not inherit that other
      // field's guard outcome — the `isAlarmOnlySidePatch` bypass below only ever fires when the
      // *whole* reduced patch is alarm-only, so a merged patch like `{isAlarmVibrating, isOn}`
      // previously fell through to `decide()` and got blocked wholesale under `'block'`+away,
      // silently defeating the alarm-only exemption whenever a dismiss happened to land in the
      // same debounce window as any other field. Peeled into its own dispatch cycle — evaluated
      // and settled independently of `awayModeGuard.decide()`, *before* that decision is ever
      // made for the rest of the patch — so "dismiss always lands; the guarded remainder gets
      // normal treatment," exactly as it would if the two fields had never coalesced at all.
      if (sideReduced.isAlarmVibrating !== undefined && Object.keys(sideReduced).length > 1) {
        const alarmValue = sideReduced.isAlarmVibrating;
        const alarmKey = `${lane}:isAlarmVibrating`;
        const alarmOwnership = new Map<string, OverlayHandle>();
        const alarmHandle = ownership.get(alarmKey);
        if (alarmHandle) {
          ownership.delete(alarmKey);
          alarmOwnership.set(alarmKey, alarmHandle);
        }
        this.liveOverlayBatches.add(alarmOwnership);
        const remainder = { ...sideReduced };
        delete remainder.isAlarmVibrating;
        sideReduced = remainder;
        try {
          await this.settleWrite(
            alarmOwnership,
            'deviceStatus',
            () => this.client.postDeviceStatus({ [lane]: { isAlarmVibrating: alarmValue } } as DeviceStatusPatch),
            'clear',
          );
        } catch (error) {
          this.logger.debug(`writeQueue: peeled alarm-only write to ${lane} failed: ${describeError(error)}`);
        }
      }

      body = { [lane]: sideReduced };

      if (isAlarmOnlySidePatch(sideReduced)) {
        // alarm-events (#16, tech-lead resolution 1): an alarm-only patch bypasses `decide()`
        // entirely — see `isAlarmOnlySidePatch`'s doc. `awayDecision` stays `'plain'`, so the
        // `'mirror'` branch below never fires for it either. After the N8 peel above, `sideReduced`
        // can only still satisfy this when the *original* submitted patch was alarm-only to begin
        // with (the peel requires more than one field) — the coalesced case is handled entirely
        // above instead.
        awayDecision = 'plain';
      } else {
        // settings-switches' drain-before-decide (tech-lead resolution 1): widen this dispatch's
        // own exclusive mutex section by one settings write, if (and only if) one touching either
        // side's `awayMode` is currently pending or queued but not yet settled — see
        // `drainAwayModeSettingsIfPending`'s own doc for the full mechanism and why this avoids
        // deadlock. A no-op, zero-`await`-suspension check in the overwhelming common case (no
        // such write outstanding).
        await this.drainAwayModeSettingsIfPending();

        // Away-mode guard consultation (see the module doc's "Away-mode guard" section): a
        // synchronous decision, made and acted on before any request for this write is issued.
        awayDecision = this.awayModeGuard.decide();
        if (awayDecision === 'block') {
          if (!this.stopped) this.clearOwnership(ownership);
          this.liveOverlayBatches.delete(ownership);
          waiters.forEach((w) => w.reject(new AwayModeBlockedError()));
          return;
        }
      }
    } else if (lane === 'device') {
      // hub-accessory's widening: the device-wide lane now carries a bare `isPriming` field
      // alongside the four device-settings fields (design.md's "Requires a
      // `src/pod/writeQueue.ts` change") — split back apart here into the shape
      // `POST /api/deviceStatus` actually expects, rather than nesting `isPriming` under
      // `settings` (which the Pod would silently ignore, `settings` being CBOR-encoded
      // key-for-key).
      const devicePatch = patch as DevicePatch;
      const wantsSettingsWrite = DEVICE_SETTINGS_KEYS.some((key) => devicePatch[key] !== undefined);
      // S4 fix (hub-accessory PR #44 review): a bounded pre-dispatch refresh, only when this
      // dispatch actually touches the settings sub-object — an `isPriming`-only patch (PrimeService)
      // has no gains to keep fresh and gains nothing from the extra round trip. `this.stopped` is
      // re-checked below (`settleWrite`'s own convention) since `stop()` can land while this await
      // is outstanding.
      if (wantsSettingsWrite && this.refreshDeviceStatus) {
        try {
          await this.refreshDeviceStatus();
        } catch (error) {
          this.logger.debug(`writeQueue: pre-dispatch deviceStatus refresh failed: ${describeError(error)}`);
        }
      }
      // The read-modify-write itself: fresh (post-refresh) observed settings are the base, and
      // only the field(s) this cycle actually asked to change (present in `devicePatch`) override
      // them — never the other way around, or a stale value captured back at submission time
      // would win over the very refresh just performed.
      const freshSettings = this.snapshot.get().documents.deviceStatus?.settings;
      const settingsFields: DevicePatch = {};
      if (wantsSettingsWrite) {
        for (const key of DEVICE_SETTINGS_KEYS) {
          const value = devicePatch[key] ?? freshSettings?.[key];
          if (value !== undefined) settingsFields[key] = value;
        }
      }
      body = {
        ...(devicePatch.isPriming !== undefined ? { isPriming: devicePatch.isPriming } : {}),
        ...(Object.keys(settingsFields).length > 0 ? { settings: settingsFields } : {}),
      };
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
   * Only `targetTemperatureF`/`isOn` are ever mirrored — `secondsRemaining` is never overlayable
   * (`snapshot.ts`'s `OverlayableField`) and is not a "user-visible field" the away-mode-guard
   * spec asks to be reflected, and `isAlarmVibrating` (S6, alarm-events PR #45 review) is never
   * mirrored either: upstream's own `updateSide` never consults `controlBothSides` for this
   * field at all (`isAlarmOnlySidePatch`'s doc), so mirroring it here would be a plugin-specific
   * behavior with no upstream counterpart. In practice `reduced` can no longer even carry
   * `isAlarmVibrating` by the time it reaches this method — N8 (same review) peels it into its
   * own, always-addressed-only dispatch cycle in `dispatch()` before `awayDecision` is ever
   * computed, and a patch whose *only* field is `isAlarmVibrating` never reaches `'mirror'` at
   * all (`isAlarmOnlySidePatch` forces `awayDecision = 'plain'`) — this omission is kept as an
   * explicit, self-documenting invariant rather than relying on that upstream call site alone.
   */
  private mirrorToOtherSide(side: Side, reduced: SidePatch): void {
    const otherSide: Side = side === 'left' ? 'right' : 'left';
    const mirrorPatch: SidePatch = {};
    if (reduced.targetTemperatureF !== undefined) mirrorPatch.targetTemperatureF = reduced.targetTemperatureF;
    if (reduced.isOn !== undefined) mirrorPatch.isOn = reduced.isOn;
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
    // CI regression (alarm-events PR #45 review): `liveOverlayBatches` only ever tracks a write
    // cycle's overlay while it is still in flight — `settleWrite`'s own tail removes a cycle
    // from it the moment that cycle settles, success or failure, since from *this* queue's
    // perspective it is done. A cycle that already settled successfully before `stop()` runs
    // still has a live overlay sitting in `SnapshotStore` with its own pending `writeSettleMs`
    // expiry timer, which the loop above therefore never reaches — this blanket call is what
    // actually clears it. See `clearAllOverlaysForShutdown`'s own doc for why this lives on
    // `SnapshotStore` rather than being reconstructed here from `WriteQueue`'s own bookkeeping.
    this.snapshot.clearAllOverlaysForShutdown();
  }
}

function emptyLane<P>(): LaneRuntime<P> {
  return {
    pending: null,
    waiters: [],
    debounceTimer: null,
    maxWaitTimer: null,
    overlayOwnership: new Map(),
    fieldOrigin: new Map(),
  };
}
