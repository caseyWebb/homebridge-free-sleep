import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FreeSleepConfigSchema, PollIntervalsFieldsSchema, unrecognizedConfigKeys } from '../src/config.js';
import { PLATFORM_NAME } from '../src/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface JsonSchemaProperty {
  type: string;
  default?: unknown;
  minimum?: number;
  properties?: Record<string, JsonSchemaProperty>;
}

function readConfigSchemaJson(): {
  pluginAlias: string;
  schema: { properties: Record<string, JsonSchemaProperty>; required?: string[] };
} {
  const text = readFileSync(path.join(__dirname, '../config.schema.json'), 'utf-8');
  return JSON.parse(text);
}

// `keepAlive` moved out of this list at `keep-alive` (#12), and `occupancySource` at `occupancy`
// (#19) — both are consumed starting with their own change, not merely reserved (config spec's
// MODIFIED requirement, "Reserved keys are fully defaulted..."). Their own defaulting/validation
// is covered by their own dedicated describe blocks below.
const RESERVED_KEYS = [
  'pollIntervals',
  'writeSettleMs',
  'noResponseAfterMs',
  'waterLowSensorType',
  'awayModeWritePolicy',
] as const;

describe('FreeSleepConfigSchema — host', () => {
  it('fails when host is missing', () => {
    const result = FreeSleepConfigSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'host')).toBe(true);
    }
  });

  it('fails when host is a non-string value', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 12345 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'host')).toBe(true);
    }
  });

  it('fails when host is an empty string', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'host')).toBe(true);
    }
  });

  it('succeeds with a valid, non-empty host', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: '10.0.0.5' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('10.0.0.5');
    }
  });

  it('trims surrounding whitespace from host', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: '  10.0.0.5  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('10.0.0.5');
    }
  });

  // F5: DNS hostnames are case-insensitive, so a differently-cased spelling of the same host
  // must normalize to the same value — otherwise `uuidFor` (src/platform.ts), which derives
  // HomeKit accessory UUIDs directly from this string, would silently mint a second identity
  // for what is meant to be the same Pod.
  it('lowercases host', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'Pod.Local' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('pod.local');
    }
  });

  it('lowercases host after trimming, so whitespace and case normalize together', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: '  Pod.Local  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('pod.local');
    }
  });

  it('two differently-cased spellings of the same host parse to an identical value', () => {
    const lower = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    const mixed = FreeSleepConfigSchema.safeParse({ host: 'Pod.local' });
    const upper = FreeSleepConfigSchema.safeParse({ host: 'POD.LOCAL' });
    expect(lower.success && mixed.success && upper.success).toBe(true);
    if (lower.success && mixed.success && upper.success) {
      expect(mixed.data.host).toBe(lower.data.host);
      expect(upper.data.host).toBe(lower.data.host);
    }
  });

  it('is a no-op for an already-lowercase IP address', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: '10.0.0.5' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('10.0.0.5');
    }
  });
});

describe('FreeSleepConfigSchema — sides', () => {
  it('defaults to "both" when omitted', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sides).toBe('both');
    }
  });

  it.each(['both', 'left', 'right'] as const)('accepts %s', (sides) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', sides });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sides).toBe(sides);
    }
  });

  it.each(['Both', '', 'BOTH', 'up', 'left ' /* trailing space */])('rejects %j', (sides) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', sides });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'sides')).toBe(true);
    }
  });
});

describe('FreeSleepConfigSchema — reserved keys', () => {
  it('fully defaults all five reserved keys when omitted', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const key of RESERVED_KEYS) {
      expect(result.data[key]).not.toBeUndefined();
    }
    expect(result.data.pollIntervals).toEqual({});
    expect(result.data.writeSettleMs).toBe(15000);
    expect(result.data.noResponseAfterMs).toBe(600000);
    expect(result.data.waterLowSensorType).toBe('contact');
    expect(result.data.awayModeWritePolicy).toBe('mirror');
  });

  it.each([
    ['writeSettleMs', -1],
    ['noResponseAfterMs', -1],
    ['waterLowSensorType', 'moisture'],
    ['awayModeWritePolicy', 'ignore'],
  ] as const)('rejects an invalid %s value, naming that key', (key, value) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', [key]: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === key)).toBe(true);
    }
  });

  it.each([
    ['writeSettleMs', 30000, 30000],
    ['noResponseAfterMs', 0, 0],
    ['waterLowSensorType', 'leak', 'leak'],
    ['awayModeWritePolicy', 'block', 'block'],
  ] as const)('parses a valid non-default %s value unchanged', (key, value, expected) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', [key]: value });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[key]).toBe(expected);
    }
  });

  describe('pollIntervals', () => {
    it.each([
      ['pollIntervalMs', 100],
      ['fastPollIntervalMs', 0],
      ['fastPollDurationMs', -1],
      ['slowPollIntervalMs', 1000],
      ['maxBackoffMs', 0],
      ['writeDebounceMs', -1],
      ['writeMaxDebounceMs', -1],
      ['alarmPollIntervalMs', 0],
      ['bootstrapTimeoutMs', 0],
    ] as const)('rejects an out-of-range pollIntervals.%s', (field, value) => {
      const result = FreeSleepConfigSchema.safeParse({
        host: 'pod.local',
        pollIntervals: { [field]: value },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path.join('.') === `pollIntervals.${field}`),
        ).toBe(true);
      }
    });

    it.each([
      ['pollIntervalMs', 45000],
      ['fastPollIntervalMs', 7000],
      ['fastPollDurationMs', 120000],
      ['slowPollIntervalMs', 600000],
      ['maxBackoffMs', 90000],
      ['writeDebounceMs', 800],
      ['writeMaxDebounceMs', 3000],
      ['alarmPollIntervalMs', 5000],
      ['bootstrapTimeoutMs', 15000],
    ] as const)('parses a valid non-default pollIntervals.%s unchanged', (field, value) => {
      const result = FreeSleepConfigSchema.safeParse({
        host: 'pod.local',
        pollIntervals: { [field]: value },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pollIntervals[field]).toBe(value);
      }
    });

    // Config boundary alignment: fastPollIntervalMs/alarmPollIntervalMs share poller.ts's
    // HARD_FLOOR_MS (3000), and writeDebounceMs shares writeQueue.ts's own Math.max(100, …)
    // floor — so a configured value the module would silently clamp anyway must instead fail
    // loudly in config, naming both the configured and the enforced value.
    it.each([
      ['fastPollIntervalMs', 2999],
      ['alarmPollIntervalMs', 2999],
      ['writeDebounceMs', 99],
    ] as const)('rejects pollIntervals.%s one below the module floor it mirrors', (field, value) => {
      const result = FreeSleepConfigSchema.safeParse({
        host: 'pod.local',
        pollIntervals: { [field]: value },
      });
      expect(result.success).toBe(false);
    });
  });
});

// occupancy (#19): occupancySource is consumed starting with this change, not merely reserved
// (config spec's MODIFIED requirement, "`occupancySource` is preserved and now acted on"). The
// schema shape itself (`z.enum(['none', 'presence', 'vitals']).default('none')`) is unchanged —
// these tests confirm that shape still holds, now under its own describe block rather than the
// generic "reserved keys" one above.
describe('FreeSleepConfigSchema — occupancySource (consumed, #19)', () => {
  it("defaults to 'none' when omitted", () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.occupancySource).toBe('none');
    }
  });

  it('rejects an invalid value, naming the key', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', occupancySource: 'weather' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'occupancySource')).toBe(true);
    }
  });

  it.each(['none', 'presence', 'vitals'] as const)('parses %s unchanged', (value) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', occupancySource: value });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.occupancySource).toBe(value);
    }
  });
});

// keep-alive (#12): keepAlive/keepAliveMs/keepAliveThresholdMs are consumed starting with this
// change (specs/config/spec.md's ADDED requirement, "`keepAlive`, `keepAliveMs`, and
// `keepAliveThresholdMs` are defaulted and validated").
describe('FreeSleepConfigSchema — keepAlive, keepAliveMs, keepAliveThresholdMs', () => {
  it('all three default when omitted', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.keepAlive).toBe(true);
    expect(result.data.keepAliveMs).toBe(43_200_000);
    expect(result.data.keepAliveThresholdMs).toBe(1_800_000);
  });

  it('rejects a non-boolean keepAlive, naming that key', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', keepAlive: 'yes' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'keepAlive')).toBe(true);
    }
  });

  it('parses a valid non-default keepAlive value unchanged', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', keepAlive: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keepAlive).toBe(false);
    }
  });

  it.each([
    ['keepAliveMs', 999],
    ['keepAliveThresholdMs', 999],
  ] as const)('rejects a below-minimum %s, naming that key', (key, value) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', [key]: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === key)).toBe(true);
    }
  });

  // F3 (PR #40 review): keepAliveThresholdMs's own minimum rose from 1000ms to 120_000ms (2 min)
  // — see src/config.ts's doc comment for why (the derived check-interval guarantee only holds
  // once keepAliveThresholdMs / 2 reaches the 60_000ms check-interval floor on its own). Pinned
  // exactly at the new boundary, one below it, so a future accidental revert of the bound fails
  // this test rather than only the vaguer "999" case above.
  it('rejects keepAliveThresholdMs one below its new 120000ms minimum, naming that key', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 200_000,
      keepAliveThresholdMs: 119_999,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'keepAliveThresholdMs')).toBe(true);
    }
  });

  it('accepts keepAliveThresholdMs exactly at its minimum, given a large-enough keepAliveMs', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 200_000,
      keepAliveThresholdMs: 120_000,
    });
    expect(result.success).toBe(true);
  });

  // keepAliveMs cannot be accepted at its own literal minimum (1000): keepAliveThresholdMs's
  // own minimum is now 120_000 (F3), and the cross-field check requires it strictly less than
  // keepAliveMs — so no valid threshold exists anywhere near keepAliveMs's own floor. This is
  // exercised instead by the "one below keepAliveMs" test further below, at a keepAliveMs
  // comfortably above keepAliveThresholdMs's own 120_000 minimum.
  it('accepts keepAliveMs one above the combined floor (keepAliveThresholdMs at its own minimum)', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 120_001,
      keepAliveThresholdMs: 120_000,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['keepAliveMs', 1.5],
    ['keepAliveThresholdMs', 1.5],
  ] as const)('rejects a non-integer %s, naming that key', (key, value) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', [key]: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === key)).toBe(true);
    }
  });

  it('parses valid, non-default keepAliveMs/keepAliveThresholdMs unchanged', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 3_600_000,
      keepAliveThresholdMs: 300_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keepAliveMs).toBe(3_600_000);
      expect(result.data.keepAliveThresholdMs).toBe(300_000);
    }
  });

  it('rejects keepAliveThresholdMs equal to keepAliveMs, identifying the conflict', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 200_000,
      keepAliveThresholdMs: 200_000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'keepAliveThresholdMs')).toBe(true);
    }
  });

  it('rejects keepAliveThresholdMs greater than keepAliveMs, identifying the conflict', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 200_000,
      keepAliveThresholdMs: 300_000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'keepAliveThresholdMs')).toBe(true);
    }
  });

  it('accepts keepAliveThresholdMs one below keepAliveMs', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 200_000,
      keepAliveThresholdMs: 199_999,
    });
    expect(result.success).toBe(true);
  });
});

// F3 (PR #40 review): config.schema.json's own `minimum` for keepAliveThresholdMs must track
// the zod boundary exactly, not merely "close enough" — a UI-side minimum lower than the zod
// minimum would let a value through the config UI that the plugin then refuses at startup.
describe('config.schema.json <-> FreeSleepConfigSchema parity — keepAliveThresholdMs minimum (F3)', () => {
  it("config.schema.json's keepAliveThresholdMs.minimum is exactly 120000, matching the zod boundary", () => {
    const property = readConfigSchemaJson().schema.properties.keepAliveThresholdMs;
    expect(property, 'config.schema.json is missing keepAliveThresholdMs').toBeDefined();
    expect(property?.minimum).toBe(120_000);

    const oneBelow = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 200_000,
      keepAliveThresholdMs: (property?.minimum ?? 0) - 1,
    });
    const at = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      keepAliveMs: 200_000,
      keepAliveThresholdMs: property?.minimum,
    });
    expect(oneBelow.success).toBe(false);
    expect(at.success).toBe(true);
  });
});

describe('config.schema.json <-> FreeSleepConfigSchema parity', () => {
  it('exposes exactly the schema keys, both directions', () => {
    const schemaKeys = new Set(Object.keys(FreeSleepConfigSchema.shape));
    const uiKeys = new Set(Object.keys(readConfigSchemaJson().schema.properties));
    expect(uiKeys).toEqual(schemaKeys);
  });

  it('marks pluginAlias identical to PLATFORM_NAME', () => {
    expect(readConfigSchemaJson().pluginAlias).toBe(PLATFORM_NAME);
  });

  // F6: the top-level key-set comparison above says nothing about `pollIntervals`'s *nested*
  // fields — a mismatched nested key, type, or default there was invisible to it. This block
  // compares `PollIntervalsFieldsSchema`'s own shape against `config.schema.json`'s nested
  // `pollIntervals.properties`, per the config spec's "every schema key has a UI field / no
  // undocumented UI field exists" requirement, which does not carve out an exception for
  // nested objects.
  describe('nested pollIntervals keys, types, and defaults', () => {
    function pollIntervalsJsonProperties(): Record<string, JsonSchemaProperty> {
      const properties = readConfigSchemaJson().schema.properties.pollIntervals?.properties;
      if (!properties) {
        throw new Error('config.schema.json has no pollIntervals.properties to compare against');
      }
      return properties;
    }

    it('exposes exactly the same nested keys, both directions', () => {
      const zodKeys = new Set(Object.keys(PollIntervalsFieldsSchema.shape));
      const jsonKeys = new Set(Object.keys(pollIntervalsJsonProperties()));
      expect(jsonKeys).toEqual(zodKeys);
    });

    it.each(Object.keys(PollIntervalsFieldsSchema.shape))(
      'pollIntervals.%s: json type is integer, has no per-field default, and its minimum matches the ' +
        'zod boundary exactly',
      (field) => {
        const property = pollIntervalsJsonProperties()[field];
        expect(property, `config.schema.json is missing pollIntervals.${field}`).toBeDefined();
        if (!property) return;

        // Type: json's "integer" corresponds to zod's z.number().int().
        expect(property.type).toBe('integer');

        // Default: every pollIntervals field is an *override* — the container defaults to
        // `{}`, but no individual field has its own default (module doc in src/config.ts).
        // Neither side may claim one.
        expect(property.default).toBeUndefined();
        const omitted = FreeSleepConfigSchema.safeParse({ host: 'pod.local', pollIntervals: {} });
        expect(omitted.success).toBe(true);
        if (omitted.success) {
          expect(omitted.data.pollIntervals[field as keyof typeof omitted.data.pollIntervals]).toBeUndefined();
        }

        // Minimum: json's minimum must be the exact zod boundary, not merely "close enough" —
        // one below it must fail, and the value itself must succeed.
        const minimum = property.minimum;
        expect(minimum, `config.schema.json's pollIntervals.${field} has no minimum`).toBeDefined();
        if (minimum === undefined) return;
        const below = FreeSleepConfigSchema.safeParse({
          host: 'pod.local',
          pollIntervals: { [field]: minimum - 1 },
        });
        const at = FreeSleepConfigSchema.safeParse({
          host: 'pod.local',
          pollIntervals: { [field]: minimum },
        });
        expect(below.success).toBe(false);
        expect(at.success).toBe(true);
      },
    );
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: four new hub-service keys (tasks.md 7.1)
// ---------------------------------------------------------------------------------------

const HUB_SERVICE_KEYS = ['primeSwitch', 'ledLightbulb', 'testAlarmSwitch', 'serverFaultSensor'] as const;

describe('FreeSleepConfigSchema — hub-service keys (hub-accessory)', () => {
  it('all four default to false when omitted', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const key of HUB_SERVICE_KEYS) {
      expect(result.data[key]).toBe(false);
    }
  });

  it.each(HUB_SERVICE_KEYS)('%s can be independently enabled, leaving the other three at their default false', (key) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', [key]: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const otherKey of HUB_SERVICE_KEYS) {
      expect(result.data[otherKey]).toBe(otherKey === key);
    }
  });

  it.each(HUB_SERVICE_KEYS)('rejects a non-boolean %s, naming that key', (key) => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', [key]: 'yes' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: pollIntervals.deviceWriteDebounceMs (tasks.md 7.2)
// ---------------------------------------------------------------------------------------

describe('FreeSleepConfigSchema — pollIntervals.deviceWriteDebounceMs (hub-accessory)', () => {
  it('defaults through (omitted) when pollIntervals omits it', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pollIntervals.deviceWriteDebounceMs).toBeUndefined();
    }
  });

  it('rejects a value below 500', () => {
    const result = FreeSleepConfigSchema.safeParse({
      host: 'pod.local',
      pollIntervals: { deviceWriteDebounceMs: 499 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.join('.') === 'pollIntervals.deviceWriteDebounceMs'),
      ).toBe(true);
    }
  });

  it('accepts exactly the 500ms floor and a value above it', () => {
    for (const value of [500, 800]) {
      const result = FreeSleepConfigSchema.safeParse({
        host: 'pod.local',
        pollIntervals: { deviceWriteDebounceMs: value },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pollIntervals.deviceWriteDebounceMs).toBe(value);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
// hub-accessory: waterLowSensorType is consumed (tasks.md 7.3) — shape unchanged, still exactly
// a two-value enum; the existing "reserved keys" describe block above already covers its
// defaulting/rejection cases unmodified.
// ---------------------------------------------------------------------------------------

describe('FreeSleepConfigSchema — waterLowSensorType is consumed, stays a two-value enum (hub-accessory)', () => {
  it('accepts exactly "contact" and "leak", nothing else', () => {
    for (const value of ['contact', 'leak']) {
      const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local', waterLowSensorType: value });
      expect(result.success).toBe(true);
    }
    const rejected = FreeSleepConfigSchema.safeParse({ host: 'pod.local', waterLowSensorType: 'none' });
    expect(rejected.success).toBe(false);
  });
});

describe('unrecognizedConfigKeys', () => {
  it('ignores Homebridge-injected keys and schema-defined keys', () => {
    expect(
      unrecognizedConfigKeys({
        platform: PLATFORM_NAME,
        name: 'FreeSleep',
        _bridge: { username: 'AA:BB:CC:DD:EE:FF' },
        host: 'pod.local',
        sides: 'both',
      }),
    ).toEqual([]);
  });

  it("names a typo'd top-level key", () => {
    expect(
      unrecognizedConfigKeys({
        platform: PLATFORM_NAME,
        host: 'pod.local',
        hots: '10.0.0.5',
      }),
    ).toEqual(['hots']);
  });

  it('names every unrecognized key when there is more than one', () => {
    expect(unrecognizedConfigKeys({ host: 'pod.local', foo: 1, bar: 2 })).toEqual(['foo', 'bar']);
  });

  it('returns an empty array for a config object with no unrecognized keys at all', () => {
    expect(unrecognizedConfigKeys({ host: 'pod.local' })).toEqual([]);
  });
});
