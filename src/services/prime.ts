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
 */

import type { Service } from 'homebridge';

import type { TimerHandle } from '../pod/snapshot.ts';
import type { ServiceContext } from './types.ts';

export const PRIME_SUBTYPE = 'prime';
export const POD_PRIME_NAME = 'Pod Prime';

/** How long after a refused off-write to correct the tile HAP applied optimistically ahead of
 * the throw — matches `thermostat.ts`'s own `AWAY_MODE_BLOCKED_REVERT_DELAY_MS`. */
const PRIME_OFF_REVERT_DELAY_MS = 500;

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

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

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

  /** Clears any pending revert timer — wired into the platform's `shutdown` teardown alongside
   * `ThermostatService.stop()`. */
  stop(): void {
    if (this.revertTimer !== null) {
      this.ctx.timers.clearTimeout(this.revertTimer);
      this.revertTimer = null;
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
