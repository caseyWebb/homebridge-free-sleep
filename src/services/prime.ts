/**
 * The hub's "Pod Prime" `Switch` (specs/hub-accessory/spec.md's prime requirements;
 * `hub-accessory`'s design.md Decision 3). Config-gated (`ctx.config.primeSwitch`, default
 * `false`).
 *
 * `On`'s `onGet`/push reflects the already-shipped `EffectiveSnapshot.isPriming`. Writing `true`
 * submits `{isPriming: true}` on the device lane (idempotent upstream — a second `PRIME` while
 * already priming is the Pod's own business, not special-cased here). Writing `false` is refused
 * *before* any request is sent: `updateDeviceStatus.ts` only ever sends `PRIME` when `isPriming`
 * is truthy — there is no stop command, so a `{isPriming: false}` patch is a proven no-op
 * (design.md's Context). This mirrors `away-mode-guard`'s own established refuse-then-revert
 * shape (`AwayModeBlockedError` / `scheduleAwayModeRevert` in `src/services/thermostat.ts`),
 * reusing the same `NOT_ALLOWED_IN_CURRENT_STATE` mapping.
 *
 * S3 (hub-accessory PR #44 review): a successful `{isPriming: true}` dispatch only ever accelerates
 * polling (design.md's Decision 2) — it never itself corrects the tile. If the Pod never actually
 * starts priming (hardware refusal, a race, or anything else that keeps the confirming polls
 * reporting `isPriming: false`), `snapshot`'s diff never fires — `false` to `false` is not a
 * change — so `handleSnapshotChanges` never calls `refresh()`, and the tile HAP flipped optimistically
 * to `On` on the successful `onSet` latches there forever. The fix: after a successful `On`-write
 * settles, schedule exactly one bounded corrective `refresh()` — reusing the same
 * retained/clearable-timer shape `scheduleRevert` below already established for the refused-off
 * case, torn down by the same `stop()`. A confirmed prime (the ordinary case) is unaffected: by
 * the time this timer fires, `isPriming` is already `true`, so the corrective push is a no-op.
 */

import type { Service } from 'homebridge';

import type { TimerHandle } from '../pod/snapshot.ts';
import type { ServiceContext } from './types.ts';

export const PRIME_SUBTYPE = 'prime';
export const POD_PRIME_NAME = 'Pod Prime';

/** How long after a refused off-write to correct the tile HAP applied optimistically ahead of
 * the throw — matches `thermostat.ts`'s own `AWAY_MODE_BLOCKED_REVERT_DELAY_MS`. */
const PRIME_OFF_REVERT_DELAY_MS = 500;

/**
 * S3 fix: matches `platform.ts`'s own duplicated default (`poller.ts` doesn't export its
 * `fastPollIntervalMs` default) — the confirming fast-poll window a successful prime-on write
 * already triggers (design.md's Decision 2). `ctx.config.pollIntervals.fastPollIntervalMs`
 * overrides it when configured, exactly like every other fast-poll-window consumer.
 */
const DEFAULT_FAST_POLL_INTERVAL_MS = 5000;
/** Safety margin over one fast-poll interval — covers the request's own round trip and commit,
 * so the corrective check runs strictly after the confirming poll had a chance to land, not
 * exactly when it was merely scheduled. */
const PRIME_CONFIRM_CHECK_MARGIN_MS = 2000;

/** Raised from the `On` characteristic's `onSet` handler, before any call into `WriteQueue`, when
 * the written value is `false` (design.md's Decision 3) — the Pod has no PRIME-stop command. */
export class PrimeCannotBeStoppedError extends Error {
  constructor(
    message = 'the Pod has no way to stop a prime in progress; writing the prime switch off is refused',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PrimeService {
  private readonly ctx: ServiceContext;
  private readonly service: Service;
  /** The pending revert timer, if any — retained so `stop()` can clear it on shutdown, mirroring
   * `ThermostatService`'s own `awayModeRevertTimer`. */
  private revertTimer: TimerHandle | null = null;
  /** S3 fix: the pending post-write corrective-check timer, if any — same retained/clearable
   * shape as `revertTimer`, torn down by the same `stop()`. */
  private confirmCheckTimer: TimerHandle | null = null;
  /** `ctx.config.pollIntervals.fastPollIntervalMs` (default 5000) plus a fixed safety margin —
   * see `PRIME_CONFIRM_CHECK_MARGIN_MS`'s doc. */
  private readonly confirmCheckDelayMs: number;

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;
    this.confirmCheckDelayMs =
      (ctx.config.pollIntervals.fastPollIntervalMs ?? DEFAULT_FAST_POLL_INTERVAL_MS) + PRIME_CONFIRM_CHECK_MARGIN_MS;

    const existing = accessory.getServiceById(hap.Service.Switch, PRIME_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Switch(POD_PRIME_NAME, PRIME_SUBTYPE));

    this.wireReadsAndWrites();

    // B1 pattern (every other service in this plugin): publish whatever the bootstrap already
    // observed before this service is registered.
    this.refresh();
  }

  private isPriming(): boolean {
    return this.ctx.snapshot.get().isPriming ?? false;
  }

  private wireReadsAndWrites(): void {
    const hap = this.ctx.api.hap;
    const onChar = this.service.getCharacteristic(hap.Characteristic.On);

    onChar.onGet(() => this.isPriming());

    onChar.onSet(async (value) => {
      try {
        if (!value) {
          throw new PrimeCannotBeStoppedError();
        }
        await this.ctx.writeQueue.submitDeviceSettings({ isPriming: true });
        // S3 fix: the dispatch succeeding only means the Pod *accepted* the write — it never by
        // itself proves priming actually started (see this module's doc). Schedule one bounded
        // corrective push so an unconfirmed prime doesn't leave the tile latched `On` forever.
        this.scheduleConfirmCheck();
      } catch (error) {
        if (error instanceof PrimeCannotBeStoppedError) {
          this.ctx.log.debug(`FreeSleep: prime-off write refused: ${describeError(error)}`);
          this.scheduleRevert();
          throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        this.ctx.log.debug(`FreeSleep: prime write failed: ${describeError(error)}`);
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
  }

  /**
   * Corrects the tile HAP applied optimistically ahead of a refused off-write (mirrors
   * `ThermostatService.scheduleAwayModeRevert`'s doc exactly, same pattern, different trigger).
   * A second refused off-write before the first revert fires gets exactly one pending timer.
   */
  private scheduleRevert(): void {
    if (this.revertTimer !== null) {
      this.ctx.timers.clearTimeout(this.revertTimer);
    }
    this.revertTimer = this.ctx.timers.setTimeout(() => {
      this.revertTimer = null;
      this.refresh();
    }, PRIME_OFF_REVERT_DELAY_MS);
  }

  /**
   * S3 fix: schedules exactly one bounded `refresh()` after a successful prime-on write —
   * `confirmCheckDelayMs` after now, which is the confirming fast-poll window (design.md's
   * Decision 2) plus a safety margin. A repeat `On` write before this fires (e.g. a second tap)
   * gets exactly one pending timer, mirroring `scheduleRevert`'s own coalescing. If `isPriming`
   * is `true` by the time this fires (the ordinary, confirmed case), `refresh()` is a no-op — the
   * characteristic already agrees.
   */
  private scheduleConfirmCheck(): void {
    if (this.confirmCheckTimer !== null) {
      this.ctx.timers.clearTimeout(this.confirmCheckTimer);
    }
    this.confirmCheckTimer = this.ctx.timers.setTimeout(() => {
      this.confirmCheckTimer = null;
      this.refresh();
    }, this.confirmCheckDelayMs);
  }

  /** Clears any pending revert/confirm-check timer — wired into the platform's `shutdown`
   * teardown alongside `ThermostatService.stop()`. */
  stop(): void {
    if (this.revertTimer !== null) {
      this.ctx.timers.clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    if (this.confirmCheckTimer !== null) {
      this.ctx.timers.clearTimeout(this.confirmCheckTimer);
      this.confirmCheckTimer = null;
    }
  }

  /** Called by the platform whenever an `isPriming` change event fires. */
  refresh(): void {
    const hap = this.ctx.api.hap;
    const characteristic = this.service.getCharacteristic(hap.Characteristic.On);
    const next = this.isPriming();
    if (characteristic.value !== next) characteristic.updateValue(next);
  }
}
