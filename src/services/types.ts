/**
 * `ServiceContext` — the one shared constructor argument every service in `src/services/`
 * takes (design.md, "File layout: `src/services/`, not flat `src/`").
 *
 * Threading the *same* `TimerApi` the poller and write queue got matters: the No-Response
 * escalation predicate (`src/services/thermostat.ts`) compares `timers.now()` against a
 * timestamp `SnapshotStore` recorded using that same clock, and if the two clocks differ the
 * escalation cannot be tested deterministically (design.md).
 *
 * HAP types only from `homebridge` here — never `@homebridge/hap-nodejs` — so this module (and
 * everything importing it) stays free of a runtime dependency on the HAP implementation
 * package, which stays devDependency-only for tests (docs/HOMEKIT.md, "Homebridge 2.x API
 * notes").
 */

import type { API, Logging, PlatformAccessory } from 'homebridge';

import type { FreeSleepConfig } from '../config.ts';
import type { MinimalPodClient } from '../platform.ts';
import type { AwayModeGuard } from '../pod/awayModeGuard.ts';
import type { SnapshotStore, TimerApi } from '../pod/snapshot.ts';
import type { WriteQueue } from '../pod/writeQueue.ts';

export interface ServiceContext {
  readonly api: API;
  readonly log: Logging;
  readonly accessory: PlatformAccessory;
  readonly snapshot: SnapshotStore;
  readonly writeQueue: WriteQueue;
  /**
   * The platform's own injected/real Pod client — needed by any service that calls the client
   * directly rather than solely through `writeQueue`/`snapshot` (`hub-accessory`'s
   * `TestAlarmService` is the first: `postAlarm` is a one-off fire-and-forget write, not a
   * debounced/merged field this queue's lane model fits).
   */
  readonly podClient: MinimalPodClient;
  /**
   * The same instance `writeQueue` itself consults on every side-lane dispatch (away-mode-guard
   * change, tech-lead resolution 2) — services never need to call this directly to be protected
   * (`writeQueue.submitSide` already routes every side write through it), but it is threaded
   * through here for parity with `snapshot`/`writeQueue` and for anything that wants to inspect
   * or test the configured policy directly.
   */
  readonly awayModeGuard: AwayModeGuard;
  /** The same `TimerApi` instance shared with the poller and the write queue. */
  readonly timers: TimerApi;
  readonly config: FreeSleepConfig;
}
