import { describe, expect, it } from 'vitest';

import registerFreeSleepPlatform from '../src/index.js';
import { FreeSleepPlatform } from '../src/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

describe('src/index.ts registration', () => {
  it('calls api.registerPlatform with PLUGIN_NAME, PLATFORM_NAME, and FreeSleepPlatform', () => {
    const calls: unknown[][] = [];
    const fakeApi = {
      registerPlatform: (...args: unknown[]) => {
        calls.push(args);
      },
      // Minimal stand-in — only `registerPlatform` is called by src/index.ts.
    } as unknown as Parameters<typeof registerFreeSleepPlatform>[0];

    registerFreeSleepPlatform(fakeApi);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([PLUGIN_NAME, PLATFORM_NAME, FreeSleepPlatform]);
  });
});
