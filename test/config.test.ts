import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FreeSleepConfigSchema } from '../src/config.js';
import { PLATFORM_NAME } from '../src/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readConfigSchemaJson(): {
  pluginAlias: string;
  schema: { properties: Record<string, unknown>; required?: string[] };
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
});
