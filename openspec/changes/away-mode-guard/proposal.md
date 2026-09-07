## Why

The Pod's own firmware silently widens the blast radius of any side write: `updateSide` in
`server/src/routes/deviceStatus/updateDeviceStatus.ts` (free-sleep `~/Code/free-sleep`, pinned
v2.1.5 `dc0c710`, same as `docs/POD-API.md`) computes
`controlBothSides = settings.left.awayMode || settings.right.awayMode`, and when either side is
in away mode, a status write addressed to one side is physically applied to **both**. Today
(`pod-write-queue`, shipped) `WriteQueue` dispatches exactly the intent it is given and
deliberately holds no opinion about away mode — its spec's own words: "The queue holds no
policy about away mode... Those behaviours belong to later, separately specified guards, which
are expected to be built on the exclusive-section mechanism" (`openspec/specs/pod-write-queue/
spec.md`). Right now a HomeKit user who sets Right's temperature while Left is away silently
also changes Left's hardware, with HomeKit's own model of Left never told. `awayModeWritePolicy`
already exists in `src/config.ts`/`config.schema.json` as a reserved, no-effect key — this
change is what makes it do something (issue #13).

## What Changes

- Add an `AwayModeGuard` (`src/pod/awayModeGuard.ts`) that sits between every side-write caller
  (today: `ThermostatService`'s `onSet` handlers; the concurrent `keep-alive` change's periodic
  `secondsRemaining` refresh is expected to adopt the same surface) and `WriteQueue.submitSide`.
  Before letting a side write through, it consults the snapshot's cached away-mode knowledge for
  **both** sides and, if either is on, applies `config.awayModeWritePolicy`:
  - `'block'` — the write is refused before it reaches `WriteQueue` at all. The caller's promise
    rejects with a dedicated `AwayModeBlockedError` (no HAP dependency in `src/pod/`); the
    HAP-facing caller (`ThermostatService`) converts that specifically into
    `HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)` — distinct from the generic
    `SERVICE_COMMUNICATION_FAILURE` an unreachable-Pod write failure already throws — and
    schedules a short, injected-timer-driven `refresh()` to correct any characteristic value HAP
    may have optimistically applied ahead of the rejection.
  - `'mirror'` — the write is allowed through unchanged, and the guard additionally submits the
    same overlayable fields to the other side's lane so the cached snapshot (and therefore
    HomeKit) reflects the physical both-sides effect immediately, instead of waiting for the next
    settings/deviceStatus poll to catch up.
  - The guard's decision-and-dispatch runs inside `WriteQueue.runExclusive` — the exclusive
    section the `pod-write-queue` spec built for exactly this ("A submitter... cannot be
    interleaved with an unrelated write") — so it can never be reordered against another
    in-flight dispatch this plugin issues, including a concurrent away-mode toggle.
- `awayModeWritePolicy` goes live: `FreeSleepPlatform` constructs one `AwayModeGuard` per launch
  (alongside the existing single snapshot/poller/write-queue) and threads it through
  `ServiceContext`.
- **Resolve the value-set discrepancy** between issue #13/#12-era planning (`'block' | 'mirror' |
  'allow'`, default `'block'`) and the already-shipped `src/config.ts`/`config.schema.json`
  (`'mirror' | 'block'`, default `'mirror'`): this proposal ratifies the shipped two-value,
  `'mirror'`-default shape. See design.md, "Resolving the policy-value discrepancy," for the
  justification and the (zero-cost) migration story.
- No new Pod endpoints are touched. The guard reads only the already-polled, cached `settings`
  document (`GET /api/settings`, cheap LowDB read, no job rebuild) via the synchronous snapshot;
  it issues no additional `GET`. A `'mirror'` decision causes an extra `POST /api/deviceStatus`
  (the mirrored side's write) — cheap, not a LowDB write, no job rebuild — but real, additional
  Pod hardware traffic. A `'block'` decision issues no request at all. No `POST /api/settings` or
  `POST /api/schedules` write is added by this change.

## Capabilities

### New Capabilities
- `away-mode-guard`: the pre-dispatch away-mode check, the `'block'`/`'mirror'` policy behaviors,
  the shared guard surface name other write originators (keep-alive) are expected to call through,
  and the residual-race documentation.

### Modified Capabilities
- `thermostat-service`: "Mode and setpoint writes become one minimal Pod patch each" gains an
  away-mode carve-out — a write can now be refused before dispatch (`'block'`), or accompanied by
  a second, mirrored write to the other side (`'mirror'`), and a refused write surfaces a distinct
  HAP status rather than the generic write-failure one.
- `config`: `awayModeWritePolicy` moves from "reserved, validated, unused" to "consumed by
  `away-mode-guard`"; the reserved-keys requirement's own text ("even though unused this change")
  no longer applies to this one key.

## Non-goals

- No new config key. `writeGuardStrict` (a forced settings re-read immediately before every
  device-status write, floated in issue #13 note 5) is **not** added — see design.md, "Staleness
  and the residual race," for why the existing cached-snapshot freshness is judged sufficient and
  why forcing an extra `GET /api/settings` before every thermostat write is not.
- No away-mode *toggle* UI/HomeKit service. This change guards writes made while away mode is on;
  it does not add a way to turn away mode on or off from HomeKit. (Tracked separately, if wanted.)
- No change to the Pod's own both-sides mirroring. That is upstream firmware behavior
  (`updateDeviceStatus.ts`) this plugin cannot and does not try to alter — the guard only changes
  what HomeKit is told and whether the plugin's own write reaches the Pod.
- No change to `WriteQueue`'s or `SnapshotStore`'s existing specs. The guard is built entirely on
  the exclusive-section (`runExclusive`) and submission (`submitSide`) surfaces those modules
  already publish for this purpose; neither module's requirements change.
- Closing the fully out-of-band race (an away-mode toggle made through free-sleep's own web UI,
  never observed by this plugin until the next `settings` poll) is explicitly not achievable and
  is documented, not solved.

## Impact

- **New file**: `src/pod/awayModeGuard.ts` (`AwayModeGuard`, `AwayModeBlockedError`).
- **Modified**: `src/platform.ts` (construct the guard, add it to `ServiceContext`),
  `src/services/types.ts` (`ServiceContext.awayModeGuard`), `src/services/thermostat.ts` (route
  `targetStateChar`/`targetTempChar` `onSet` through the guard instead of calling
  `ctx.writeQueue.submitSide` directly; map `AwayModeBlockedError` to
  `NOT_ALLOWED_IN_CURRENT_STATE`).
- **Not modified**: `src/pod/writeQueue.ts`, `src/pod/snapshot.ts`, `src/pod/poller.ts`,
  `src/config.ts`, `config.schema.json` — all already shipped in the shape this change needs.
- **Endpoints touched**: `GET /api/settings` (read-only, via the existing cache — no new poll
  cadence), `POST /api/deviceStatus` (an extra write only under `'mirror'` while away mode is
  active). No `POST /api/settings` / `POST /api/schedules` write is introduced.
- **Tests**: no live Pod writes. `test/mockPod.ts` already implements the both-sides mirroring
  (`openspec/specs/pod-test-double/spec.md`, "The mock reproduces away-mode both-sides
  mirroring") and is the executable oracle this change's tests run against, alongside fake-timer
  unit tests of `AwayModeGuard` in isolation.
- **Coordination, not coupling**: the concurrent `keep-alive` change (#12) is expected to route
  its periodic `secondsRemaining` writes through the same named guard surface
  (`AwayModeGuard.guardSideWrite`) rather than calling `WriteQueue.submitSide` directly. This
  proposal does not import or depend on that change's artifacts — it only names the surface.
