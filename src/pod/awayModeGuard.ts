/**
 * `AwayModeGuard` — the away-mode write policy decision (away-mode-guard proposal.md/design.md,
 * issue #13).
 *
 * **Adaptation note (tech-lead resolution 2, design.md's final "Resolutions" section):** the
 * original design had this module own both the *decision* and the *dispatch* — a front-door
 * wrapper (`guardSideWrite`) every write originator would call instead of
 * `WriteQueue.submitSide`. The tech lead overturned that: a wrapper callers must remember to use
 * is exactly the bypass risk the `keep-alive` change's own resolution 4 forbids. Enforcement now
 * lives *inside* `WriteQueue`'s own dispatch path (`writeQueue.ts`'s `dispatch()`), which
 * consults this module for every side-lane dispatch regardless of origin — thermostat,
 * keep-alive, or any future caller that just calls `submitSide` like it always did. This module
 * is left holding only the policy *decision*: a pure, synchronous read of the cached snapshot.
 *
 * Consequently this module imports only `snapshot.ts` — never `writeQueue.ts` — so that
 * `writeQueue.ts` can import *this* module without an import cycle. It has no dispatch
 * capability of its own and cannot call `submitSide`; `WriteQueue` is the only thing that acts
 * on the decision this returns.
 */

import type { Logger, SnapshotStore } from './snapshot.ts';

/** The two configured policies (`src/config.ts`'s `awayModeWritePolicy`, already shipped). */
export type AwayModeWritePolicy = 'mirror' | 'block';

/** `'plain'` when neither side is in away mode; otherwise the configured policy. */
export type AwayModeDecision = 'plain' | AwayModeWritePolicy;

/**
 * Raised when a side write is refused by the `'block'` policy, before it ever reaches the Pod.
 * `WriteQueue` rejects the submitter's promise with this; `ThermostatService` maps it to
 * `HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)` (design.md, "What `'block'` throws").
 */
export class AwayModeBlockedError extends Error {
  constructor(
    message = 'write refused: the away-mode write policy is "block" and either side is currently in away mode',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface AwayModeGuardOptions {
  snapshot: SnapshotStore;
  policy: AwayModeWritePolicy;
  logger?: Logger;
}

export class AwayModeGuard {
  private readonly snapshot: SnapshotStore;
  private readonly policy: AwayModeWritePolicy;
  private readonly logger: Logger | undefined;

  constructor(options: AwayModeGuardOptions) {
    this.snapshot = options.snapshot;
    this.policy = options.policy;
    this.logger = options.logger;
  }

  /**
   * A synchronous read of the cached snapshot — no request of any kind, no `await` (away-mode-
   * guard spec, "the freshest away-mode knowledge available without issuing a request dedicated
   * solely to that check"). `WriteQueue` calls this once per side-lane dispatch, from inside the
   * dispatch step it already runs every write through under its own mutex — so the decision
   * cannot be interleaved with another in-flight dispatch this plugin issues (away-mode-guard
   * spec, "The away-mode check and the resulting dispatch cannot be reordered against another
   * in-flight write").
   *
   * Symmetric in the addressed side by design: either side being away is sufficient to trigger
   * the policy (away-mode-guard spec, "Either side being away is sufficient to trigger the
   * policy"), so this takes no `side` parameter at all — there is nothing for it to depend on.
   */
  decide(): AwayModeDecision {
    const { left, right } = this.snapshot.get();
    const eitherAway = left.awayMode === true || right.awayMode === true;
    if (!eitherAway) return 'plain';
    if (this.policy === 'block') {
      this.logger?.debug(
        'awayModeGuard: refusing a side write — either side is in away mode and the policy is "block"',
      );
    }
    return this.policy;
  }
}
