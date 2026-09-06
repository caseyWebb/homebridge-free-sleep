import type { API } from 'homebridge';

import { FreeSleepPlatform } from './platform.ts';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.ts';

export default function (api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, FreeSleepPlatform);
}
