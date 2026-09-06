import { describe, expect, it } from 'vitest';

import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

describe('settings', () => {
  it('PLUGIN_NAME matches the name Homebridge resolves the plugin by', () => {
    expect(PLUGIN_NAME).toBe('homebridge-free-sleep');
  });

  it('PLATFORM_NAME matches the pluginAlias/platform key', () => {
    expect(PLATFORM_NAME).toBe('FreeSleep');
  });
});
