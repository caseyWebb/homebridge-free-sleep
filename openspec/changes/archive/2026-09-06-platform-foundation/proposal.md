## Why

Nothing in this repo registers with Homebridge yet. Every M2 accessory feature — the
thermostat service (#9), offline handling (#11) — needs somewhere to live: a
`DynamicPlatformPlugin` that knows how many accessories to publish, what stable identity
each one has, and how to survive a restart without duplicating or orphaning them. That
topology, plus the config surface that drives it (which host to talk to, which side(s) to
expose), has to exist and be correct *before* any characteristic is added, because getting
UUID/restore/prune wrong is exactly the kind of bug that only shows up as duplicate tiles
in someone's Home app after the fact.

Resolves #7 (milestone M2 — Core thermostat).

## What Changes

- **`src/config.ts`** — a zod schema for the platform config block, `z.infer` types,
  defaults, and normalization (trimming/lowercasing where relevant, coercing `sides` etc.).
  Every key the tech lead has fixed for the eventual feature set is defined now — `host`,
  `sides`, `pollIntervals` overrides, `writeSettleMs`, `noResponseAfterMs`,
  `occupancySource`, `waterLowSensorType`, `keepAlive`, `awayModeWritePolicy` — so later
  changes add *behavior* behind an already-stable key, never a new key. Only `host` and
  `sides` are consumed by this change; the rest are validated and normalized but otherwise
  ignored (see design.md's consumed-vs-reserved table).
- **`config.schema.json`** — the Homebridge UI's JSON-schema form for the block above.
  `pluginAlias` is `"FreeSleep"`, matching `PLATFORM_NAME` in `src/settings.ts`.
- **`src/platform.ts`** — `FreeSleepPlatform implements DynamicPlatformPlugin`. Publishes
  up to three bridged accessories (`Pod Left`, `Pod Right`, `Pod` hub) per docs/HOMEKIT.md,
  each carrying only `AccessoryInformation` after this change — no thermostat, no sensor,
  no switch service exists yet (that is `thermostat-and-offline`, a later change). Handles:
  stable UUID/SerialNumber derivation from the *configured* host, `configureAccessory`
  restore with prune-on-restore for any service subtype no longer enabled, unregistering
  the unused side's accessory when `sides !== 'both'`, one-time display-name seeding from
  `GET /api/settings` for accessories that do not already exist in the Homebridge cache,
  and bailing out of the constructor with a clear log line — without registering, restoring,
  or unregistering anything — when `host` is not configured.
- **`src/index.ts`** — registers `FreeSleepPlatform` under `PLATFORM_NAME` via
  `api.registerPlatform`.

**BREAKING**: none — this is the first change to touch the plugin's HomeKit surface.

## Non-goals

- **No thermostat, sensor, switch, or any non-`AccessoryInformation` service.** That is
  `thermostat-and-offline` (#9, #11). This change's "done when" is explicitly three
  accessories with *only* `AccessoryInformation`.
- **No polling, no cache, no `PodPoller`** (#8, change `poller-and-write-queue`). The
  one-time settings read for name seeding is a single ad-hoc `PodClient.getSettings()`
  call at startup, not a recurring poll.
- **No write queue, no keep-alive, no away-mode write guard** (#10, #12, #13). This change
  writes nothing to the Pod at all.
- **No behavior behind the reserved config keys.** `pollIntervals`, `writeSettleMs`,
  `noResponseAfterMs`, `occupancySource`, `waterLowSensorType`, `keepAlive`, and
  `awayModeWritePolicy` are schema'd, defaulted, and validated now so later changes never
  need a new key or a config migration — but nothing in this change reads them for
  behavior.
- **No renaming of an already-created accessory.** Display names are seeded once, at the
  moment a `PlatformAccessory` is first created, and never rewritten from a later poll or
  settings read — including across a Pod becoming reachable after an unreachable first
  launch.
- **No schedule editing, no `/api/jobs`, no `/api/execute`** — out of scope for the whole
  project (docs/ROADMAP.md).
- **No custom Homebridge UI widgets.** `config.schema.json` uses the standard schema-form
  the Homebridge UI already renders; nothing here needs a custom UI plugin.

## free-sleep API endpoints touched

| Endpoint | Used by | Cost |
|---|---|---|
| `GET /api/settings` | `src/platform.ts`, once per Homebridge launch, **only** when at least one of the three accessories does not already exist in the Homebridge accessory cache | Cheap LowDB JSON read (docs/POD-API.md, `GET|POST /api/settings`). Read-only; nothing in this change ever issues `POST /api/settings`, `POST /api/schedules`, or any other write, so no scheduled-job rebuild is ever triggered by this change. |

If the Pod is unreachable (or the read times out/errors) at that one startup moment, the
side accessories fall back to static display names (`Pod Left` / `Pod Right`) rather than
retrying or blocking Homebridge startup indefinitely — see design.md's timeout budget.

## Capabilities

### New Capabilities

- `platform`: the `DynamicPlatformPlugin` lifecycle — accessory topology (three bridged
  accessories: `Pod Left`, `Pod Right`, `Pod` hub), stable UUID/SerialNumber derivation
  from the configured host, `configureAccessory` restore with prune-on-restore, unregistering
  the unused side when `sides !== 'both'`, one-time display-name seeding, and the
  bail-without-host startup guard.
- `config`: the zod schema, defaults, and normalization for the platform config block, plus
  `config.schema.json`'s shape for the Homebridge UI — which keys are consumed by this
  change vs. reserved for a later one.

### Modified Capabilities

None. `pod-client` (in-flight) gains a consumer but no new requirement: this change calls
only `PodClient.getSettings()`, a method that change's own spec already covers.

## Impact

- **Files added**: `src/platform.ts`, `src/index.ts`, `src/config.ts`, `config.schema.json`,
  `test/platform.test.ts`, `test/config.test.ts`, plus a small test-only fake of the
  Homebridge `API` surface (design.md decides its exact shape and location).
- **Files modified**: `package.json` (`main` already points at `dist/index.js`; add the
  `"platform"` entry point wiring if `homebridge` expects a `main` export — no dependency
  changes beyond what `pod-client` already promotes `zod` to; see design.md's coordination
  note).
- **Dependencies**: none new. `homebridge` and `@homebridge/hap-nodejs` are already
  devDependencies (test-only for the latter, per docs/HOMEKIT.md); `zod` is already a
  dependency of `src/config.ts` in the same way `pod-client` needs it promoted from
  devDependency — both changes touch that line in `package.json` (see design.md).
- **Coordination**: this change assumes `pod-client`'s `src/pod/types.ts` and
  `src/pod/client.ts` exist (ADR-0002 lists `pod-client` as a dependency of
  `platform-foundation` "for types"). It runs in parallel with `poller-and-write-queue`,
  which depends on the same prerequisite; neither touches the other's files.
- **Systems**: no Pod is contacted by the test suite — the fake `API` and a fake
  `PodClient` stand in for both Homebridge and the network. The one thing this change
  cannot verify without a real paired device is called out in design.md.
