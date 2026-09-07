/**
 * Vendored wire contract for free-sleep's LAN HTTP API.
 *
 * Copied — not depended upon — from https://github.com/throwaway31265/free-sleep at
 * **v2.1.5, commit `dc0c710`**. See `openspec/changes/pod-client/design.md` ("Decisions" ->
 * "`types.ts` vendors runtime zod schemas, not bare TypeScript types") for why this is
 * runtime zod rather than hand-written `interface`s, and for the read-vs-request leniency
 * rule applied throughout this file.
 *
 * Five blocks, one per upstream source file:
 *
 *   | Block           | Upstream source                                                |
 *   |-----------------|-----------------------------------------------------------------|
 *   | device status   | server/src/routes/deviceStatus/deviceStatusSchema.ts             |
 *   | settings        | server/src/db/settingsSchema.ts                                  |
 *   | schedules       | server/src/db/schedulesSchema.ts                                 |
 *   | services        | server/src/db/servicesSchema.ts                                  |
 *   | subsystem health| server/src/routes/serverStatus/serverStatusSchema.ts             |
 *
 * `services` also transitively needs the per-job status shape from
 * server/src/routes/serverStatus/serverStatusSchema.ts (`StatusInfoSchema`); that shape is
 * reproduced locally in the services block below rather than reused from the subsystem-health
 * block, since `services` predates the subsystem-health block and the two are structurally
 * identical but deliberately not merged (`hub-accessory`'s design.md, Decision 8: each block
 * should stay independently diffable against its own cited upstream file, not implicitly
 * coupled to another block that happens to look alike today). The alarm-trigger request shape
 * (`POST /api/alarm`) is likewise vendored, request-only, near the subsystem-health block below —
 * see `AlarmRequestSchema`.
 *
 * Read schemas (`DeviceStatusSchema`, `SettingsSchema`, `SchedulesSchema`, `ServicesSchema`)
 * are **lenient** throughout — not just for device status. Every unknown-key surface uses
 * plain `z.object()` (strip mode: unrecognized keys are dropped, not rejected — see the note
 * on `.passthrough()` below), and every value-level constraint that upstream's *request*
 * schemas enforce (`targetTemperatureF` 55-110, a tap's `type` discriminant, a tap's
 * `amount`/`snoozeDuration` bounds, the `temperatureFormat` enum, `TimeSchema`'s `HH:mm`
 * regex) is dropped from the read side: novel or out-of-range *values* must still parse, not
 * throw. The Pod never validates its own responses — `GET /api/settings` is literally
 * `res.json(settingsDB.data)` (`server/src/routes/settings/settings.ts`), with no `safeParse`
 * anywhere in the read path — so a strict read schema would fail an otherwise-usable snapshot
 * over a new field, an out-of-range hardware reading, or a hand-edited `settingsDB.json` with
 * a value a future free-sleep version introduced.
 *
 * Request schemas (`DeviceStatusPatchSchema`, `SettingsPatchSchema`) are **strict** deep
 * partials — a local mirror of what the Pod actually enforces on `POST`. Note: this project's
 * pinned zod (v4) has no `.deepPartial()` (that was a zod v3 API upstream relies on), so each
 * nesting level below is partialled explicitly.
 *
 * Read objects use plain `z.object()` rather than `.passthrough()`: zod v4's default "strip"
 * mode already tolerates unknown keys (parse succeeds; the keys are just dropped instead of
 * retained), which is all the leniency rationale above needs, and it keeps the inferred
 * TypeScript type free of the `[k: string]: unknown` index signature `.passthrough()` adds —
 * so a typo'd field name in code that *constructs* one of these shapes (e.g. the mock) is a
 * compile error instead of silently typing as `unknown`.
 *
 * `timeZone` is typed as a bare string rather than upstream's `z.enum(TIME_ZONES)` — the
 * ~600-entry IANA list lives in `server/src/db/timeZones.ts`, which is not one of the four
 * files this change vendors, and nothing here branches on a specific zone.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------------------
// device status — server/src/routes/deviceStatus/deviceStatusSchema.ts
// ---------------------------------------------------------------------------------------

/** Read shape: lenient. Unknown properties strip silently; no temperature range bound. */
export const SideStatusSchema = z.object({
  currentTemperatureLevel: z.number(),
  currentTemperatureF: z.number(),
  targetTemperatureF: z.number(),
  secondsRemaining: z.number(),
  isOn: z.boolean(),
  isAlarmVibrating: z.boolean(),
  // Never populated over HTTP (Franken.getDeviceStatus(getGestures = false) defaults
  // gestures off, and the route calls it with no argument) — see
  // test/fixtures.test.ts's taps-absence assertion, the tripwire for #21.
  taps: z
    .object({
      doubleTap: z.number(),
      tripleTap: z.number(),
      quadTap: z.number(),
    })
    .optional(),
});

export const DeviceStatusSchema = z.object({
  left: SideStatusSchema,
  right: SideStatusSchema,
  // Raw string, not a coerced boolean — see interpretWaterLevel below.
  waterLevel: z.string(),
  isPriming: z.boolean(),
  settings: z.object({
    v: z.number(),
    gainLeft: z.number(),
    gainRight: z.number(),
    ledBrightness: z.number(),
  }),
  coverVersion: z.string(),
  hubVersion: z.string(),
  freeSleep: z.object({
    version: z.string(),
    branch: z.string(),
  }),
  wifiStrength: z.number(),
});

export type SideStatus = z.infer<typeof SideStatusSchema>;
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/**
 * Request shape: strict. Mirrors what `updateDeviceStatus.ts`'s
 * `DeviceStatusSchema.deepPartial().safeParse(body)` actually enforces on us, field by field,
 * with `.int()` added to `targetTemperatureF` per docs/POD-API.md ("Integer °F is lossless" —
 * every integer 55-110°F round-trips exactly through the ±100 level scale; a fractional degree
 * is not a value the Pod's hardware level can represent faithfully).
 */
const SideStatusPatchSchema = z
  .object({
    targetTemperatureF: z
      .number()
      .int({ message: 'targetTemperatureF must be an integer' })
      .min(55, { message: 'Temperature must be at least 55°F' })
      .max(110, { message: 'Temperature cannot exceed 110°F' }),
    secondsRemaining: z.number(),
    isOn: z.boolean(),
    isAlarmVibrating: z.boolean(),
  })
  .strict()
  .partial();

export const DeviceStatusPatchSchema = z
  .object({
    left: SideStatusPatchSchema,
    right: SideStatusPatchSchema,
    isPriming: z.boolean(),
    settings: z
      .object({
        v: z.number(),
        gainLeft: z.number(),
        gainRight: z.number(),
        ledBrightness: z.number(),
      })
      .strict()
      .partial(),
  })
  .strict()
  .partial();

export type DeviceStatusPatch = z.infer<typeof DeviceStatusPatchSchema>;

/**
 * Upstream's actual request-validation contract for `POST /api/deviceStatus`:
 * `DeviceStatusSchema.deepPartial().safeParse(body)`
 * (`server/src/routes/deviceStatus/deviceStatus.ts`) — every field of the full device-status
 * shape (`SideStatusSchema`'s `currentTemperatureLevel`, `currentTemperatureF`, `taps`, plus
 * `DeviceStatusSchema`'s `waterLevel`, `coverVersion`, `hubVersion`, `freeSleep`,
 * `wifiStrength`), optional, strict, `targetTemperatureF` bounded 55-110 (that bound is
 * upstream's own schema, unlike `.int()` in `SideStatusPatchSchema` above, which is an extra
 * restriction this client imposes on what it will ever *send*).
 *
 * This is deliberately broader than `DeviceStatusPatchSchema` above, which is `PodClient`'s
 * own outgoing contract: the client only ever constructs a patch from the handful of fields
 * it has a defined write policy for. But a body the mock's `POST /api/deviceStatus` handler
 * receives did not necessarily come through `PodClient` — `test/mockPod.test.ts` posts raw
 * bodies directly — and the real Pod structurally accepts every field of `DeviceStatusSchema`
 * in a request body (only `updateDeviceStatus.ts`'s destructuring picks which of them do
 * anything). The mock must validate against *this* schema, not the narrower client one, or it
 * would 400 a body the real Pod accepts (S3 in the pod-client code review).
 */
const UpstreamSideStatusPatchSchema = z
  .object({
    currentTemperatureLevel: z.number(),
    currentTemperatureF: z.number(),
    targetTemperatureF: z
      .number()
      .min(55, { message: 'Temperature must be at least 55°F' })
      .max(110, { message: 'Temperature cannot exceed 110°F' }),
    secondsRemaining: z.number(),
    isOn: z.boolean(),
    isAlarmVibrating: z.boolean(),
    taps: z
      .object({
        doubleTap: z.number(),
        tripleTap: z.number(),
        quadTap: z.number(),
      })
      .strict()
      .partial(),
  })
  .strict()
  .partial();

export const UpstreamDeviceStatusPatchSchema = z
  .object({
    left: UpstreamSideStatusPatchSchema,
    right: UpstreamSideStatusPatchSchema,
    waterLevel: z.string(),
    isPriming: z.boolean(),
    settings: z
      .object({
        v: z.number(),
        gainLeft: z.number(),
        gainRight: z.number(),
        ledBrightness: z.number(),
      })
      .strict()
      .partial(),
    coverVersion: z.string(),
    hubVersion: z.string(),
    freeSleep: z
      .object({
        version: z.string(),
        branch: z.string(),
      })
      .strict()
      .partial(),
    wifiStrength: z.number(),
  })
  .strict()
  .partial();

export type UpstreamDeviceStatusPatch = z.infer<typeof UpstreamDeviceStatusPatchSchema>;

// ---------------------------------------------------------------------------------------
// settings — server/src/db/settingsSchema.ts
// ---------------------------------------------------------------------------------------

const TemperatureTapConfigSchema = z.object({
  type: z.literal('temperature'),
  change: z.enum(['increment', 'decrement']),
  amount: z.number().min(0).max(10),
});

const AlarmTapConfigSchema = z.object({
  type: z.literal('alarm'),
  behavior: z.enum(['snooze', 'dismiss']),
  snoozeDuration: z.number().min(60).max(600),
  inactiveAlarmBehavior: z.enum(['power', 'none']),
});

export const TapConfigSchema = z.discriminatedUnion('type', [
  TemperatureTapConfigSchema,
  AlarmTapConfigSchema,
]);

export const GestureSchema = z.enum(['doubleTap', 'tripleTap', 'quadTap']);
export type Gesture = z.infer<typeof GestureSchema>;
export type TapConfig = z.infer<typeof TapConfigSchema>;

/**
 * Read shape: lenient. `TapConfigSchema` above is a `discriminatedUnion` keyed on `type` with
 * `.min`/`.max` amounts — exactly what `settings.ts`'s *request* validation enforces, and
 * useless as a read schema: a `type` this client has never heard of (`settingsDB.json` is
 * never re-validated once written, so an older client's "future" tap type persists fine) or
 * an `amount`/`snoozeDuration` outside the request-side bounds (same reason) would fail the
 * whole settings read. Each read variant below drops the constraint the write side enforces
 * for the corresponding value, one branch per known `type`, with a final catch-all branch for
 * any other `type` string — this is not a bare "widen to string", because most of a
 * recognizable tap's shape is still worth keeping typed.
 */
const TemperatureTapConfigReadSchema = z.object({
  type: z.literal('temperature'),
  change: z.string(),
  amount: z.number(),
});
const AlarmTapConfigReadSchema = z.object({
  type: z.literal('alarm'),
  behavior: z.string(),
  snoozeDuration: z.number(),
  inactiveAlarmBehavior: z.string(),
});
/** A tap `type` this client doesn't recognize at all — still parses, degraded to just `type`. */
const UnknownTapConfigReadSchema = z.object({ type: z.string() });

export const TapConfigReadSchema = z.union([
  TemperatureTapConfigReadSchema,
  AlarmTapConfigReadSchema,
  UnknownTapConfigReadSchema,
]);
export type TapConfigRead = z.infer<typeof TapConfigReadSchema>;

const SideSettingsSchema = z.object({
  name: z.string(),
  awayMode: z.boolean(),
  scheduleOverrides: z.object({
    temperatureSchedules: z.object({
      disabled: z.boolean(),
      expiresAt: z.string(),
    }),
    alarm: z.object({
      disabled: z.boolean(),
      timeOverride: z.string(),
      expiresAt: z.string(),
    }),
  }),
  taps: z.object({
    doubleTap: TapConfigReadSchema,
    tripleTap: TapConfigReadSchema,
    quadTap: TapConfigReadSchema,
  }),
});

export const SettingsSchema = z.object({
  id: z.string(),
  timeZone: z.string(),
  left: SideSettingsSchema,
  right: SideSettingsSchema,
  primePodDaily: z.object({
    enabled: z.boolean(),
    time: z.string(),
  }),
  // Read shape: lenient — a plain string, not `z.enum(['celsius', 'fahrenheit'])`. Upstream
  // never re-validates `settingsDB.json` once written, so a value from a future
  // `temperatureFormat` option (or a hand-edited DB) must still parse.
  temperatureFormat: z.string(),
  rebootDaily: z.boolean(),
});

export type SideSettings = z.infer<typeof SideSettingsSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

/** Request shape: strict deep partial, mirroring `settings.ts`'s `.deepPartial().safeParse`. */
const SideSettingsPatchSchema = z
  .object({
    name: z.string().min(1).max(20),
    awayMode: z.boolean(),
    scheduleOverrides: z
      .object({
        temperatureSchedules: z
          .object({
            disabled: z.boolean(),
            expiresAt: z.string(),
          })
          .strict()
          .partial(),
        alarm: z
          .object({
            disabled: z.boolean(),
            timeOverride: z.string(),
            expiresAt: z.string(),
          })
          .strict()
          .partial(),
      })
      .strict()
      .partial(),
    // Each tap slot, if present, must be a complete TapConfig — a discriminated union has no
    // partial-field notion, matching upstream's own deepPartial (which only recurses into
    // ZodObject shapes, not unions).
    taps: z
      .object({
        doubleTap: TapConfigSchema,
        tripleTap: TapConfigSchema,
        quadTap: TapConfigSchema,
      })
      .strict()
      .partial(),
  })
  .strict()
  .partial();

export const SettingsPatchSchema = z
  .object({
    id: z.string(),
    timeZone: z.string(),
    left: SideSettingsPatchSchema,
    right: SideSettingsPatchSchema,
    primePodDaily: z
      .object({
        enabled: z.boolean(),
        time: z.string(),
      })
      .strict()
      .partial(),
    temperatureFormat: z.enum(['celsius', 'fahrenheit']),
    rebootDaily: z.boolean(),
  })
  .strict()
  .partial();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

// ---------------------------------------------------------------------------------------
// schedules — server/src/db/schedulesSchema.ts
// ---------------------------------------------------------------------------------------

export const SideSchema = z.enum(['left', 'right']);
export type Side = z.infer<typeof SideSchema>;

/**
 * Read shape: lenient. `POST /api/schedules` is not implemented by this change (proposal.md,
 * "not implemented" — it is the other expensive write, alongside `/api/settings`), so there is
 * no strict request-side time schema to mirror here; `TimeSchema` is the only variant, and it
 * is the read (lenient) one. A malformed time string in `schedulesDB.json` — hand-edited, or
 * written by a future free-sleep version with a different format — must still parse rather
 * than fail the whole schedules read. Should a schedules write ever be added, a strict
 * `HH:mm`-regex variant belongs alongside it as a request schema, the same split as
 * `TapConfigSchema` vs. `TapConfigReadSchema` above.
 */
export const TimeSchema = z.string();
const TemperatureSchema = z.number();

const AlarmScheduleSchema = z.object({
  vibrationIntensity: z.number(),
  vibrationPattern: z.string(),
  duration: z.number(),
  time: TimeSchema,
  enabled: z.boolean(),
  alarmTemperature: TemperatureSchema,
});

const DailyScheduleSchema = z.object({
  temperatures: z.record(z.string(), z.number()),
  alarm: AlarmScheduleSchema,
  power: z.object({
    on: TimeSchema,
    off: TimeSchema,
    onTemperature: TemperatureSchema,
    enabled: z.boolean(),
  }),
});

const SideScheduleSchema = z.object({
  sunday: DailyScheduleSchema,
  monday: DailyScheduleSchema,
  tuesday: DailyScheduleSchema,
  wednesday: DailyScheduleSchema,
  thursday: DailyScheduleSchema,
  friday: DailyScheduleSchema,
  saturday: DailyScheduleSchema,
});

export const SchedulesSchema = z.object({
  left: SideScheduleSchema,
  right: SideScheduleSchema,
});

export type DailySchedule = z.infer<typeof DailyScheduleSchema>;
export type SideSchedule = z.infer<typeof SideScheduleSchema>;
export type Schedules = z.infer<typeof SchedulesSchema>;
export type AlarmSchedule = z.infer<typeof AlarmScheduleSchema>;

// ---------------------------------------------------------------------------------------
// services — server/src/db/servicesSchema.ts
// (job status shape transitively vendored from
//  server/src/routes/serverStatus/serverStatusSchema.ts's StatusInfoSchema)
// ---------------------------------------------------------------------------------------

const StatusInfoSchema = z.object({
  name: z.string(),
  status: z.string(),
  description: z.string(),
  message: z.string(),
  timestamp: z.string().optional(),
});

export type StatusInfo = z.infer<typeof StatusInfoSchema>;

export const ServicesSchema = z.object({
  biometrics: z.object({
    enabled: z.boolean(),
    jobs: z.object({
      analyzeSleepLeft: StatusInfoSchema,
      analyzeSleepRight: StatusInfoSchema,
      installation: StatusInfoSchema,
      stream: StatusInfoSchema,
      calibrateLeft: StatusInfoSchema,
      calibrateRight: StatusInfoSchema,
    }),
  }),
  sentryLogging: z.object({
    enabled: z.boolean(),
  }),
});

export type Services = z.infer<typeof ServicesSchema>;

// ---------------------------------------------------------------------------------------
// subsystem health — server/src/routes/serverStatus/serverStatusSchema.ts
// (`hub-accessory`'s design.md, Decision 8: a genuine fifth top-level block, not a sub-shape of
// any of the four above)
// ---------------------------------------------------------------------------------------

/**
 * Structurally identical to the `services` block's own local `StatusInfoSchema` above — both are
 * `{name, status, description, message, timestamp?}`, `status` a lenient `z.string()` rather
 * than upstream's own enum (matching this file's read-side leniency convention: a status value
 * this client has never heard of must still parse). Deliberately **not** shared as one type
 * between the two blocks (design.md's Decision 8) — each stays independently diffable against
 * its own cited upstream file.
 */
const ServerStatusInfoSchema = z.object({
  name: z.string(),
  status: z.string(),
  description: z.string(),
  message: z.string(),
  timestamp: z.string().optional(),
});

export type ServerStatusInfo = z.infer<typeof ServerStatusInfoSchema>;

/**
 * Twelve subsystems are always present. The six biometrics-gated ones (`analyzeSleepLeft`,
 * `analyzeSleepRight`, `biometricsInstallation`, `biometricsStream`, `biometricsCalibrationLeft`,
 * `biometricsCalibrationRight`) are present only when `servicesDB.data.biometrics.enabled`
 * (`server/src/serverStatus.ts`'s `updateServices()`) — `.optional()`, matching this file's
 * read-side leniency everywhere else: an absent key parses fine, and the "any subsystem
 * `status === 'failed'`" derivation (`src/pod/snapshot.ts`) simply has fewer subsystems to check
 * when they're absent.
 */
export const ServerStatusSchema = z.object({
  alarmSchedule: ServerStatusInfoSchema,
  database: ServerStatusInfoSchema,
  express: ServerStatusInfoSchema,
  franken: ServerStatusInfoSchema,
  frankenMonitor: ServerStatusInfoSchema,
  jobs: ServerStatusInfoSchema,
  logger: ServerStatusInfoSchema,
  powerSchedule: ServerStatusInfoSchema,
  primeSchedule: ServerStatusInfoSchema,
  rebootSchedule: ServerStatusInfoSchema,
  systemDate: ServerStatusInfoSchema,
  temperatureSchedule: ServerStatusInfoSchema,
  analyzeSleepLeft: ServerStatusInfoSchema.optional(),
  analyzeSleepRight: ServerStatusInfoSchema.optional(),
  biometricsInstallation: ServerStatusInfoSchema.optional(),
  biometricsStream: ServerStatusInfoSchema.optional(),
  biometricsCalibrationLeft: ServerStatusInfoSchema.optional(),
  biometricsCalibrationRight: ServerStatusInfoSchema.optional(),
});

export type ServerStatus = z.infer<typeof ServerStatusSchema>;

// ---------------------------------------------------------------------------------------
// alarm trigger (request-only) — server/src/routes/alarm/alarm.ts, cross-checked against
// server/src/db/schedulesSchema.ts's AlarmJobSchema bounds and docs/POD-API.md
// ---------------------------------------------------------------------------------------

/**
 * Request-only: `PodClient.postAlarm` returns `void` (design.md's Decision 6) — this plugin
 * never reads a response body shaped like this. Strict, like every other request schema in this
 * file, and vendored with the same upstream-provenance discipline even though there is no read
 * counterpart to cross-check leniency against.
 */
export const AlarmRequestSchema = z
  .object({
    side: SideSchema,
    vibrationIntensity: z.number().int().min(1, { message: 'vibrationIntensity must be at least 1' }).max(100, {
      message: 'vibrationIntensity cannot exceed 100',
    }),
    vibrationPattern: z.enum(['double', 'rise']),
    duration: z.number().int().min(0, { message: 'duration must be non-negative' }).max(180, {
      message: 'duration cannot exceed 180',
    }),
    force: z.boolean(),
  })
  .strict();

export type AlarmRequest = z.infer<typeof AlarmRequestSchema>;

// ---------------------------------------------------------------------------------------
// waterLevel interpretation
// ---------------------------------------------------------------------------------------

/**
 * `waterLevel` is the raw string free-sleep reports. `"true"` means the tank reads adequate,
 * `"false"` means low (see docs/POD-API.md, `app/src/pages/ControlTempPage/WaterNotification.tsx`).
 * Anything else — including a value a future free-sleep version introduces — is `'unknown'`,
 * deliberately never collapsed into `'low'`: a HomeKit low-water alert firing because the
 * upstream string changed would be worse than one that stays silent.
 */
export type WaterLevel = 'ok' | 'low' | 'unknown';

export function interpretWaterLevel(raw: string): WaterLevel {
  if (raw === 'true') return 'ok';
  if (raw === 'false') return 'low';
  return 'unknown';
}
