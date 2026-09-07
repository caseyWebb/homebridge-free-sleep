## Why

Two issues (#17, #18) each ask for a per-side HomeKit `Switch` bound to a field the Pod only
exposes through the expensive `/api/settings` write path (`docs/POD-API.md`: any
`settingsDB.json` write makes the Pod cancel and rebuild every scheduled job via chokidar).
They're grouped into one change because they share the same hazard class — a rare,
user-initiated, expensive write — and because implementing #18 first surfaces a real race in
already-shipped code that #17's own write path must not repeat: this is the first change to
ever call `WriteQueue.submitSettings` with an `awayMode` patch, and issue #18 carries a
reviewer-identified ordering hazard against a concurrent side write that has to be closed
before the switch can ship, not deferred as a known issue.

- **Away Mode** (#18) is the *real* per-side "pause everything": `powerScheduler.ts:18,91`,
  `temperatureScheduler.ts:45`, and `alarmScheduler.ts:127` (free-sleep `~/Code/free-sleep`,
  v2.1.5 `dc0c710`) all return early for a side with `awayMode` set, and the already-shipped
  `AwayModeGuard`/`WriteQueue` machinery (`away-mode-guard` change) already *reacts* to this
  field — nothing has ever *written* it yet.
- **Skip Next Alarm** (#17) turns the already-existing `scheduleOverrides.alarm.expiresAt`
  skip mechanism (confirmed: `alarmScheduler.ts`'s `scheduleAlarm` recurrence job checks only
  `expiresAt` against `now`, never `disabled` — see design.md for the exact lines) into a
  one-tap HomeKit toggle, mirroring the "next alarm" computation free-sleep's own web UI
  already implements (`app/src/pages/ControlTempPage/AlarmDisabledDialog.tsx`).

## What Changes

- Add an **Away Mode `Switch`** per side, bound to `settings.{side}.awayMode`
  (`src/services/awayMode.ts`, new). `onSet` debounces locally (>= 2s) and rate-limits (one
  settings write per 10s per side) before calling `writeQueue.submitSettings`; `onGet` reads
  `snapshot.get().{side}.awayMode` synchronously, the same "never fetch on read" pattern
  `ThermostatService` already uses. An optional `awayModeTurnsSideOff` config flag (default
  `false`) turns the side off first, then enables away mode, in two sequenced writes — the
  reverse order lets the Pod's own `controlBothSides` coupling mirror `isOn:false` onto the
  other side too, which is not what enabling away mode alone should do.
- Add a **Skip Next Alarm `Switch`** per side, bound to `settings.{side}.scheduleOverrides
  .alarm.expiresAt` being a not-yet-elapsed timestamp (`src/services/skipAlarm.ts`, new). `ON`
  computes the next alarm occurrence from the cached `schedules` snapshot + `settings.timeZone`
  and posts `{disabled: true, timeOverride: '', expiresAt: <computed, ISO-8601 with offset>}`;
  `OFF` posts `{disabled: false, timeOverride: '', expiresAt: ''}`. The next-alarm computation
  lives in a new, deliberately shared module, `src/pod/alarmSchedule.ts` (see "Coordination,
  not coupling" below) — reused by neither of these two callers alone.
- **Close the away-mode ordering hazard** identified against issue #18 (see design.md,
  "The ordering hazard" — the first real caller of `submitSettings({awayMode})` exposes a
  latent race between the settings lane's optimistic overlay and an already-pending side
  write's away-mode decision, both inside `src/pod/writeQueue.ts`). This requires a scoped
  change to already-shipped `writeQueue.ts`/`awayModeGuard.ts` — flagged for tech-lead
  sign-off in design.md, same as `away-mode-guard`'s own policy-value decision was.
- Two new config keys: `awayModeSwitch` (default `true`), `skipAlarmSwitch` (default `true`) —
  gate whether each switch is published at all; `awayModeTurnsSideOff` (default `false`, per
  issue #18's own spec). Documented in `src/config.ts`, `config.schema.json`, `README.md`.
- New subtypes and `enabledServiceKeysFor` (`src/platform.ts`) prune-table entries for both
  switches, following the `THERMOSTAT_SUBTYPE`/`CONNECTION_SUBTYPE` pattern.

## Capabilities

### New Capabilities
- `away-mode-switch`: the per-side Away Mode `Switch` — binding to `settings.{side}.awayMode`,
  the debounce/rate-limit contract, the `awayModeTurnsSideOff` sequencing, and (jointly with
  `pod-write-queue`'s delta below) the ordering-hazard fix this switch's existence requires.
- `skip-alarm-switch`: the per-side Skip Next Alarm `Switch` — the on/off `expiresAt` mapping,
  the next-alarm computation contract, and the self-clearing-when-expired read behavior.

### Modified Capabilities
- `pod-write-queue`: closes the ordering hazard between a pending side-lane write and a
  concurrently-submitted, `awayMode`-touching settings-lane write — the first real usage of
  `submitSettings({awayMode})` in the codebase exposes a gap the spec's existing text doesn't
  yet cover. See design.md for the exact mechanism.
- `config`: adds `awayModeSwitch`, `skipAlarmSwitch`, `awayModeTurnsSideOff` as consumed
  (not reserved) keys.

## Non-goals

- No "pause temperature schedule" switch. `settings[side].scheduleOverrides
  .temperatureSchedules` is confirmed dead config upstream: it appears only in
  `server/src/db/settings.ts` (defaults), `server/src/db/settingsSchema.ts` (the zod type),
  and `app/src/mocks/mockData.ts` (mock fixtures) — no job in `server/src/jobs/` reads it
  (verified: `grep -rn temperatureSchedules server/src app/src` returns only those three
  non-job hits). Away Mode is the working equivalent, per issue #18.
- No change to `scheduleAlarmOverride`'s separate "move tonight's alarm to a different time"
  feature (`alarmScheduler.ts`'s `disabled`/`timeOverride` handling outside the `expiresAt`
  skip path) — untouched by this change.
- No `POST /api/schedules` write of any kind — schedules are read-only in this change, used
  solely to compute the next alarm occurrence.
- No general-purpose "settings write" service abstraction beyond what these two switches need
  — `src/pod/alarmSchedule.ts` exports only the next-alarm computation, not a broader settings
  read/write helper.
- The residual, fully out-of-band race (an `awayMode` toggle made through free-sleep's own web
  UI, invisible to this plugin until the next settings poll) is not newly closed by this
  change — it is the same, already-documented residual race `away-mode-guard`'s design.md
  accepted, bounded by `slowPollIntervalMs` (default 300s).
- The "reactive re-check on settings-failure" mitigation considered for the ordering hazard
  (force an immediate `deviceStatus` re-poll after a failed `awayMode`-touching settings
  write) is **not** adopted as the primary fix — see design.md for why it's insufficient on
  its own — though it may still be layered on as cheap defense-in-depth; that decision is
  left to the implementing task, not mandated here.

## Impact

- **New files**: `src/services/awayMode.ts`, `src/services/skipAlarm.ts`,
  `src/pod/alarmSchedule.ts`.
- **Modified**: `src/pod/writeQueue.ts` (ordering-hazard fix — see design.md), `src/config.ts`
  / `config.schema.json` / `README.md` (three new consumed keys), `src/platform.ts`
  (construct both services, extend `enabledServiceKeysFor`), `src/services/types.ts` (no
  change expected — both services use the existing `ServiceContext` as-is).
- **Not modified**: `src/pod/snapshot.ts` (the Away Mode switch reads the already-overlayable
  `awayMode` field as-is; the Skip Next Alarm switch keeps its own local optimistic shadow
  rather than adding `scheduleOverrides.alarm.expiresAt` as a new overlayable field — see
  design.md), `src/pod/awayModeGuard.ts`'s public decision contract (`decide()`'s signature
  and return type are unchanged; only when/how `writeQueue.ts` calls it changes).
- **Endpoints touched**:
  - `POST /api/settings` — **expensive** (full node-schedule job rebuild on the Pod,
    `docs/POD-API.md`) — used by both switches. This is the rare, user-initiated write class
    the project's constraints say must stay rare; each switch debounces (>= 2s) and the Away
    Mode switch additionally rate-limits (one write per 10s per side).
  - `GET /api/schedules` — read-only, already polled and cached; used only by the Skip Next
    Alarm switch's next-alarm computation.
  - `GET /api/settings` — read-only, already polled and cached; used by both switches' `onGet`.
  - No `POST /api/schedules` and no new `POST /api/deviceStatus` usage beyond what
    `away-mode-guard`'s existing mirror policy already issues.
- **Coordination, not coupling**: `src/pod/alarmSchedule.ts` is named so that the concurrent,
  not-yet-created "scheduled fast-poll around predicted alarm times" change (`docs/HOMEKIT.md`,
  "Alarm ringing" — tracked informally against issue #16) can extend the same module instead
  of duplicating the next-alarm computation. This change creates and owns the module as of
  now; it imports nothing from that other change, which does not yet exist as an OpenSpec
  change directory.
- **Tests**: no live Pod writes. `test/mockPod.ts` already implements the settings deep-merge
  and `id`-stripping semantics `server/src/routes/settings/settings.ts` uses (verified against
  upstream this session), and already reproduces `controlBothSides` mirroring — both switches'
  tests, and the new ordering-hazard regression test (design.md), run against it and against
  fake-timer unit tests of `WriteQueue`/`AwayModeGuard` in isolation.
