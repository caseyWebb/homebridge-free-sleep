## Why

M5 (Release) is the last milestone before the repo goes public, and its three tracked issues are
all that stand between the current 0.3.0 and a release a stranger could install with confidence.
Two are cosmetic-but-real bugs in what a paired user actually sees, and one is process work with
the research already done:

- **#49**: every side accessory and the hub bundles multiple HAP services (thermostat, alarm
  press, dismiss, occupancy, away mode, skip alarm; connection, water-low, prime, LED, test alarm,
  server fault). On iOS ≥16 the Home app ignores each service's `Name` characteristic for its tile
  label on a bridged accessory and instead derives the label from the accessory's own name — so
  every tile under "Casey"'s side accessory currently displays the single label "Casey", and every
  hub tile displays "Pod", indistinguishable from one another. The fix (`ConfiguredName`,
  code-verified against the installed `@homebridge/hap-nodejs` 2.2.2) is well understood; it has
  not been built.
- **#21**: README.md, docs/HOMEKIT.md, and docs/ROADMAP.md still read like the 0.1.0 MVP
  announcement. M1–M4 are all done (19 capabilities are archived in `openspec/specs/`), every
  config key `src/config.ts` once called "reserved for a future release" is now genuinely consumed,
  and there is no CHANGELOG. A stranger reading the README today would underestimate the plugin and
  would not know how to find it in the Homebridge UI.
- **#22**: discoverability research is complete (see the issue's own comments) — exact-name search
  in the Homebridge UI already works today with no metadata change needed; the npm generic-keyword
  index lag is npm-side and not actionable; a verified-plugin application needs to lead with the
  local/no-cloud differentiation against the one already-verified competitor,
  `@omarshahine/homebridge-eight-sleep`. What is missing is turning that research into a concrete,
  ready-to-file checklist.

## What Changes

- Seed a distinct, HAP-legal `ConfiguredName` optional characteristic on every published service,
  set once at construction and never rewritten afterward — controller (Home app) renames persist
  exactly as they do for the accessory-level display name today (`openspec/specs/platform/spec.md`'s
  existing "Display names are seeded once…" requirement is the direct precedent this follows).
  `Thermostat`, `Switch`, `Lightbulb`, `ContactSensor`, `LeakSensor`, `OccupancySensor`, and
  `StatelessProgrammableSwitch` do not declare `ConfiguredName` as required or optional in the
  installed HAP-NodeJS version, so each service must call `addOptionalCharacteristic` before
  `getCharacteristic`/`setCharacteristic`, or HAP-NodeJS emits a `characteristic-warning` ("not in
  required or optional characteristic section… Adding anyway") on every restart. No Pod endpoint,
  no Pod write, no config key is touched by this — it is HAP-side accessory metadata only.
- Unify the naming convention currently feeding each service's `Name` characteristic (some use the
  bare accessory display name, some append a suffix, some use hardcoded per-side strings, hub
  services use plain constants) into one convention, and use that unified label as each service's
  `ConfiguredName` seed value.
- Rewrite README.md: a complete config-key reference table generated from `src/config.ts` (every
  key now consumed — the "reserved keys… currently have no effect" paragraph is stale and is
  removed), an updated honesty/caveats section reflecting what has and has not been verified
  against a real paired Home app, an install section carrying the exact-name Homebridge UI search
  instruction, and a feature tour matching the 19 shipped capabilities in `openspec/specs/`.
- Freshness pass on `docs/HOMEKIT.md` (append the `ConfiguredName` decision; the rest is current)
  and `docs/ROADMAP.md` (M1–M4 are complete; reframe as history, M5 as in progress).
- Add `CHANGELOG.md` covering 0.1.0, 0.2.0, 0.3.0, and this change (0.3.1).
- Add a ready-to-file verified-plugin application checklist (doc), stating the local/no-cloud
  differentiation against `@omarshahine/homebridge-eight-sleep` and a criteria-by-criteria
  self-assessment, sourced from the research already recorded in issue #22's comments.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `platform`: adds a requirement that every published service carries a distinct, HAP-legal
  `ConfiguredName`, seeded once at construction from a unified per-service label and never
  rewritten after creation — the service-level sibling of the capability's existing accessory-level
  "display names are seeded once… and never rewritten" requirement.

## Impact

- Code: `src/services/*.ts` (all eleven service files add a `ConfiguredName` seed at construction)
  and, if a shared helper is worth extracting, `src/platform.ts` or a new small module for the
  unified naming convention. No changes to `src/pod/*.ts`, `src/config.ts`, or
  `config.schema.json` — no new config key, no new Pod endpoint, no new write of any kind
  (expensive or otherwise). This does change the HAP characteristic set of every service on an
  already-published, paired install (Casey's), which bumps the accessory's HAP configuration
  number on next update — see design.md for the migration story.
- Docs: `README.md` (rewritten), `docs/HOMEKIT.md` and `docs/ROADMAP.md` (freshness pass),
  `CHANGELOG.md` (new), and a new verified-plugin application checklist doc.
- No `openspec/specs/` capability other than `platform` changes requirements; the doc-only work
  (#21, #22) has no spec-level behavior to delta.

## Non-goals

- No new config key, and no config-level way to customize a service's default `ConfiguredName`
  beyond what `ConfiguredName` plus Home-app renaming already provide.
- Not filing the verified-plugin application itself — only preparing the ready-to-file checklist;
  filing is a deliberate follow-up action for the tech lead, per issue #22's own "optionally the
  verified application itself" framing.
- Not chasing npm's generic-keyword search-index lag (`free sleep`, `eight sleep`) — confirmed
  npm-side with no actionable fix and no SLA.
- Not flipping the repo's visibility to public — that is a separate, already-documented M5 action
  (`docs/ROADMAP.md`: `gh repo edit caseyWebb/homebridge-free-sleep --visibility public`) taken
  only once M5 is otherwise complete.
- Not resolving the open Home-app verification items themselves (issue #36) — only documenting
  them honestly in the README's caveats section.
