import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadFixture } from './loadFixture.js';
import {
  DeviceStatusSchema,
  SchedulesSchema,
  ServicesSchema,
  SettingsSchema,
} from '../src/pod/types.js';

interface ReadSchema {
  parse(data: unknown): unknown;
}

/**
 * Maps a fixture filename to the read schema it must parse against, by prefix rather than by
 * exact name.
 *
 * S5 in the pod-client code review: the previous version of this file was a hardcoded table
 * of exact filenames, so a new fixture added to `test/fixtures/` without a matching row here
 * silently exercised nothing — the promised "adding a fixture without a row is itself caught"
 * property didn't actually hold, since the fixture list was `readdirSync`-independent. This
 * version enumerates `test/fixtures/*.json` directly and FAILS the corresponding test for any
 * filename `schemaFor` doesn't recognize, so an unmapped fixture is a loud test failure, not a
 * silent gap.
 */
function schemaFor(name: string): ReadSchema {
  if (name.startsWith('deviceStatus')) return DeviceStatusSchema;
  if (name === 'settings.json') return SettingsSchema;
  if (name === 'schedules.json') return SchedulesSchema;
  if (name === 'services.json') return ServicesSchema;
  throw new Error(
    `test/fixtures/${name} has no schema mapping in fixtures.test.ts's schemaFor() — add one ` +
      "there before this fixture can be trusted to parse against its intended read schema.",
  );
}

const fixturesDir = fileURLToPath(new URL('fixtures/', import.meta.url));
const fixtureFiles = readdirSync(fixturesDir).filter((name) => name.endsWith('.json'));

describe('every fixture parses through its read schema', () => {
  // Sanity check on the enumeration itself: if `test/fixtures/*.json` is ever empty (a
  // misconfigured path, a botched rename), `it.each` below would silently run zero cases and
  // the whole describe block would report as passing.
  it('finds at least one fixture file to check', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)('%s parses', (name) => {
    const schema = schemaFor(name);
    const data = loadFixture(name);
    expect(() => schema.parse(data)).not.toThrow();
  });

  it('a fixture missing a required field fails, naming the property', () => {
    const deviceStatus = loadFixture('deviceStatus.json') as {
      left: Record<string, unknown>;
      [key: string]: unknown;
    };
    const leftWithoutIsOn = { ...deviceStatus.left };
    delete leftWithoutIsOn.isOn;
    const broken = { ...deviceStatus, left: leftWithoutIsOn };

    let message = '';
    try {
      DeviceStatusSchema.parse(broken);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/isOn/);
  });
});

describe('the device-status fixture asserts the absence of gesture tap counters', () => {
  it('deviceStatus.json has no taps object on either side', () => {
    const deviceStatus = loadFixture('deviceStatus.json') as {
      left: Record<string, unknown>;
      right: Record<string, unknown>;
    };
    const hasTaps = (side: Record<string, unknown>): boolean => 'taps' in side;

    if (hasTaps(deviceStatus.left) || hasTaps(deviceStatus.right)) {
      throw new Error(
        'deviceStatus.json now contains `taps` — the assumption behind #21 ' +
          '(gesture tap counters are never present in the HTTP device-status response) ' +
          "has been invalidated. Re-read docs/POD-API.md and free-sleep's " +
          'server/src/8sleep/frankenServer.ts before proceeding with #21.',
      );
    }
    expect(hasTaps(deviceStatus.left)).toBe(false);
    expect(hasTaps(deviceStatus.right)).toBe(false);
  });
});
