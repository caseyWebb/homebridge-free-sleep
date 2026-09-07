## Why

`isOn: true` is implemented server-side as a 12-hour duration (`server/src/routes/deviceStatus/updateDeviceStatus.ts`
sets `'43200'`), and the Pod derives `isOn` on read as `secondsRemaining > 0`
(`server/src/8sleep/loadDeviceStatus.ts`). A side HomeKit believes is "on" will therefore
quietly turn itself off overnight with no user action and no error — the plugin never told
the Pod to stay on. Issue #12 tracks this. `config.ts` already reserves a `keepAlive` boolean
(default `true`) for exactly this; this change makes it live.

## What Changes

- Introduces a small, dedicated `KeepAlive` component (`src/pod/keepAlive.ts`) that owns a
  single self-rescheduling timer, independent of both `PodPoller` and `WriteQueue`'s own
  internals, and re-posts a side's `secondsRemaining` shortly before its 12-hour duration
  would expire — but only while that side is currently observed on.
- Adds two new config keys, both following the project's established `...Ms` convention
  (`writeSettleMs`, `noResponseAfterMs`) rather than issue #12's original `keepAliveSeconds`/
  `keepAliveThresholdSec` text, per the tech-lead resolution recorded in
  `poller-and-write-queue`'s archived design ("`...Ms` naming stands everywhere... it should
  be `keepAliveMs`, not `keepAliveSeconds`"):
  - `keepAliveMs` — the duration (in ms) re-posted as `secondsRemaining` when re-arming.
    Default 43 200 000 (12 h), matching the Pod's own duration.
  - `keepAliveThresholdMs` — re-arm once a side's remaining time drops below this. Default
    1 800 000 (30 min).
- Makes the already-reserved `keepAlive` boolean key live: `false` disables the component
  entirely (no timer, no writes), `true` (the default) runs it.
- Routes every re-arm write through the existing `WriteQueue.submitSide` — the same entry
  point every HomeKit-triggered write already uses — rather than talking to `PodClient`
  directly, so it inherits debouncing, the global mutex, and the power/duration reduction for
  free for free.
- No HomeKit-visible surface. No new accessory, service, or characteristic — config-only, per
  issue #12 ("A switch that controls the bridge rather than the device is confusing.").

## Capabilities

### New Capabilities

- `pod-keep-alive`: the periodic re-arm behavior — when it checks, what it writes, how it
  avoids redundant re-arms while a previous one is still settling, why it installs no
  optimistic overlay, and why a side that comes back off after the Pod's daily reboot is never
  re-ignited.

### Modified Capabilities

- `config`: `keepAlive` moves out of the "reserved, fully defaulted but unused" bucket
  (`config` spec, "Reserved keys are fully defaulted and genuinely validated, even though
  unused this change") into an actively-consumed key; two new keys `keepAliveMs` and
  `keepAliveThresholdMs` are added with their own validated bounds and defaults.

## Impact

- **Endpoint touched:** `POST /api/deviceStatus` only, with a body of the shape
  `{ [side]: { secondsRemaining: <keepAliveMs / 1000> } }`. This is a direct hardware command
  over `updateSide`'s socket queue (`server/src/8sleep/frankenServer.ts`), not a
  `settingsDB.json`/`schedulesDB.json` write — it does **not** trigger the Pod's job-rebuild
  path (docs/POD-API.md, "the four things that shape the whole plugin", #2). It is exactly as
  cheap as any other HomeKit-triggered `isOn`/`targetTemperatureF` write already routed
  through `WriteQueue`.
- **Code:** new `src/pod/keepAlive.ts`; `src/config.ts` gains `keepAliveMs`/
  `keepAliveThresholdMs` and `keepAlive`'s doc comment moves from "reserved" to "consumed";
  `src/platform.ts` constructs and owns the new component alongside the poller and write
  queue, and stops it on `shutdown`.
- **No migration, no persisted state, no new accessory/service.** Rollback is deleting one
  source file, its test, and reverting the two config/platform wiring edits.
