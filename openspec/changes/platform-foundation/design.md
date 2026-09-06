## Context

See proposal.md — Why. This is the first change to touch the plugin's HomeKit surface;
everything under `src/` today is `src/settings.ts` (`PLUGIN_NAME`, `PLATFORM_NAME`) plus
whatever `pod-client` (in-flight, per ADR-0002 a dependency of this change "for types") adds
under `src/pod/`. `homebridge` and `@homebridge/hap-nodejs` are already devDependencies
(`tooling-and-ci`, merged as `3857fd2`); per docs/HOMEKIT.md, `@homebridge/hap-nodejs` stays
devDependency-only — the plugin imports HAP **types** from `homebridge` and gets runtime
enums/classes from `api.hap`, never from `@homebridge/hap-nodejs` at runtime.

The one Pod-behavior claim in this design: `GET /api/settings` is a cheap, unauthenticated
LowDB read — `res.json(settingsDB.data)` with no `safeParse`
(`server/src/routes/settings/settings.ts`) — and its per-side `name` field is defined in
`server/src/db/settingsSchema.ts`. Both paths are already cited in docs/POD-API.md and in
`pod-client`'s design.md; repeated here because this change's one settings read at startup
depends on that cost characterization. Nothing else here makes a claim about Pod behavior:
this change never calls `GET /api/deviceStatus`, never writes anything, and never touches
`awayMode`, the 12-hour duration, or the daily reboot — those constraints matter to *later*
changes, not this one.

## Goals / Non-Goals

**Goals:**

- Lock the accessory topology, identity derivation, and restore/prune mechanics *now*, so
  `thermostat-and-offline` only has to add services to accessories that already exist,
  restore, and prune correctly — never revisit identity or restore logic.
- Make the platform's startup behavior (bail-without-host, restore, prune, sides,
  name-seeding) fully unit-testable against a fake Homebridge `API`, with zero dependency on
  a real Homebridge process, a real Pod, or a paired Home app.
- Keep `config.ts` the single source of truth for every key the tech lead has fixed for the
  eventual feature set, so no later change adds a new top-level config key.

**Non-Goals:**

- Anything that requires a real Pod connection beyond one best-effort `GET /api/settings`
  read at startup (see proposal.md's Non-goals — no polling, no `PodPoller`, no write path).
- Any decision about *how* a later change models a reserved config key's behavior (e.g. what
  `awayModeWritePolicy`'s values do). This change only fixes the key's name, type, and
  default; the behavior is `poller-and-write-queue`'s or `thermostat-and-offline`'s to design.
- Validating `config.schema.json` and `src/config.ts` never drift via a generated artifact.
  They are hand-kept in sync in this change; a generator is out of scope (see Risks).

## Decisions

### Two capabilities, split along the same line as `pod-client`/`pod-test-double`

`platform` (Homebridge lifecycle, accessory identity, restore/prune) and `config` (the zod
schema and the UI form it drives) are separable contracts with separable test strategies:
`config` is pure data validation, testable with no Homebridge API surface at all; `platform`
needs the fake `API` described below. Splitting them mirrors `pod-client`'s
`pod-client`/`pod-test-double` split — one contract *consumed by* the other, not folded
into it.

### Identity: UUID and SerialNumber, both string-keyed off `host` + role

```
seed(host, role)      = `${PLUGIN_NAME}:${host}:${role}`     // role: 'left' | 'right' | 'hub'
uuid(host, role)       = api.hap.uuid.generate(seed(host, role))
serialNumber(host, role) = `${host}:${role}`
```

- **`PLUGIN_NAME`**, not `PLATFORM_NAME`, prefixes the UUID seed. `PLUGIN_NAME` is the npm
  package name (`src/settings.ts`) and is what actually disambiguates this plugin's UUIDs
  from another plugin's, should two plugins ever hash a similar string; `PLATFORM_NAME` only
  disambiguates platforms *within* this plugin, which the `role` segment already does.
- **`SerialNumber` is human-readable (`host:role`), not the UUID.** `api.hap.uuid.generate`
  produces a UUID-v5-style hash with no reverse mapping; a support request that includes the
  `SerialNumber` shown in the Home app's accessory details is more useful to a maintainer as
  `192.168.1.50:left` than as an opaque hash. HAP's only requirement is that it stays stable
  for the accessory's lifetime, which a pure function of `host` and `role` satisfies.
- **Never derived from anything the Pod reports or the OS resolves.** No MAC address, no
  resolved IP, no `coverVersion`/`hubVersion` (which would also require the `GET
  /api/deviceStatus` round-trip this change deliberately avoids). Changing the configured
  `host` string is the only thing that changes identity — documented in the spec as
  intentional, not a bug, since a different `host` plausibly means a different physical Pod.
- **Alternative considered**: seed on `sides`-relative position ("first configured side")
  instead of a fixed `'left'`/`'right'` role. Rejected — it would make identity depend on
  the *order* accessories are enumerated in config rather than a fixed semantic role, which
  is a subtler and strictly worse stability property.

### AccessoryInformation fields

| Field | Value | Why |
|---|---|---|
| `Manufacturer` | `"Eight Sleep"` | Identifies the physical product family being bridged. |
| `Model` | `"Pod"` (sides), `"Pod Hub"` (hub) | Distinguishes the hub's future multi-service role (#20) from a side's future single-thermostat role, without overclaiming a specific hardware revision we cannot query without `GET /api/deviceStatus`. |
| `SerialNumber` | `host:role`, see above | Stable, unique, host-derived. |
| `FirmwareRevision` | this package's own `version` from `package.json` | We do not read `coverVersion`/`hubVersion` in this change (would need `GET /api/deviceStatus`); the plugin's own version is the only firmware-shaped value available without it, and is itself useful for support triage. |

### `Categories` chosen at creation, since it cannot change later without re-pairing

Side accessories are constructed with `api.hap.Categories.THERMOSTAT` — anticipating
docs/HOMEKIT.md's already-locked decision that each side's only service will be a
`Thermostat` — because **HAP category is fixed at `PlatformAccessory` construction** and,
per Apple's HomeKit Accessory Protocol behavior, changing it later requires the accessory to
be removed and re-added (re-paired) rather than updated in place. Choosing it correctly now,
before any real pairing happens, avoids a forced re-pair when `thermostat-and-offline`
lands.

The hub gets `Categories.OTHER`. `Categories.BRIDGE` is reserved for the platform's own
bridge accessory, not a child accessory a bridge publishes, so it is not an option here. The
hub is a child accessory with a mixed future service set (contact sensors, switches, a
lightbulb — see docs/HOMEKIT.md), none of which is primary yet, so unlike the side
accessories there is no single locked-in service to anticipate. `Categories.OTHER` is a
placeholder choice, not a derived one — **flagged for tech-lead review below**, and also
flagged as needing real-device confirmation — see "What needs a real paired device."

### Restore flow

```
constructor(log, config, api):
  parse config with the zod schema (throws → caught, logged, config invalid)
  if !config.host: log error, return without calling api.on(...)   // Requirement: bail without host
  api.on('didFinishLaunching', () => this.discoverAccessories())

configureAccessory(cached):                          // Homebridge calls this per cached
  this.cachedByUuid.set(cached.UUID, cached)          // accessory, before didFinishLaunching

discoverAccessories():
  wanted = plan()                                     // [{role, uuid, name}] for host+sides
  wantedUuids = new Set(wanted.map(w => w.uuid))

  // prune: unregister any cached accessory not in the wanted set (sides narrowed)
  toUnregister = [...cachedByUuid.values()].filter(a => !wantedUuids.has(a.UUID))
  if toUnregister.length: api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toUnregister)

  needsSettings = wanted.some(w => w.role !== 'hub' && !cachedByUuid.has(w.uuid))
  settings = needsSettings ? await tryReadSettings() : undefined   // one bounded attempt, see below

  for w of wanted:
    existing = cachedByUuid.get(w.uuid)
    if existing:
      pruneServices(existing, currentEnabledSubtypes)   // remove services no longer enabled
      accessory = existing
    else:
      name = w.role === 'hub' ? 'Pod'
           : settings?.[w.role]?.name ?? FALLBACK_NAME[w.role]
      accessory = new api.platformAccessory(name, w.uuid, categoryFor(w.role))
      setInfo(accessory, w)
      newAccessories.push(accessory)

  if newAccessories.length: api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories)
```

`pruneServices` walks `accessory.services`, and removes any service whose
`(service.UUID, service.subtype)` pair is not in the accessory's currently-enabled set —
`AccessoryInformation` (no subtype) is always enabled and so is never a candidate for
removal. After this change every accessory's enabled set is just
`{AccessoryInformation}`, so `pruneServices` is a no-op today; it exists now, exercised by a
unit test with a synthetic extra service injected into a fake cached accessory, so
`thermostat-and-offline` changes only the enabled-set table, never this function. Every
future service the platform ever adds gets an explicit unique `subtype` and is looked up
with `getServiceById(uuid, subtype)` on restore — never `getService(ServiceType)` — per
docs/HOMEKIT.md's Homebridge 2.x API notes; there is nothing to look up that way yet, but
the helper's contract is fixed now so it does not change shape later.

### One-time, best-effort settings read for name seeding

`tryReadSettings()` calls `podClient.getSettings()` exactly once per startup, and only when
`needsSettings` is true (guarding the "no settings read when nothing needs naming"
requirement). It is wrapped so any rejection (network error, timeout, parse error — the
typed errors `pod-client`'s spec defines) resolves to `undefined` rather than throwing out of
`discoverAccessories()`; a caught rejection is logged at `debug`, not `error`, because an
unreachable Pod at first boot is an expected state (docs/POD-API.md: "the Pod reboots daily;
connection loss is a normal state"), not a plugin defect.

**Timeout budget**: `pod-client`'s own per-attempt timeout (~8 s) plus one retry with
backoff bounds this at roughly 16.5 s worst case (`pod-client`'s design.md). That delay is
acceptable here specifically because it can only happen once, only on the very first launch
that ever creates a given accessory (typically: once, ever, per installation) — every
subsequent launch either has all accessories cached (no read at all) or is creating an
accessory that was newly added to config (`sides` widened), which is already a
user-initiated, attended action. This is *not* the recurring poll `poller-and-write-queue`
(#8) builds; reusing that budget here rather than inventing a shorter one keeps this change
free of a second timeout constant to tune.

### Consumed vs. reserved config keys

| Key | Default | Consumed this change? |
|---|---|---|
| `host` | *(required, none)* | **Yes** — gates startup, seeds identity. |
| `sides` | `'both'` | **Yes** — selects which accessories exist. |
| `pollIntervals` | `{}` (per-endpoint override object, all fields optional) | Reserved — `poller-and-write-queue` (#8) reads it. |
| `writeSettleMs` | `15000` | Reserved — the write queue's optimistic-overlay window; `poller-and-write-queue` (#10) owns it. (Corrected at reconcile of `thermostat-and-offline`, which reads only `noResponseAfterMs`; the original `500` conflated this with docs/HOMEKIT.md's anti-jitter window, which needs no config key in M2.) |
| `noResponseAfterMs` | `600000` (10 min) | Reserved — docs/HOMEKIT.md's No-Response escalation; `thermostat-and-offline` (#11) reads it. |
| `occupancySource` | `'none'` | Reserved — `'none' \| 'presence' \| 'vitals'`; #19 reads it. |
| `waterLowSensorType` | `'contact'` | Reserved — `'contact' \| 'leak'`; #20 reads it. |
| `keepAlive` | `true` | Reserved — #12 reads it. |
| `awayModeWritePolicy` | `'mirror'` | Reserved — `'mirror' \| 'block'`; #13 reads it, per the away-guard interaction noted in `pod-client`'s design.md Resolution 1. |

Every reserved key is nonetheless *live-validated* (config spec's "genuinely validated"
requirement) — a `z.object` per key, not `z.unknown()` — so a typo'd future config value
fails loudly today rather than silently once #8/#9/#12/#13/#19/#20 start reading it.

### Testability without a paired Home app

`test/fakeHomebridgeApi.ts` implements enough of the `API` interface (types imported from
`homebridge`, matching this repo's existing convention) to drive `FreeSleepPlatform`
end-to-end in `vitest`, using the **real** `@homebridge/hap-nodejs` underneath (already a
devDependency; never imported by `src/`):

- `hap`: the real `HAP` namespace (`uuid`, `Categories`, `Service`, `Characteristic`) from
  `@homebridge/hap-nodejs`, so `uuid.generate` and real `Service`/`Characteristic` behavior
  (including `setProps` validation) are exercised, not reimplemented.
- `platformAccessory(name, uuid, category)`: constructs a real hap-nodejs
  `PlatformAccessory`, so `.getServiceById`, `.addService`, `.removeService`, and
  `.context` all behave like production.
- `on(event, cb)`: records listeners; the test harness calls the recorded
  `'didFinishLaunching'` callback itself once cached accessories (if any) have been fed
  through `configureAccessory`, mirroring Homebridge's real call order.
- `registerPlatformAccessories` / `updatePlatformAccessories` /
  `unregisterPlatformAccessories`: push into inspectable arrays instead of touching disk —
  this is what tasks.md's restore/prune/sides tests assert against.
- A `simulateRestart(previousAccessories)` helper: builds a fresh platform instance, feeds
  `previousAccessories` through `configureAccessory` (as real Homebridge does before
  `didFinishLaunching`), then fires `didFinishLaunching` — this is how "restart without
  duplication" and "prune on restore" become one-line-setup unit tests.

`podClient` is a second fake — a hand-written object satisfying the subset of
`pod-client`'s public interface this change calls (`getSettings()`), returning a
resolved, rejected, or hung promise per test. It does not use `pod-client`'s own mock Pod
(`test/mockPod.ts`, HTTP-level) because nothing here needs real transport behavior — only
"the call resolved, rejected, or didn't finish before we had to move on."

### What needs a real paired device

Per this project's design rule, everything above is confirmable by unit test except:

- **Whether a bridged child accessory with only `AccessoryInformation` and no other service
  pairs and displays cleanly in the Home app**, rather than the "No Response" or "Not
  Supported" placeholder HOMEKIT.md documents for a custom Service with no HAP mapping.
  Nothing in this change is a custom Service, but an accessory with zero non-information
  services is untested territory for this project.
- **Whether `Categories.OTHER` for the hub renders acceptably** in the Home app's
  categorization (Sensors tab, Other, etc.) versus a different choice — a UX judgment, not
  a protocol fact.
- **Whether a HAP category chosen at creation truly requires re-pairing to change** in this
  Homebridge/HAP-NodeJS version specifically, for a bridged (non-standalone) accessory — a
  widely-documented HomeKit behavior, but not one this project has verified against its own
  bridge.
- **The real on-disk `cachedAccessories.json` restore path** through an actual Homebridge
  process restart. The fake API's `configureAccessory`/`didFinishLaunching` sequencing
  mirrors Homebridge's documented call order, but does not exercise Homebridge's own
  accessory (de)serialization, disk I/O, or restart timing.
- **The Homebridge UI's rendering of `config.schema.json`** — whether marking `host`
  required actually blocks saving an incomplete config in the UI, and whether the enum
  widget for `sides` and the reserved keys renders sensibly. `pod-client`'s hardware
  verification (#3) is unrelated and does not cover this.

## Risks / Trade-offs

- **`config.ts` and `config.schema.json` are hand-kept in sync, not generated from one
  source.** A future edit to one without the other silently breaks the "UI exposes exactly
  the schema's keys" requirement. → Mitigated by a same-change unit test (config spec's
  last requirement) that diffs the zod schema's keys against `config.schema.json`'s form
  keys; it fails loudly on any future drift, in either direction.
- **The one-time settings read adds up to ~16.5 s of startup latency the first time any
  side accessory is created.** → Scoped tightly (only fires when an accessory is actually
  being created for the first time, not on every restart) and justified above; if this
  proves disruptive in practice, a future change can shorten the timeout for this
  call specifically without changing the requirement itself.
- **Reusing `pod-client`'s timeout budget rather than a dedicated one** means a future
  change to that budget (e.g. #15's load-check follow-up) silently changes this change's
  worst-case startup latency too. → Acceptable: both are bounded by the same Pod-side
  constraint (`server/src/8sleep/frankenServer.ts`'s 10 s/25 s timeouts), so they should
  move together.
- **`Categories.OTHER` for the hub is a placeholder choice**, not derived from any fixed
  constraint the way `Categories.THERMOSTAT` is. → Flagged in Open Questions; cheap to
  revisit since category only affects Home app presentation, not identity or pairing data,
  as long as it is decided before the first real pairing (this change's hardware
  verification gap, above).
- **This change depends on `pod-client`'s `src/pod/types.ts` and `src/pod/client.ts`
  existing**, and `pod-client` is in-flight in a separate worktree (ADR-0002). → Only
  `getSettings()`'s shape is needed; if `pod-client` lands with a different method
  signature than assumed here, `tasks.md`'s task for the settings read is the one task that
  needs adjusting, not the design.

## Open Questions

These do not change the specs, the approach, or the task breakdown, and are flagged for
tech-lead review rather than guessed at:

1. **Hub accessory `Categories`**: this design picks `Categories.OTHER`. Is that the right
   choice given the hub's eventual mixed service set (contact sensors, switches, a
   lightbulb — docs/HOMEKIT.md)? An alternative worth considering: no explicit category
   (HAP's own default), if that renders equivalently.
2. **`Manufacturer: "Eight Sleep"`** — the accessory represents Eight Sleep's hardware, but
   the plugin is an unofficial, unauthenticated integration with the open-source `free-sleep`
   firmware, not an Eight Sleep product. Is attributing `Manufacturer` to Eight Sleep the
   right call, or should it instead read something that signals "free-sleep / this plugin"
   to avoid implying official support?
3. **Fallback display names** (`Pod Left` / `Pod Right`) exactly match the accessory names
   used when no seeding is possible — meaning an unreachable-at-first-boot install is
   indistinguishable, by name alone, from one that successfully seeded a Pod whose
   configured name happens to also be "Pod Left"/"Pod Right". Worth a distinct fallback
   (e.g. suffixing something), or is exact-name collision an acceptable non-issue?

### Resolutions (tech lead, 2026-09-06)

1. **`Categories.OTHER` stands** for the hub. The category only affects the default tile
   icon and cannot change without re-pairing; OTHER is the honest choice for a mixed
   sensor/switch accessory and matches how Home renders uncategorized bridges' extras.
2. **Keep `Manufacturer: "Eight Sleep"`.** AccessoryInformation describes the physical
   device, which is genuinely Eight Sleep hardware — that is factual, not a claim of
   official support. The unofficial-integration identity lives in the plugin name, README,
   and npm metadata. `Model` should carry `coverVersion` when a snapshot is available.
3. **Exact-name collision is an acceptable non-issue.** Names seed once at creation and
   users rename in the Home app freely; a distinguishing suffix would pollute the common
   case to disambiguate a rare, harmless one.
