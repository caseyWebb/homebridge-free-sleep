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
 * `writeMaxDebounceMs`, `alarmPollIntervalMs`) — every field there is an *override*: omitting
 * one means "use that change's own default", not a zod-supplied default, which is why the
 * object itself defaults to `{}` rather than each field defaulting individually.
 *
 * Note: `writeSettleMs` is a *top-level* key, not nested under `pollIntervals` — corrected at
 * reconcile of `thermostat-and-offline` (design.md's "Consumed vs. reserved config keys"
 * table): it is `poller-and-write-queue`'s write-queue optimistic-overlay window, unrelated to
 * `pollIntervals`'s poll-timing fields.
 */

import { z } from 'zod';

const PollIntervalsSchema = z
  .object({
    /** Base `deviceStatus`/`settings`/`schedules`/`services` poll interval. Default 30000. */
    pollIntervalMs: z.number().int().min(5000, { message: 'pollIntervalMs must be at least 5000ms' }).optional(),
    /** Interval used while a `requestMode` fast-poll window is active. Default 5000. */
    fastPollIntervalMs: z
      .number()
      .int()
      .min(1000, { message: 'fastPollIntervalMs must be at least 1000ms' })
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
    /** Write-queue per-lane debounce. Default 400. */
    writeDebounceMs: z.number().int().min(0, { message: 'writeDebounceMs must be non-negative' }).optional(),
    /** Write-queue debounce ceiling. Default 2000. */
    writeMaxDebounceMs: z
      .number()
      .int()
      .min(0, { message: 'writeMaxDebounceMs must be non-negative' })
      .optional(),
    /** Fast-poll interval around a predicted alarm window. Reserved for #16. Default 3000. */
    alarmPollIntervalMs: z
      .number()
      .int()
      .min(1000, { message: 'alarmPollIntervalMs must be at least 1000ms' })
      .optional(),
  })
  .default({});

export const FreeSleepConfigSchema = z.object({
  /**
   * The Pod's LAN hostname or IP address. Required, non-empty, un-defaulted (config spec,
   * "`host` is required and un-defaulted"). Trimmed of surrounding whitespace.
   */
  host: z.string().trim().min(1, { message: 'host is required' }),

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

  /** Reserved — see module doc. */
  keepAlive: z.boolean().default(true),

  /** Reserved — see module doc. */
  awayModeWritePolicy: z
    .enum(['mirror', 'block'], {
      message: "awayModeWritePolicy must be one of 'mirror' or 'block'",
    })
    .default('mirror'),
});

export type FreeSleepConfig = z.infer<typeof FreeSleepConfigSchema>;
export type PollIntervalsConfig = z.infer<typeof PollIntervalsSchema>;
