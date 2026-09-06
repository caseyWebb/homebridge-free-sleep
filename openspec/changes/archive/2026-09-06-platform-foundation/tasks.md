Prerequisite: `pod-client` must be merged first — this change's name-seeding path calls
`PodClient.getSettings()` and imports its return type from `src/pod/types.ts` (ADR-0002:
`platform-foundation` depends on `pod-client` "for types"; design.md's Context). Everything
else in this change is independent of `pod-client`'s internals and only needs its public
shape to hold.

Every verification below runs offline, with no Pod and no paired Home app, using the fake
Homebridge `API` and fake `PodClient` from design.md. The tasks that require a real Pod or a
real paired device are grouped in section 8 and are explicitly **not** blockers for this
change, matching the pattern `pod-client`'s tasks.md established.

## 1. Config schema (`src/config.ts`)

- [x] 1.1 Define the zod schema with `host` required/non-empty and `sides` as
  `z.enum(['both', 'left', 'right']).default('both')`; verify with unit tests covering the
  config spec's "host is required" and "sides defaults/rejects" scenarios (missing host,
  non-string host, empty host, each valid `sides` value, an invalid `sides` value, omitted
  `sides`).
- [x] 1.2 Define the seven reserved keys (`pollIntervals`, `writeSettleMs`,
  `noResponseAfterMs`, `occupancySource`, `waterLowSensorType`, `keepAlive`,
  `awayModeWritePolicy`) with the defaults from design.md's consumed-vs-reserved table;
  verify with a unit test that parsing a config with only `host` yields a fully-defaulted
  object with no `undefined` among these seven keys.
- [x] 1.3 Add per-key range/enum constraints on the reserved keys (e.g. `writeSettleMs` a
  non-negative integer, `occupancySource` one of `'none' | 'presence' | 'vitals'`,
  `waterLowSensorType` one of `'contact' | 'leak'`, `awayModeWritePolicy` one of
  `'mirror' | 'block'`); verify with a unit test per key that an out-of-range or wrong-enum
  value fails validation naming that key, and that a valid non-default value for each key
  parses through unchanged.
- [x] 1.4 Export `z.infer` types for the parsed config; verify `npm run typecheck` exits 0.
- [x] 1.5 Add a normalization step for `host` (trim whitespace); verify with a unit test that
  `"  10.0.0.5  "` parses to `"10.0.0.5"`.

## 2. Homebridge UI schema (`config.schema.json`)

- [x] 2.1 Create `config.schema.json` with `pluginAlias: "FreeSleep"` (matching
  `PLATFORM_NAME` in `src/settings.ts`) and a form field for every key `src/config.ts`
  defines, with matching type and default; verify by reading it back against `src/config.ts`
  key-by-key.
- [x] 2.2 Add a unit test that loads both `config.schema.json` and the zod schema's shape
  and asserts the two key sets are identical (config spec's "UI form exposes exactly the
  schema's keys" requirement, both directions); verify the test fails if a key is added to
  one file but not the other (temporarily add one to confirm, then remove it).
- [x] 2.3 Add a unit test asserting `config.schema.json`'s `pluginAlias` equals the exported
  `PLATFORM_NAME`; verify it fails if the two are made to differ (temporarily edit one to
  confirm, then revert).

## 3. Fake Homebridge API test harness (`test/fakeHomebridgeApi.ts`)

- [x] 3.1 Implement a fake `API` exposing `hap` (the real `@homebridge/hap-nodejs` `uuid`,
  `Categories`, `Service`, `Characteristic`), `platformAccessory(name, uuid, category)`
  constructing a real hap-nodejs `PlatformAccessory`, `on(event, cb)` recording listeners,
  and spy arrays for `registerPlatformAccessories`, `updatePlatformAccessories`, and
  `unregisterPlatformAccessories`; verify with a smoke test that constructing the fake, then
  manually firing a recorded `'didFinishLaunching'` listener, executes without error.
- [x] 3.2 Implement `simulateRestart(platformFactory, previousAccessories)`: constructs a
  fresh platform, feeds each of `previousAccessories` through `configureAccessory`, then
  fires `didFinishLaunching`; verify with a test that a platform restarted with an empty
  `previousAccessories` list ends with the spy `registerPlatformAccessories` array
  containing new accessories, and a platform restarted with a full set of previously-created
  accessories ends with an empty `registerPlatformAccessories` array.
- [x] 3.3 Implement a fake `PodClient` exposing `getSettings()` as a resolved, rejected, or
  never-resolving promise, selectable per test; verify with a test that each of the three
  modes behaves as configured within a bounded test timeout (use vitest fake timers for the
  never-resolving case rather than a real multi-second wait).

## 4. Accessory identity (`src/platform.ts`)

- [x] 4.1 Implement `seed(host, role)`, `uuid(host, role)`, and `serialNumber(host, role)`
  exactly as design.md specifies; verify with unit tests that the same `host`+`role` always
  yields the same UUID and `SerialNumber` across two calls, that different `role`s for the
  same `host` yield different UUIDs, and that different `host`s for the same `role` yield
  different UUIDs and different `SerialNumber`s.
- [x] 4.2 Set `AccessoryInformation` (`Manufacturer`, `Model`, `SerialNumber`,
  `FirmwareRevision`) per design.md's table on every newly-created accessory; verify with a
  unit test reading back each characteristic's value from a freshly-created fake accessory.
- [x] 4.3 Set `Categories.THERMOSTAT` for side accessories and `Categories.OTHER` for the
  hub at construction; verify with a unit test inspecting the `category` argument passed to
  the fake `platformAccessory` factory for each of the three accessories.

## 5. Platform lifecycle (`src/platform.ts`)

- [x] 5.1 Implement the constructor's config parse and bail-without-host guard: on parse
  failure or missing `host`, log an error and do not register an `api.on('didFinishLaunching', …)`
  listener; verify with a unit test that constructing the platform with no `host` results in
  zero listeners recorded on the fake `API`, and zero calls to any of the three
  register/unregister spies even when `configureAccessory` was called first with cached
  accessories.
- [x] 5.2 Implement `configureAccessory` collecting cached accessories by UUID; verify with
  a unit test that calling it with a fake cached accessory makes that accessory retrievable
  by the platform's internal lookup before `didFinishLaunching` fires.
- [x] 5.3 Implement the `sides: 'both'` fresh-install path: compute the three wanted
  accessories, create and register all three when none are cached; verify with
  `simulateRestart` (empty previous accessories) that exactly three accessories appear in
  the `registerPlatformAccessories` spy call, named `Pod Left`, `Pod Right`, `Pod`, each with
  only an `AccessoryInformation` service.
- [x] 5.4 Implement restart-without-duplication: when all wanted accessories are already
  cached, register nothing new and unregister nothing; verify with `simulateRestart` seeded
  with all three previously-created accessories that both the register and unregister spies
  end empty, and the platform's resulting accessory set has the same three UUIDs as the
  input.
- [x] 5.5 Implement prune-on-restore: remove any service on a cached accessory whose
  `(UUID, subtype)` is not in the accessory's current enabled set, leaving
  `AccessoryInformation` and other still-enabled services untouched; verify with a unit test
  that injects a synthetic extra service (arbitrary UUID + subtype) onto a fake cached
  accessory before `simulateRestart`, and asserts it is gone afterward while
  `AccessoryInformation` remains.
- [x] 5.6 Implement the `sides` filter and unregistration of the excluded side; verify with
  three unit tests: `sides: 'left'` on a fresh install registers only `Pod Left` + `Pod`;
  `sides: 'right'` registers only `Pod Right` + `Pod`; and a platform previously run with
  `sides: 'both'` (so `Pod Right` is cached) restarted with `sides: 'left'` unregisters
  exactly `Pod Right` and, on a further restart still at `sides: 'left'`, registers and
  unregisters nothing further.

## 6. Name seeding

- [x] 6.1 Implement the `needsSettings` guard (true only when at least one side accessory
  being created is not already cached) and skip the settings call entirely otherwise; verify
  with a unit test that `simulateRestart` with all accessories already cached results in zero
  calls to the fake `PodClient.getSettings`.
- [x] 6.2 Implement seeding a new side accessory's display name from
  `settings[side].name` when the settings read resolves before the accessory must be
  registered; verify with a unit test using a fake `PodClient` resolving with a fixture
  settings object that the newly-created `Pod Left`/`Pod Right` accessory's `displayName`
  matches `settings.left.name`/`settings.right.name`.
- [x] 6.3 Implement the fallback name path when the settings read rejects, errors, or does
  not resolve before registration; verify with a unit test using a fake `PodClient` that
  rejects (and a separate test where it never resolves, using fake timers) that the new
  accessory's `displayName` is the static fallback (`Pod Left` / `Pod Right`) and that
  `didFinishLaunching`'s handling still completes (does not hang) within the test's bounded
  time.
- [x] 6.4 Implement never-rename-on-restore: an already-cached accessory's `displayName` is
  left untouched regardless of what a settings read (if one happens for another reason)
  returns; verify with a unit test that seeds a cached accessory with a display name that
  deliberately differs from a fixture settings name, runs `simulateRestart`, and asserts the
  display name is unchanged.

## 7. Registration entry point (`src/index.ts`)

- [x] 7.1 Implement `src/index.ts` calling `api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME,
  FreeSleepPlatform)`; verify with a unit test using a minimal fake `api.registerPlatform`
  spy that it is called with those exact two name arguments and the platform class.
- [x] 7.2 Confirm `package.json`'s `main` (`dist/index.js`) resolves to this module after a
  build; verify `npm run build && node -e "require('./dist/index.js')"` does not throw
  (a bare `require` will not call `registerPlatform` meaningfully without a Homebridge host,
  but it proves the built module loads and its imports resolve).

## 8. Acceptance and hardware verification

- [x] 8.1 Full gate: verify `npm run lint`, `npm run typecheck`, `npm test`, and
  `npm run build` all exit 0.
- [x] 8.2 Confirm no test contacts a real Pod or a real Homebridge process: verify the whole
  suite passes with networking disabled, and by grepping `test/platform.test.ts` and
  `test/config.test.ts` for `fetch(` / `http.request` / `homebridge` CLI invocation, expecting
  none outside the fake `PodClient` and fake `API`.
- [ ] 8.3 **Hardware/paired-app, non-blocking:** pair a real Homebridge instance running this
  plugin (built from this change) with the Home app against a real or simulated Pod host;
  verify all three accessories (`Pod Left`, `Pod Right`, `Pod`) appear, each showing only
  generic accessory information with no error tile or "Not Supported" placeholder, and note
  the result on issue #7.
- [ ] 8.4 **Hardware/paired-app, non-blocking:** restart that same Homebridge instance without
  changing config; verify in the Home app and in `cachedAccessories.json` that no accessory
  duplicates, and note the result on issue #7 (this is the change's literal "Done when"
  acceptance line).
- [ ] 8.5 **Hardware/paired-app, non-blocking:** with the plugin paired, change `sides` from
  `'both'` to `'left'` and restart; verify `Pod Right` disappears from the Home app rather
  than lingering as an unreachable tile.
- [ ] 8.6 **Hardware/paired-app, non-blocking:** remove `host` from `config.json` and start
  Homebridge; verify in the Homebridge log that the plugin logs its clear "not configured"
  error and does not crash the bridge or throw an unhandled exception, satisfying the
  verified-plugin "installs and does not start until configured" requirement.
- [ ] 8.7 **Hardware/paired-app, non-blocking:** open the Homebridge UI's config editor for
  this plugin; verify `host` is presented as required (the UI blocks saving without it) and
  the `sides` field renders as a bounded choice rather than free text, and note any rendering
  issue against design.md's Open Questions.
- [ ] 8.8 **Hardware, non-blocking:** run the one-time settings read against a real Pod (or a
  real Pod that is deliberately powered off/unreachable at that moment) on a fresh pairing;
  verify the seeded name matches `GET /api/settings`'s `<side>.name` in the reachable case,
  and that startup still completes within a reasonable time in the unreachable case.
