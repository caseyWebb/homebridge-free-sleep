/**
 * The platform's config block: a zod schema, `z.infer` types, defaults, and normalization.
 *
 * Every key the tech lead has fixed for the eventual feature set (design.md,
 * "Consumed vs. reserved config keys") is defined here now, so later changes add *behavior*
 * behind an already-stable key, never a new key. Only `host` and `sides` are consumed by
 * `platform-foundation` (`src/platform.ts`); the rest are validated and defaulted but
 * otherwise ignored until the change that owns them reads them:
 *
 *   | Key                  | Owner (reads it for behavior) |
 *   |----------------------|--------------------------------|
 *   | `pollIntervals`      | `poller-and-write-queue` (#8)  |
 *   | `writeSettleMs`      | `poller-and-write-queue` (#10) |
 *   | `noResponseAfterMs`  | `thermostat-and-offline` (#11) |
 *   | `occupancySource`    | #19                            |
 *   | `waterLowSensorType` | #20                            |
 *   | `keepAlive`          | #12                            |
 *   | `awayModeWritePolicy`| #13                            |
 *
 * Every reserved key is nonetheless genuinely validated — a `z.object`/`z.enum` per key, not
 * `z.unknown()` — so a typo'd future config value fails loudly today rather than silently
 * once one of the changes above starts reading it.
 *
 * `pollIntervals`'s per-field names and defaults mirror what `poller-and-write-queue`'s
 * proposal.md already names as the keys it will read (`pollIntervalMs`, `fastPollIntervalMs`,
 * `fastPollDurationMs`, `slowPollIntervalMs`, `maxBackoffMs`, `writeDebounceMs`,
 * `writeMaxDebounceMs`, `alarmPollIntervalMs`, `bootstrapTimeoutMs`) — every field there is an
 * *override*: omitting one means "use that change's own default", not a zod-supplied default,
 * which is why the object itself defaults to `{}` rather than each field defaulting
 * individually.
 *
 * Note: `writeSettleMs` is a *top-level* key, not nested under `pollIntervals` — corrected at
 * reconcile of `thermostat-and-offline` (design.md's "Consumed vs. reserved config keys"
 * table): it is `poller-and-write-queue`'s write-queue optimistic-overlay window, unrelated to
 * `pollIntervals`'s poll-timing fields.
 */

import { z } from 'zod';

/**
 * The un-defaulted object schema, exported separately from `PollIntervalsSchema` below so a
 * test can inspect its `.shape` directly (`ZodDefault` — what wrapping this in `.default({})`
 * produces — has no `.shape` of its own in zod v4).
 */
export const PollIntervalsFieldsSchema = z
  .object({
    /** Base `deviceStatus`/`settings`/`schedules`/`services` poll interval. Default 30000. */
    pollIntervalMs: z.number().int().min(5000, { message: 'pollIntervalMs must be at least 5000ms' }).optional(),
    /**
     * Interval used while a `requestMode` fast-poll window is active. Default 5000. Minimum
     * 3000 matches `poller.ts`'s `HARD_FLOOR_MS` — the module floor no configured interval can
     * go below.
     */
    fastPollIntervalMs: z
      .number()
      .int()
      .min(3000, { message: 'fastPollIntervalMs must be at least 3000ms' })
      .optional(),
    /** How long a fast-poll window stays active after being requested. Default 90000. */
    fastPollDurationMs: z
      .number()
      .int()
      .min(0, { message: 'fastPollDurationMs must be non-negative' })
      .optional(),
    /** Interval used once backed off to the slow tier. Default 300000. */
    slowPollIntervalMs: z
      .number()
      .int()
      .min(60000, { message: 'slowPollIntervalMs must be at least 60000ms' })
      .optional(),
    /** Exponential-backoff ceiling. Default 60000. */
    maxBackoffMs: z.number().int().min(1000, { message: 'maxBackoffMs must be at least 1000ms' }).optional(),
    /**
     * Write-queue per-lane debounce. Default 400. Minimum 100 matches `writeQueue.ts`'s own
     * `Math.max(100, …)` floor on this value.
     */
    writeDebounceMs: z
      .number()
      .int()
      .min(100, { message: 'writeDebounceMs must be at least 100ms' })
      .optional(),
    /** Write-queue debounce ceiling. Default 2000. */
    writeMaxDebounceMs: z
      .number()
      .int()
      .min(0, { message: 'writeMaxDebounceMs must be non-negative' })
      .optional(),
    /**
     * Fast-poll interval around a predicted alarm window. Reserved for #16. Default 3000.
     * Minimum 3000 matches `poller.ts`'s `HARD_FLOOR_MS`.
     */
    alarmPollIntervalMs: z
      .number()
      .int()
      .min(3000, { message: 'alarmPollIntervalMs must be at least 3000ms' })
      .optional(),
    /**
     * Deadline for `PodPoller.bootstrap()` to resolve, whichever classes have and have not
     * answered yet. Default 10000. Minimum 1000.
     */
    bootstrapTimeoutMs: z
      .number()
      .int()
      .min(1000, { message: 'bootstrapTimeoutMs must be at least 1000ms' })
      .optional(),
  });

export const PollIntervalsSchema = PollIntervalsFieldsSchema.default({});

export const FreeSleepConfigSchema = z.object({
  /**
   * The Pod's LAN hostname or IP address. Required, non-empty, un-defaulted (config spec,
   * "`host` is required and un-defaulted"). Trimmed of surrounding whitespace and lowercased —
   * DNS names are case-insensitive (a no-op for a literal IP address) — so that `'Pod.local'`
   * and `'pod.local'` are the same configured host: `uuidFor`/`serialNumberFor` derive HomeKit
   * identity directly from this string, and two spellings of the one Pod must never silently
   * produce two different accessories (config spec, "`host` is normalized to lowercase").
   */
  host: z.string().trim().min(1, { message: 'host is required' }).toLowerCase(),

  /**
   * Which side accessories to publish. Defaults to `'both'` (config spec, "`sides` defaults
   * to `'both'` and rejects any other value").
   */
  sides: z.enum(['both', 'left', 'right'], {
    message: "sides must be one of 'both', 'left', or 'right'",
  }).default('both'),

  /** Reserved — see module doc. Per-endpoint poll/write timing overrides. */
  pollIntervals: PollIntervalsSchema,

  /** Reserved — see module doc. The write queue's optimistic-overlay window. */
  writeSettleMs: z.number().int().min(0, { message: 'writeSettleMs must be non-negative' }).default(15000),

  /** Reserved — see module doc. docs/HOMEKIT.md's No-Response escalation delay; `0` disables. */
  noResponseAfterMs: z
    .number()
    .int()
    .min(0, { message: 'noResponseAfterMs must be non-negative' })
    .default(600000),

  /** Reserved — see module doc. */
  occupancySource: z
    .enum(['none', 'presence', 'vitals'], {
      message: "occupancySource must be one of 'none', 'presence', or 'vitals'",
    })
    .default('none'),

  /** Reserved — see module doc. */
  waterLowSensorType: z
    .enum(['contact', 'leak'], {
      message: "waterLowSensorType must be one of 'contact' or 'leak'",
    })
    .default('contact'),

  /**
   * Consumed starting with `keep-alive` (#12): `false` disables the whole component (no timer,
   * no writes); `true` (the default) runs it, re-posting `keepAliveMs` as a side's
   * `secondsRemaining` once its remaining time drops below `keepAliveThresholdMs`, but only
   * while that side is currently observed on (`src/pod/keepAlive.ts`).
   */
  keepAlive: z.boolean().default(true),

  /**
   * Consumed starting with `keep-alive` (#12). The duration (ms) re-posted as a side's
   * `secondsRemaining` when it is re-armed. Default 43_200_000 (12h), matching the Pod's own
   * `isOn: true` duration (`server/src/routes/deviceStatus/updateDeviceStatus.ts`). Minimum
   * 1000ms (design.md Open Question 3 / tech-lead resolution 3) — enough to reject nonsensical
   * configuration without a more specific bound.
   */
  keepAliveMs: z
    .number()
    .int()
    .min(1000, { message: 'keepAliveMs must be at least 1000ms' })
    .default(43_200_000),

  /**
   * Consumed starting with `keep-alive` (#12). A side is re-armed once its observed remaining
   * time drops below this. Default 1_800_000 (30 min). Minimum 1000ms, same rationale as
   * `keepAliveMs`. Must be strictly less than `keepAliveMs` — enforced by the object-level
   * `.superRefine` below, since a threshold at or above the duration would either never fire or
   * fire immediately on every re-arm.
   */
  keepAliveThresholdMs: z
    .number()
    .int()
    .min(1000, { message: 'keepAliveThresholdMs must be at least 1000ms' })
    .default(1_800_000),

  /** Reserved — see module doc. */
  awayModeWritePolicy: z
    .enum(['mirror', 'block'], {
      message: "awayModeWritePolicy must be one of 'mirror' or 'block'",
    })
    .default('mirror'),
}).superRefine((data, ctx) => {
  if (data.keepAliveThresholdMs >= data.keepAliveMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['keepAliveThresholdMs'],
      message:
        'keepAliveThresholdMs must be strictly less than keepAliveMs — a threshold at or above ' +
        'the duration would either never fire or fire immediately on every re-arm ' +
        `(got keepAliveThresholdMs=${data.keepAliveThresholdMs}, keepAliveMs=${data.keepAliveMs}).`,
    });
  }
});

export type FreeSleepConfig = z.infer<typeof FreeSleepConfigSchema>;
export type PollIntervalsConfig = z.infer<typeof PollIntervalsSchema>;

/**
 * Top-level keys Homebridge itself injects into every platform's config block — never
 * user-authored config for this plugin, so `unrecognizedConfigKeys` below always allowlists
 * them silently rather than warning about them.
 */
const HOMEBRIDGE_INJECTED_KEYS: ReadonlySet<string> = new Set(['platform', 'name', '_bridge']);

/**
 * Every top-level key in `rawConfig` that `FreeSleepConfigSchema` does not define and
 * Homebridge does not itself inject — almost always a typo (e.g. `hots` for `host`) that would
 * otherwise be silently ignored rather than validated (N10 in the platform-foundation code
 * review). Called independently of `safeParse` so a typo is surfaced even when the rest of the
 * config is otherwise valid.
 */
export function unrecognizedConfigKeys(rawConfig: Record<string, unknown>): string[] {
  const known = new Set(Object.keys(FreeSleepConfigSchema.shape));
  return Object.keys(rawConfig).filter((key) => !known.has(key) && !HOMEBRIDGE_INJECTED_KEYS.has(key));
}
