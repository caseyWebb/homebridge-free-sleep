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

const RESERVED_KEYS = [
  'pollIntervals',
  'writeSettleMs',
  'noResponseAfterMs',
  'occupancySource',
  'waterLowSensorType',
  'keepAlive',
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
  it('fully defaults all seven reserved keys when omitted', () => {
    const result = FreeSleepConfigSchema.safeParse({ host: 'pod.local' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const key of RESERVED_KEYS) {
      expect(result.data[key]).not.toBeUndefined();
    }
    expect(result.data.pollIntervals).toEqual({});
    expect(result.data.writeSettleMs).toBe(15000);
    expect(result.data.noResponseAfterMs).toBe(600000);
    expect(result.data.occupancySource).toBe('none');
    expect(result.data.waterLowSensorType).toBe('contact');
    expect(result.data.keepAlive).toBe(true);
    expect(result.data.awayModeWritePolicy).toBe('mirror');
  });

  it.each([
    ['writeSettleMs', -1],
    ['noResponseAfterMs', -1],
    ['occupancySource', 'weather'],
    ['waterLowSensorType', 'moisture'],
    ['keepAlive', 'yes'],
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
    ['occupancySource', 'presence', 'presence'],
    ['waterLowSensorType', 'leak', 'leak'],
    ['keepAlive', false, false],
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
