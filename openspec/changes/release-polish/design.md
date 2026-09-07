## Context

See proposal.md - Why, for the two problems this addresses (indistinguishable service tiles,
#49; stale docs, #21/#22). This design covers only the code part (#49) — the docs part (#21,
#22) is straightforward rewriting against the truth sources already read (`src/config.ts`,
`config.schema.json`, `openspec/specs/`, the issues' own comments) and needs no design decisions
beyond what tasks.md enumerates.

**Current naming state** (read from source, not assumed): every service already passes a
distinct string as its HAP `Name` (the constructor's second argument), but the conventions
disagree with each other:

- `ThermostatService` (`src/services/thermostat.ts:91`): `accessory.displayName` verbatim, no
  suffix.
- `AlarmService`'s press switch (`src/services/alarm.ts:86`): `` `${accessory.displayName} Alarm` ``.
- `OccupancyService` (`src/services/occupancy.ts:76`): `` `${accessory.displayName} Occupancy` ``.
- `AwayModeService`, `TestAlarmService`, `SkipAlarmService` (`src/services/awayMode.ts:52`,
  `src/services/testAlarm.ts:50`, `src/services/skipAlarm.ts:80`): a `Record<Side, string>`
  hardcoding `'Left'`/`'Right'` directly (e.g. `'Away Mode Left'`), independent of the accessory's
  actual (possibly Pod-derived, possibly renamed) display name.
- `ConnectionService`, `LedService`, `PrimeService`, `WaterLowService`, `ServerFaultService`
  (all hub-only, one hub accessory whose `nameFor('hub', …)` is always the literal `'Pod'` —
  `src/platform.ts:692`): a plain exported constant, e.g. `POD_CONNECTION_NAME = 'Pod Connection'`.

None of this matters for what a paired iOS ≥16 Home app actually shows as a tile's label, which
is the bug #49 exists to fix (confirmed against the installed `@homebridge/hap-nodejs@2.2.2`):

- iOS ≥16 derives each service tile's label on a bridged, multi-service accessory from
  `ConfiguredName` if present, and otherwise effectively falls back to one label shared by every
  tile on that accessory — so today, every tile under a side accessory (thermostat, alarm press,
  dismiss, occupancy, away mode, skip alarm) shows that side's single accessory name (e.g.
  "Casey"), and every hub tile shows "Pod". The `Name` characteristic values above are real and
  correctly distinct, but invisible to this rendering path.
- None of the HAP service types this plugin uses — `Thermostat`, `Switch`, `Lightbulb`,
  `ContactSensor`, `LeakSensor`, `OccupancySensor`, `StatelessProgrammableSwitch` — declare
  `ConfiguredName` as a required or optional characteristic in the installed HAP-NodeJS version
  (`node_modules/@homebridge/hap-nodejs/dist/lib/definitions/ServiceDefinitions.js`: only
  `AccessoryInformation` (optional), `SmartSpeaker` (optional), and `InputSource`/`Television`/
  `WiFiRouter` (required) wire it — none of ours). So it must be added explicitly.

## Goals / Non-Goals

**Goals:**
- Every service on every accessory gets a `ConfiguredName`, seeded once at construction, from a
  single unified per-service naming convention.
- The seeding is idempotent and never clobbers a controller (Home app) rename, on this or any
  later restart.
- No `characteristic-warning` log spam on any restart, ever (steady state or immediately after
  upgrade).
- The migration onto Casey's already-paired install is understood and stated plainly, including
  what a real device cannot confirm ahead of time.

**Non-Goals:**
- Changing the `Name` characteristic's own values. They stay as they are — `ConfiguredName` is
  additive, and unifying the naming convention only changes what feeds `ConfiguredName`'s *seed*
  value (see Decision 3), not the pre-existing `Name` constructor arguments, which nothing reads
  for tile-label purposes and which changing would have zero user-visible effect while adding
  needless diff.
- A config option to customize default labels (proposal.md - Non-goals).
- Anything to do with `AccessoryInformation`'s own `Name`/`Model`/`SerialNumber` — untouched.

## Decisions

### Decision 1: Detect "already seeded" via `service.testCharacteristic`, not `accessory.context`

Issue #49's own comment assumed a `context`-seeded pattern "same as `TemperatureDisplayUnits`"
(`src/services/thermostat.ts`, `docs/HOMEKIT.md`'s "`TemperatureDisplayUnits`" section). Checked
against the installed HAP-NodeJS and Homebridge source, that assumption does not fit
`ConfiguredName` and a plain `accessory.context` flag would be the wrong mechanism:

- `TemperatureDisplayUnits` needs `context` because the service wires an explicit `onGet` for
  every one of its five characteristics (`wireReads()`), and `onGet` is the only thing HAP-NodeJS
  ever calls to answer a read — there is no "return whatever `.value` already holds" default path
  once a service registers `onGet` for a characteristic. `context` is therefore the *only* place
  to remember a seeded-then-controller-writable value across restarts for a characteristic this
  plugin actively reads back.
- `ConfiguredName` is never read by this plugin's own code — nothing computes from it, so it never
  needs an `onGet`. Left with no `onGet`, HAP-NodeJS's `Characteristic` answers a read with
  whatever its own `.value` field holds, and that field round-trips through Homebridge's own
  cache file already: `PlatformAccessory.serialize`/`deserialize`
  (`node_modules/homebridge/dist/platformAccessory.js:84-109`) calls hap-nodejs's
  `Accessory.serialize`/`deserialize`, which serializes every service's `characteristics` array —
  each entry including its current `value` — via `Service.serialize`/`deserialize`
  (`node_modules/@homebridge/hap-nodejs/dist/lib/Service.js:721-756`), and Homebridge writes that
  exact structure to and from the `cachedAccessories` file
  (`node_modules/homebridge/dist/bridgeService.js:227-228` on load, `:349` on save). Once
  `ConfiguredName` is added as a real (non-optional-list) characteristic on a service, its value —
  our seeded default, or a controller's rename — persists across every future restart through this
  path alone, with zero plugin-side bookkeeping.
- The idempotent seed check is therefore: `service.testCharacteristic(hap.Characteristic.
  ConfiguredName)`. `false` (never added before, including "upgrading a pre-#49 paired install" —
  see Migration Plan) → add and seed once. `true` (already added, on any earlier run of this or an
  older plugin version, at its seeded default or a controller's rename) → touch nothing.

  ```ts
  if (!this.service.testCharacteristic(hap.Characteristic.ConfiguredName)) {
    this.service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
    this.service.setCharacteristic(hap.Characteristic.ConfiguredName, label);
  }
  ```

  `addOptionalCharacteristic` (`Service.js:526-533`) only appends to the in-memory
  `optionalCharacteristics` list HAP-NodeJS's own `getCharacteristic` fallback consults — it must
  run before `setCharacteristic`/`getCharacteristic` is asked for a characteristic type the
  service class doesn't declare, or that fallback (`Service.js:472-499`) adds the characteristic
  anyway but also calls `emitCharacteristicWarningEvent(..., "Characteristic not in required or
  optional characteristic section for service " + …, "Adding anyway.")` — the exact
  `characteristic-warning` log spam #49 flags as a known trap. Gating the whole block on
  `testCharacteristic` means that call only ever happens once per service, ever.

  **Alternative considered**: seed via `accessory.context`, mirroring `TemperatureDisplayUnits`
  exactly. Rejected — it would be a second, redundant source of truth (our own context flag next
  to HAP's own persisted characteristic value) that the *controller's* renames don't write through
  at all (a Home app rename updates the characteristic directly via HAP, never our `context`), so
  a context-based "already seeded" flag would still need to special-case "but don't stomp a value
  I can't see" — strictly worse than reading the one source (`testCharacteristic`) that already
  reflects both cases correctly.

  **Needs confirmation on a real paired device** (per this project's design-doc convention):
  everything above is traced through the installed HAP-NodeJS/Homebridge source, but whether the
  Home app's own rename UI actually issues a `ConfiguredName` write for each of these seven
  service types in practice — not just per the HAP spec — can only be confirmed by renaming a
  tile on Casey's paired install after this ships and confirming the value survives a plugin
  restart.

### Decision 2: `setCharacteristic`/`addOptionalCharacteristic` calls live in each service's own constructor, not a shared helper that touches every service from one place

Each `src/services/*.ts` file already owns its own service construction (`existing ?? accessory.
addService(new hap.Service.X(...))` followed by any `setProps` calls, per the existing convention
`docs/HOMEKIT.md`'s Homebridge-2.x-notes section already states: "always call `setProps` during
accessory construction, never conditionally later"). `ConfiguredName` seeding is the same shape of
one-time, construction-only HAP call, so it is added at the same call site, immediately after
`addService`/`getServiceById`, in every service file. A shared naming-convention module (Decision
3) supplies the *label string*; nothing about *when or how* to add the characteristic is shared
beyond that, matching how `setProps` is already handled per-service rather than centrally.

**Alternative considered**: one function in `src/platform.ts` that walks every accessory's
services after `constructServicesFor` returns and seeds `ConfiguredName` on all of them generically
by inspecting `service.characteristics`. Rejected — it would need its own separate mapping from
service+subtype to a label anyway (the whole point of Decision 3), duplicating rather than
centralizing, while also acting on services from outside the file that owns their construction
and their existing `setProps`-at-construction convention.

### Decision 3: Unified label convention

A small shared module (e.g. `src/services/serviceName.ts`) exports the per-service label
convention, used both as the pre-existing `Name` constructor argument (unchanged values, per the
Non-Goals above — this module documents the convention, it does not need to replace the existing
literals) and as the new `ConfiguredName` seed:

- **Side-accessory sub-services** (thermostat, alarm press, dismiss alarm, occupancy, away mode,
  skip next alarm): `` `${accessory.displayName} <Service Label>` `` — e.g. "Casey Thermostat",
  "Casey Alarm", "Casey Dismiss Alarm", "Casey Occupancy", "Casey Away Mode", "Casey Skip Next
  Alarm". This generalizes the pattern `OccupancyService` and the alarm-press switch already use,
  and replaces `AwayModeService`/`TestAlarmService`/`SkipAlarmService`'s hardcoded
  `'Left'`/`'Right'` strings with the accessory's actual (possibly Pod-derived, possibly renamed
  post-#21-caveat) display name — so a household that renamed a side accessory itself (e.g.
  "Casey" → "Guest Room") gets that name reflected in every sub-service's default label too,
  consistent with how the accessory-level display name already works
  (`openspec/specs/platform/spec.md`'s existing "Display names are seeded once…" requirement).
  `ThermostatService` changes from bare `accessory.displayName` to `` `${accessory.displayName}
  Thermostat` `` for its `ConfiguredName` seed specifically — its `Name` characteristic argument is
  left as-is per the Non-Goals above, since nothing reads it.
- **Hub sub-services**: keep the existing plain constants (`POD_CONNECTION_NAME`, `POD_LED_NAME`,
  `POD_PRIME_NAME`, `POD_WATER_LOW_NAME`, `POD_SERVER_FAULT_NAME`, the `TEST_ALARM_NAMES` per-side
  pair) verbatim as the `ConfiguredName` seed too. The hub accessory's display name is always the
  literal `'Pod'` (`src/platform.ts:692`), so `` `${accessory.displayName} <label>` `` would just
  re-derive "Pod Connection" etc. — identical to the existing constant — for every hub service
  except the two `TEST_ALARM_NAMES` entries, which are already fully-formed ("Test Alarm Left" /
  "Test Alarm Right") and would double up awkwardly as "Pod Test Alarm Left". Using the constants
  directly avoids that special case entirely.

## Risks / Trade-offs

- **[Risk] The characteristic-set change bumps the HAP configuration number on every accessory,
  on the very next release** → **Mitigation**: this is expected, one-time, and self-healing (see
  Migration Plan) — not a risk to design around, just to state honestly to the tech lead and to
  Casey before shipping to the paired install.
- **[Risk] A service class this design doesn't enumerate gets added later and its author forgets
  the `ConfiguredName` seed** → **Mitigation**: tasks.md includes a lint-free but human-checkable
  invariant (every `src/services/*.ts` file gets the same three-line block at its construction
  site); no automated enforcement is proposed here, since HAP-NodeJS gives no way to make a
  missing optional characteristic a compile-time or lint-time error, and adding one is out of
  scope for a docs-and-one-behavior-fix release.
- **[Risk] `testCharacteristic` false-negatives if a future HAP-NodeJS upgrade changes how
  `ConfiguredName` is (de)serialized** → **Mitigation**: none needed beyond ordinary regression
  testing on upgrade; noted so a future `@homebridge/hap-nodejs` bump doesn't silently reintroduce
  the clobber-on-restart bug this design avoids.

## Migration Plan

Applies to any already-paired install, most concretely Casey's own (`docs/ROADMAP.md`'s M5, and
the repo's stated production use). Steps, traced through the citations in Decision 1:

1. Homebridge restarts on the release carrying this change.
2. `bridgeService.js` loads `cachedAccessories`, deserializing every previously-published
   accessory/service/characteristic — including each service's current `characteristics` array,
   which does **not** yet contain `ConfiguredName` for any service (it has never been added by any
   prior plugin version).
3. The platform's existing accessory-restore path finds each accessory already present by UUID
   (`openspec/specs/platform/spec.md`'s "Existing accessory is never renamed" scenario — unaffected
   by this change) and calls each service's constructor exactly as it does on any other restart,
   via `existing ?? accessory.addService(...)` — `existing` resolves to the deserialized service
   instance already on the accessory.
4. Inside each constructor, `testCharacteristic(ConfiguredName)` is `false` for every service (this
   is the first run of code that ever adds it), so every service gets `ConfiguredName` added and
   seeded to its Decision-3 default in this one restart.
5. Each `addCharacteristic` call (inside `addOptionalCharacteristic` + `setCharacteristic`'s
   underlying `getCharacteristic(...).setValue(...)` path) emits `service-configurationChange`
   (`Service.js:414`), which the accessory forwards, and which a `Bridge`'s listener turns into
   `enqueueConfigurationUpdate` (`Accessory.js:379-380`) — the standard HAP-NodeJS path for
   bumping the accessory database's configuration number and re-advertising over mDNS. Every
   already-paired controller (the Home app, any other HomeKit hub) picks this up as a normal
   "accessory database changed, re-fetch it" event — the same class of event any other plugin
   update that adds a characteristic would trigger, not something special to this change.
6. On that re-fetch, every tile that previously showed the shared fallback label now shows its own
   distinct seeded default. **Nothing that was true about existing customizations changes**:
   before this release, a user-visible "rename" of a tile in the Home app had no HAP characteristic
   to write to at all for these service types (`ConfiguredName` did not exist on them), so any
   apparent per-tile customization a user believes they made was necessarily Apple's own
   client-side-only naming layer, not something this plugin could see or could now be clobbering —
   there is no prior plugin-visible rename state to lose. From this release forward, a rename
   written through the Home app's UI does write `ConfiguredName`, and Decision 1's guard is what
   keeps it from being overwritten by the next restart's seed step.
7. **Rollback**: reverting to a pre-#49 plugin version is safe — the now-added `ConfiguredName`
   characteristics simply stop being written to by this plugin (nothing else in the codebase reads
   or depends on them) and remain in `cachedAccessories`, inert, until a future upgrade re-adds
   this code path; no data migration or cleanup step is needed either direction.

**Needs confirmation on a real paired device**: steps 5–6's controller-side behavior (that the
Home app actually re-fetches and shows the new distinct labels promptly, with no lingering
duplicate or stale tile) can only be confirmed by watching Casey's paired install through an
actual update — flagged here for the tech lead, consistent with `docs/POD-API.md`/`docs/
HOMEKIT.md`'s existing practice of marking HAP behavior that only a real controller can confirm.

## Resolutions (tech lead, 2026-09-07)

1. **Decision 1 ratified, including the correction to issue #49's stated plan** (HAP-native
   persistence via serialize/deserialize; no accessory.context bookkeeping). Binding detail:
   on a RESTORED service, seed only when the characteristic is absent — an existing
   ConfiguredName (user rename or prior seed) is never overwritten; encode that as an
   explicit test (restore with a renamed value → untouched).
2. **Migration story accepted**; task 3.4's real-device confirmation goes to Casey's paired
   install post-merge (note in the PR + final report, not a blocker).
3. **Decision 3 OVERRIDDEN: short labels everywhere, no accessory-name prefix.** Apple's
   service-naming guidance and the Home app's own scoping make "Pod Left Away Mode" tiles
   redundant and Siri-hostile; ConfiguredName defaults are "Away Mode", "Skip Next Alarm",
   "Dismiss Alarm", "Test Alarm", "Prime", "LED", "Pod Connection", "Water Level",
   "Occupancy", etc. Uniqueness matters within an accessory, not globally. Existing Name
   characteristic values stay as they are unless a task already touches them.
