/**
 * The per-side `Thermostat` — the plugin's reason to exist (specs/thermostat-service/spec.md,
 * design.md's "Characteristic table" and "The sticky deadband, and where its state lives").
 *
 * Exactly five characteristics, `setProps` applied at construction before any value is
 * reported and before the accessory is registered (design.md, "Characteristic table"):
 * `CurrentHeatingCoolingState` (no `setProps` — its default valid values are already right),
 * `TargetHeatingCoolingState` (`validValues: [OFF, AUTO]`, OFF first), `CurrentTemperature`
 * (`{ minValue: -270, maxValue: 100 }`), `TargetTemperature` (`TARGET_TEMP_PROPS`), and
 * `TemperatureDisplayUnits` (no `setProps`, served from `accessory.context`).
 *
 * All five `onGet` handlers are synchronous and read only `ctx.snapshot.get()` — no `onGet` is
 * `async`, awaits, or touches the network (spec, "Every read is served synchronously from the
 * cached observation"). `onSet` routes through `ctx.writeQueue`.
 */

import type { Characteristic, Service } from 'homebridge';

import { AwayModeBlockedError } from '../pod/awayModeGuard.ts';
import { clampTargetF, cToF, fToC, TARGET_TEMP_PROPS } from '../pod/temperature.ts';
import type { Change, EffectiveSideStatus, TimerHandle } from '../pod/snapshot.ts';
import type { Side } from '../pod/types.ts';
import { CONFIGURED_NAME, seedConfiguredName } from './serviceName.ts';
import type { ServiceContext } from './types.ts';

/** How long after a `block`-refused write to correct any characteristic value HAP applied
 * optimistically ahead of the throw (design.md, "The tile-revert mechanism" — the same pattern
 * the alarm-dismiss `Switch`'s "accept then quietly revert" already uses). */
const AWAY_MODE_BLOCKED_REVERT_DELAY_MS = 500;

export const THERMOSTAT_SUBTYPE = 'thermostat';

/** `accessory.context.publishedF` — JSON-persisted by `PlatformAccessory` across restarts
 * (design.md, "The °F shadow"). */
interface PublishedF {
  targetF?: number;
  currentF?: number;
}

interface ThermostatContext {
  publishedF?: PublishedF;
  /** HAP `TemperatureDisplayUnits` value (0 = CELSIUS, 1 = FAHRENHEIT), seeded once. */
  displayUnits?: number;
  /**
   * The mode shadow (S2 fix) — mirrors `publishedF`'s "claim on write" pattern for
   * `TargetHeatingCoolingState`, which otherwise has none. Without it, `submitSide`'s
   * synchronous overlay install (which lands before HAP has even assigned the characteristic's
   * new `.value`) round-trips through `refresh()` as an echo push back at the writer.
   */
  publishedIsOn?: boolean;
}

function contextOf(ctx: ServiceContext): ThermostatContext {
  return ctx.accessory.context as ThermostatContext;
}

/**
 * The three fields that, together, feed both the temperature-shadow push and the sticky
 * deadband recompute (design.md's routing table: `currentTemperatureF`, `targetTemperatureF`,
 * `isOn` for a side all route to that side's thermostat, which recomputes the whole pair on
 * any one of them).
 */
export type ThermostatWatchedField = 'currentTemperatureF' | 'targetTemperatureF' | 'isOn';

export const THERMOSTAT_WATCHED_FIELDS: ReadonlySet<ThermostatWatchedField> = new Set([
  'currentTemperatureF',
  'targetTemperatureF',
  'isOn',
]);

export class ThermostatService {
  private readonly ctx: ServiceContext;
  private readonly side: Side;
  private readonly service: Service;
  /** The moment this launch started — the escalation predicate's fallback `since` when the
   * Pod has never been observed reachable this launch (design.md, "No Response"). */
  private readonly platformStartedAt: number;
  /** The pending `scheduleAwayModeRevert` timer, if any — retained (F2 fix) so `stop()` can
   * clear it on platform shutdown instead of leaving it to fire (or sit pending forever) after
   * teardown. `null` whenever no revert is currently scheduled. */
  private awayModeRevertTimer: TimerHandle | null = null;

  constructor(ctx: ServiceContext, side: Side, platformStartedAt: number) {
    this.ctx = ctx;
    this.side = side;
    this.platformStartedAt = platformStartedAt;

    const hap = ctx.api.hap;
    const accessory = ctx.accessory;

    const existing = accessory.getServiceById(hap.Service.Thermostat, THERMOSTAT_SUBTYPE);
    this.service = existing ?? accessory.addService(new hap.Service.Thermostat(accessory.displayName, THERMOSTAT_SUBTYPE));
    seedConfiguredName(this.service, hap, CONFIGURED_NAME.thermostat);

    // Every setProps call happens before any value is set and before the accessory is
    // registered (specs/thermostat-service/spec.md, tasks.md 2.3) — `setProps` after publish
    // does not bump the HAP configuration number, and re-validates (and can silently rewrite)
    // the current value if called late (docs/HOMEKIT.md).
    this.service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).setProps({
      validValues: [hap.Characteristic.TargetHeatingCoolingState.OFF, hap.Characteristic.TargetHeatingCoolingState.AUTO],
    });
    this.service.getCharacteristic(hap.Characteristic.TargetTemperature).setProps(TARGET_TEMP_PROPS);
    this.service.getCharacteristic(hap.Characteristic.CurrentTemperature).setProps({ minValue: -270, maxValue: 100 });
    // No setProps on CurrentHeatingCoolingState (its default valid values are already exactly
    // [OFF, HEAT, COOL]) and none on TemperatureDisplayUnits.

    this.service.setPrimaryService(true);

    this.wireReads();
    this.wireWrites();

    // B1: publish whatever the bootstrap already observed before this service is registered —
    // without this, every characteristic keeps HAP's own default (target 12.78°C, current 0°C)
    // until the next change event, which a Pod that stays reachable all launch may never send.
    // `refresh()` is idempotent and reads only `ctx.snapshot.get()`, so calling it here is safe
    // regardless of whether the bootstrap actually reached the Pod.
    this.refresh();
  }

  // ---------------------------------------------------------------------------------------
  // No-Response escalation (design.md, "No Response: what actually works")
  // ---------------------------------------------------------------------------------------

  private assertNotEscalated(): void {
    const hap = this.ctx.api.hap;
    const { connection } = this.ctx.snapshot.get();
    const noResponseAfterMs = this.ctx.config.noResponseAfterMs;
    const since = connection.lastSuccessAt ?? this.platformStartedAt;
    const escalated =
      noResponseAfterMs > 0 && !connection.online && this.ctx.timers.now() - since > noResponseAfterMs;
    if (escalated) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private currentSide(): EffectiveSideStatus {
    return this.ctx.snapshot.get()[this.side];
  }

  // ---------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------

  private wireReads(): void {
    const hap = this.ctx.api.hap;
    const targetStateChar = this.service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState);
    const currentStateChar = this.service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState);
    const targetTempChar = this.service.getCharacteristic(hap.Characteristic.TargetTemperature);
    const currentTempChar = this.service.getCharacteristic(hap.Characteristic.CurrentTemperature);
    const displayUnitsChar = this.service.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits);

    targetStateChar.onGet(() => {
      this.assertNotEscalated();
      const side = this.currentSide();
      if (side.isOn === undefined) return targetStateChar.value as number;
      return side.isOn ? hap.Characteristic.TargetHeatingCoolingState.AUTO : hap.Characteristic.TargetHeatingCoolingState.OFF;
    });

    currentStateChar.onGet(() => {
      this.assertNotEscalated();
      return this.computeCurrentState(currentStateChar, this.currentSide());
    });

    targetTempChar.onGet(() => {
      this.assertNotEscalated();
      const side = this.currentSide();
      if (side.targetTemperatureF === undefined) return targetTempChar.value as number;
      // #33: clamp before converting — HAP's TargetTemperature can never report a degree outside
      // the settable range, and the read schema is deliberately lenient about what the Pod can
      // report (src/pod/temperature.ts's `clampTargetF` doc).
      return fToC(clampTargetF(side.targetTemperatureF));
    });

    currentTempChar.onGet(() => {
      this.assertNotEscalated();
      const side = this.currentSide();
      if (side.currentTemperatureF === undefined) return currentTempChar.value as number;
      return fToC(side.currentTemperatureF);
    });

    displayUnitsChar.onGet(() => {
      this.assertNotEscalated();
      const context = contextOf(this.ctx);
      if (context.displayUnits !== undefined) return context.displayUnits;
      const format = this.ctx.snapshot.get().documents.settings?.temperatureFormat;
      if (format === 'celsius' || format === 'fahrenheit') {
        const seeded =
          format === 'celsius'
            ? hap.Characteristic.TemperatureDisplayUnits.CELSIUS
            : hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
        context.displayUnits = seeded;
        return seeded;
      }
      return displayUnitsChar.value as number;
    });
  }

  /**
   * The sticky ±1 °F deadband (design.md, "The sticky deadband, and where its state lives"):
   * off when not running; heat/cool when the delta reaches a whole degree either way; otherwise
   * `characteristic.value` itself — the "sticky" state, since HAP already persists it. The
   * unknown-snapshot fallback (tasks.md 3.3) and this deadband's own "no previous state" seed
   * clause both resolve to the same read of `characteristic.value`, so one function does both.
   */
  private computeCurrentState(currentStateChar: Characteristic, side: EffectiveSideStatus): number {
    const hap = this.ctx.api.hap;
    const CurrentState = hap.Characteristic.CurrentHeatingCoolingState;

    if (side.isOn === undefined || side.targetTemperatureF === undefined || side.currentTemperatureF === undefined) {
      return currentStateChar.value as number;
    }
    if (!side.isOn) return CurrentState.OFF;

    // Deliberately the raw, unclamped `targetTemperatureF` (design.md's "#33: clamp at three
    // read sites," row 3 — not one of the two clamped call sites, `onGet` above and `refresh`'s
    // `pushTemperature` call below). This decides heat-vs-cool direction, not what HomeKit
    // displays: a target genuinely outside the settable range still means something real about
    // which way the Pod is driving, and clamping it here could flip the computed sign.
    const delta = side.targetTemperatureF - side.currentTemperatureF;
    if (delta >= 1) return CurrentState.HEAT;
    if (delta <= -1) return CurrentState.COOL;

    const previous = currentStateChar.value as number;
    if (previous !== CurrentState.OFF) return previous;
    // First-ever launch inside the deadband: characteristic.value is HAP's default (OFF), which
    // this rule may never produce for a running side. The sign of the delta decides; a
    // non-negative difference reports heat (design.md; specs/thermostat-service/spec.md).
    return delta >= 0 ? CurrentState.HEAT : CurrentState.COOL;
  }

  // ---------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------

  private wireWrites(): void {
    const hap = this.ctx.api.hap;
    const targetStateChar = this.service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState);
    const targetTempChar = this.service.getCharacteristic(hap.Characteristic.TargetTemperature);
    const displayUnitsChar = this.service.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits);

    targetStateChar.onSet(async (value) => {
      const isOn = value === hap.Characteristic.TargetHeatingCoolingState.AUTO;
      // Claim the mode into the shadow before submitting — mirrors the temperature path (design.md,
      // "The °F shadow") so `submitSide`'s synchronous overlay-install echo, which fires before
      // HAP has assigned `.value`, is suppressed rather than pushed back at the writer (S2).
      const context = contextOf(this.ctx);
      context.publishedIsOn = isOn;
      try {
        await this.ctx.writeQueue.submitSide(this.side, { isOn });
      } catch (error) {
        if (error instanceof AwayModeBlockedError) {
          this.ctx.log.debug(`FreeSleep: ${this.side} power write refused by the away-mode guard: ${describeError(error)}`);
          this.scheduleAwayModeRevert();
          throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        this.ctx.log.debug(`FreeSleep: ${this.side} power write failed: ${describeError(error)}`);
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });

    targetTempChar.onSet(async (value) => {
      const targetF = Math.round(cToF(value as number));
      // Claim the degree into the shadow without calling updateCharacteristic — HAP already
      // holds the client's value and the client already believes it (design.md, "The °F
      // shadow").
      const context = contextOf(this.ctx);
      context.publishedF = { ...context.publishedF, targetF };
      try {
        await this.ctx.writeQueue.submitSide(this.side, { targetTemperatureF: targetF });
      } catch (error) {
        if (error instanceof AwayModeBlockedError) {
          this.ctx.log.debug(`FreeSleep: ${this.side} setpoint write refused by the away-mode guard: ${describeError(error)}`);
          this.scheduleAwayModeRevert();
          throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        this.ctx.log.debug(`FreeSleep: ${this.side} setpoint write failed: ${describeError(error)}`);
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });

    // Never reaches the Pod — accessory.context only (specs/thermostat-service/spec.md,
    // "Display units are served and stored locally, and never written to the Pod"). N9:
    // persisted via `updatePlatformAccessories` (mirroring `platform.ts`'s F4 prune-persistence
    // pattern) only on an actual change, so the unit survives an unclean shutdown without a
    // gratuitous disk write on every repeat write of the same unit.
    displayUnitsChar.onSet((value) => {
      const context = contextOf(this.ctx);
      if (context.displayUnits === value) return;
      context.displayUnits = value as number;
      this.ctx.api.updatePlatformAccessories([this.ctx.accessory]);
    });
  }

  /**
   * Corrects a characteristic value HAP applied optimistically ahead of a `block`-refused write
   * (design.md, "The tile-revert mechanism"). The mode/temperature shadow (`context.publishedIsOn`
   * / `context.publishedF`) was already claimed to the *rejected* value before the write was
   * submitted (`wireWrites`'s "claim into the shadow" comments), so by the time this fires the
   * shadow disagrees with the cached snapshot (which a `block` refusal never touches) — `refresh`
   * ordinarily suppresses a push when the shadow already agrees with what it's about to push, but
   * here it doesn't, so it pushes the reversion exactly like any other genuinely divergent
   * observation. Scheduled via the shared injected `TimerApi`, not a bare `setTimeout` (design.md;
   * `src/services/types.ts`'s module doc) — deterministic under a test's fake/manual timers.
   *
   * F2 fix: the handle is retained in `awayModeRevertTimer` rather than fired-and-forgotten, and
   * any previously-scheduled revert is cleared first — a second blocked write before the first
   * revert fires gets exactly one pending timer, not two independent `refresh()` calls racing
   * each other. `stop()` clears this same handle on platform shutdown.
   */
  private scheduleAwayModeRevert(): void {
    if (this.awayModeRevertTimer !== null) {
      this.ctx.timers.clearTimeout(this.awayModeRevertTimer);
    }
    this.awayModeRevertTimer = this.ctx.timers.setTimeout(() => {
      this.awayModeRevertTimer = null;
      this.refresh();
    }, AWAY_MODE_BLOCKED_REVERT_DELAY_MS);
  }

  /**
   * Clears any pending away-mode-revert timer (F2 fix) — wired into the platform's `shutdown`
   * teardown (`src/platform.ts`) alongside `poller.stop()`/`writeQueue.stop()`, so a blocked
   * write's ~500ms corrective `refresh()` never fires (and never shows up as a leaked pending
   * timer) after the platform has already torn down.
   */
  stop(): void {
    if (this.awayModeRevertTimer !== null) {
      this.ctx.timers.clearTimeout(this.awayModeRevertTimer);
      this.awayModeRevertTimer = null;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Push (platform routes snapshot change events here — design.md's routing table)
  // ---------------------------------------------------------------------------------------

  /**
   * Recomputes and pushes everything this side's thermostat can change, in response to any of
   * `currentTemperatureF`/`targetTemperatureF`/`isOn` changing for this side. Idempotent and
   * side-effect-free when nothing has actually changed — the shadow/`characteristic.value`
   * comparisons below are what make every "no push for an unchanged value" scenario hold
   * regardless of how often this is called.
   */
  refresh(): void {
    const hap = this.ctx.api.hap;
    const side = this.currentSide();
    const context = contextOf(this.ctx);

    this.pushTemperature(
      this.service.getCharacteristic(hap.Characteristic.CurrentTemperature),
      side.currentTemperatureF,
      context,
      'currentF',
    );
    // #33: clamp before the shadow comparison and the pushed value both use it — the read schema
    // itself stays lenient (src/pod/temperature.ts's `clampTargetF` doc).
    const targetF = side.targetTemperatureF === undefined ? undefined : clampTargetF(side.targetTemperatureF);
    this.pushTemperature(
      this.service.getCharacteristic(hap.Characteristic.TargetTemperature),
      targetF,
      context,
      'targetF',
    );

    this.pushMode(this.service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState), side.isOn, context);

    const currentStateChar = this.service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState);
    const nextCurrentState = this.computeCurrentState(currentStateChar, side);
    if (currentStateChar.value !== nextCurrentState) currentStateChar.updateValue(nextCurrentState);
  }

  /**
   * The mode analogue of `pushTemperature` (S2 fix): claims into `context.publishedIsOn` rather
   * than comparing against `characteristic.value` directly, so a write's synchronous
   * overlay-install echo — which reaches `refresh()` before HAP has assigned the characteristic's
   * new `.value` — is suppressed exactly like a temperature write's overlay echo already is. A
   * genuinely divergent later observation (the shadow disagrees with the newly observed `isOn`)
   * still pushes.
   */
  private pushMode(characteristic: Characteristic, isOn: boolean | undefined, context: ThermostatContext): void {
    if (isOn === undefined) return;
    if (context.publishedIsOn === isOn) return;
    context.publishedIsOn = isOn;
    const hap = this.ctx.api.hap;
    const next = isOn ? hap.Characteristic.TargetHeatingCoolingState.AUTO : hap.Characteristic.TargetHeatingCoolingState.OFF;
    characteristic.updateValue(next);
  }

  private pushTemperature(
    characteristic: Characteristic,
    observedF: number | undefined,
    context: ThermostatContext,
    shadowKey: keyof PublishedF,
  ): void {
    if (observedF === undefined) return;
    const shadow = context.publishedF ?? {};
    if (shadow[shadowKey] === observedF) return;
    context.publishedF = { ...shadow, [shadowKey]: observedF };
    characteristic.updateValue(fToC(observedF));
  }
}

/** Whether a snapshot `Change` is one of the three fields that should trigger the affected
 * side's `ThermostatService.refresh()` (design.md's routing table). */
export function isThermostatChange(change: Change): change is Change & { scope: 'side'; side: Side } {
  return change.scope === 'side' && THERMOSTAT_WATCHED_FIELDS.has(change.field as ThermostatWatchedField);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
