/**
 * Vendored wire contract for free-sleep's LAN HTTP API.
 *
 * Copied — not depended upon — from https://github.com/throwaway31265/free-sleep at
 * **v2.1.5, commit `dc0c710`**. See `openspec/changes/pod-client/design.md` ("Decisions" ->
 * "`types.ts` vendors runtime zod schemas, not bare TypeScript types") for why this is
 * runtime zod rather than hand-written `interface`s, and for the read-vs-request leniency
 * rule applied throughout this file.
 *
 * Four blocks, one per upstream source file:
 *
 *   | Block         | Upstream source                                                |
 *   |---------------|-----------------------------------------------------------------|
 *   | device status | server/src/routes/deviceStatus/deviceStatusSchema.ts             |
 *   | settings      | server/src/db/settingsSchema.ts                                  |
 *   | schedules     | server/src/db/schedulesSchema.ts                                 |
 *   | services      | server/src/db/servicesSchema.ts                                  |
 *
 * `services` also transitively needs the per-job status shape from
 * server/src/routes/serverStatus/serverStatusSchema.ts (`StatusInfoSchema`); that shape is
 * reproduced locally in the services block below rather than added as a fifth top-level
 * block, since nothing outside `ServicesSchema` needs it.
 *
 * Read schemas (`DeviceStatusSchema`, `SettingsSchema`, `SchedulesSchema`, `ServicesSchema`)
 * are **lenient**: `.passthrough()` instead of upstream's `.strict()`, and no
 * `targetTemperatureF` range bound on the device-status read shape. The Pod never validates
 * its own responses (see design.md), so a strict read schema would fail an otherwise-usable
 * snapshot over a new field or an out-of-range hardware reading.
 *
 * Request schemas (`DeviceStatusPatchSchema`, `SettingsPatchSchema`) are **strict** deep
 * partials — a local mirror of what the Pod actually enforces on `POST`. Note: this project's
 * pinned zod (v4) has no `.deepPartial()` (that was a zod v3 API upstream relies on), so each
 * nesting level below is partialled explicitly.
 *
 * `timeZone` is typed as a bare string rather than upstream's `z.enum(TIME_ZONES)` — the
 * ~600-entry IANA list lives in `server/src/db/timeZones.ts`, which is not one of the four
 * files this change vendors, and nothing here branches on a specific zone.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------------------
// device status — server/src/routes/deviceStatus/deviceStatusSchema.ts
// ---------------------------------------------------------------------------------------

/** Read shape: lenient. Unknown properties pass through; no temperature range bound. */
export const SideStatusSchema = z
  .object({
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
      .passthrough()
      .optional(),
  })
  .passthrough();

export const DeviceStatusSchema = z
  .object({
    left: SideStatusSchema,
    right: SideStatusSchema,
    // Raw string, not a coerced boolean — see interpretWaterLevel below.
    waterLevel: z.string(),
    isPriming: z.boolean(),
    settings: z
      .object({
        v: z.number(),
        gainLeft: z.number(),
        gainRight: z.number(),
        ledBrightness: z.number(),
      })
      .passthrough(),
    coverVersion: z.string(),
    hubVersion: z.string(),
    freeSleep: z
      .object({
        version: z.string(),
        branch: z.string(),
      })
      .passthrough(),
    wifiStrength: z.number(),
  })
  .passthrough();

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

/** Read shape: lenient. */
const SideSettingsSchema = z
  .object({
    name: z.string(),
    awayMode: z.boolean(),
    scheduleOverrides: z
      .object({
        temperatureSchedules: z
          .object({
            disabled: z.boolean(),
            expiresAt: z.string(),
          })
          .passthrough(),
        alarm: z
          .object({
            disabled: z.boolean(),
            timeOverride: z.string(),
            expiresAt: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
    taps: z
      .object({
        doubleTap: TapConfigSchema,
        tripleTap: TapConfigSchema,
        quadTap: TapConfigSchema,
      })
      .passthrough(),
  })
  .passthrough();

export const SettingsSchema = z
  .object({
    id: z.string(),
    timeZone: z.string(),
    left: SideSettingsSchema,
    right: SideSettingsSchema,
    primePodDaily: z
      .object({
        enabled: z.boolean(),
        time: z.string(),
      })
      .passthrough(),
    temperatureFormat: z.enum(['celsius', 'fahrenheit']),
    rebootDaily: z.boolean(),
  })
  .passthrough();

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

const timeRegexFormat = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const TimeSchema = z.string().regex(timeRegexFormat, 'Invalid time format, must be HH:mm');
const TemperatureSchema = z.number();

const AlarmScheduleSchema = z
  .object({
    vibrationIntensity: z.number(),
    vibrationPattern: z.string(),
    duration: z.number(),
    time: TimeSchema,
    enabled: z.boolean(),
    alarmTemperature: TemperatureSchema,
  })
  .passthrough();

const DailyScheduleSchema = z
  .object({
    temperatures: z.record(z.string(), z.number()),
    alarm: AlarmScheduleSchema,
    power: z
      .object({
        on: TimeSchema,
        off: TimeSchema,
        onTemperature: TemperatureSchema,
        enabled: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const SideScheduleSchema = z
  .object({
    sunday: DailyScheduleSchema,
    monday: DailyScheduleSchema,
    tuesday: DailyScheduleSchema,
    wednesday: DailyScheduleSchema,
    thursday: DailyScheduleSchema,
    friday: DailyScheduleSchema,
    saturday: DailyScheduleSchema,
  })
  .passthrough();

export const SchedulesSchema = z
  .object({
    left: SideScheduleSchema,
    right: SideScheduleSchema,
  })
  .passthrough();

export type DailySchedule = z.infer<typeof DailyScheduleSchema>;
export type SideSchedule = z.infer<typeof SideScheduleSchema>;
export type Schedules = z.infer<typeof SchedulesSchema>;
export type AlarmSchedule = z.infer<typeof AlarmScheduleSchema>;

// ---------------------------------------------------------------------------------------
// services — server/src/db/servicesSchema.ts
// (job status shape transitively vendored from
//  server/src/routes/serverStatus/serverStatusSchema.ts's StatusInfoSchema)
// ---------------------------------------------------------------------------------------

const StatusInfoSchema = z
  .object({
    name: z.string(),
    status: z.string(),
    description: z.string(),
    message: z.string(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export type StatusInfo = z.infer<typeof StatusInfoSchema>;

export const ServicesSchema = z
  .object({
    biometrics: z
      .object({
        enabled: z.boolean(),
        jobs: z
          .object({
            analyzeSleepLeft: StatusInfoSchema,
            analyzeSleepRight: StatusInfoSchema,
            installation: StatusInfoSchema,
            stream: StatusInfoSchema,
            calibrateLeft: StatusInfoSchema,
            calibrateRight: StatusInfoSchema,
          })
          .passthrough(),
      })
      .passthrough(),
    sentryLogging: z
      .object({
        enabled: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export type Services = z.infer<typeof ServicesSchema>;

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
