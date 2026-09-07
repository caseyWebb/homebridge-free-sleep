## Context

See `proposal.md` for motivation. This section covers the merged pieces this design builds on
— all already shipped and archived — plus the upstream free-sleep source this change's claims
are verified against (repo `~/Code/free-sleep`, tag `v2.1.5`, commit `dc0c710`, the same
version `docs/POD-API.md` is pinned to).

**Merged plugin code:**

- **`PodPoller`** (`src/pod/poller.ts`) is a registry of `EndpointClassSpec<T>` descriptors
  (`id`, `baseIntervalMs`, `read`, `apply`, optional `recordFailure`, optional `enabled`). The
  `enabled` field's doc comment names this change directly: "Extension point for #19... A
  disabled class skips the actual request but keeps its schedule running... None of the four
  shipped classes uses this today" (`poller.ts` lines 66–75). `isEnabled(rt)` evaluates
  `rt.spec.enabled(this.snapshot.get())` fresh on every tick, including inside `bootstrap()`
  (lines 263–264, 342). `PollerOptions` is a plain value object populated by `platform.ts` from
  parsed config — `poller.ts` itself never imports `config.ts` (design precedent from the
  archived `poller-and-write-queue` change, "Config ownership: named here, defined by
  `platform-foundation`").
- **`SnapshotStore`** (`src/pod/snapshot.ts`) layers `raw` (last-observed truth per endpoint
  class) under an `overlay`, commits every mutation through one `commit()` funnel that diffs an
  explicit, enumerated set of watched fields and emits one batched `Change` notification per
  commit that touches any of them (module doc; "Watched fields are enumerated"). Non-watched
  data (`schedules`, `services`) is still stored and readable via `documents.*` but produces no
  notification (`pod-snapshot` spec, "Watched fields are an explicit list that excludes
  continuously varying counters"). `ConnectionState.lastSuccessAt` is this module's existing
  precedent for a "proven at least once, then sticky forever" flag — `ConnectionService`
  (`src/services/connection.ts`) reads exactly that field for its own `StatusActive`.
- **`src/services/connection.ts`** is the only existing service that declares `StatusActive`/
  `StatusFault` and the only one that **never** escalates to a throwing `onGet` — "this service
  *is* the outage's data channel... degrading its own characteristics is the whole point"
  (module doc). `src/services/thermostat.ts` is the opposite case: it has no status outlet, so
  it escalates via `assertNotEscalated()` instead. `docs/HOMEKIT.md` states plainly which
  services legally declare `StatusFault`/`StatusActive`: "verified: `ContactSensor`,
  `LeakSensor`, `OccupancySensor` do; `Thermostat`, `Switch`, `Lightbulb` do **not**" — so
  `OccupancySensor` belongs with `ConnectionService`'s pattern, not `ThermostatService`'s.
- **`src/platform.ts`**'s `enabledServiceKeysFor(hap, role)` (lines ~178-183) currently takes no
  config and returns a fixed per-role set; `pruneServices` removes any service on a restored
  accessory whose `(UUID, subtype)` is not in that set, persisting the removal via
  `updatePlatformAccessories` only when something actually changed (the F4 pattern). This
  function's signature must grow to know the configured `occupancySource` (see Decisions).
- **`src/config.ts`** already reserves `occupancySource: z.enum(['none', 'presence',
  'vitals']).default('none')`, fully validated today even though unused — this change is the
  key's named owner (`config.ts`'s own doc table: `occupancySource` | `#19`).
- **`test/mockPod.ts`** is the executable spec for the Pod's write semantics and is seeded from
  `test/fixtures/*.json` via `loadFixture()`; `pod-test-double`'s own spec requires that "a
  later change reuses the mock unchanged" for reads and that new endpoints follow the same
  fixture-seeded, override-able, fault-injectable shape the four existing ones already have.

**Upstream free-sleep source (v2.1.5, `dc0c710`):**

- **`server/src/routes/metrics/presence.ts`** — `presenceData` is a **module-level, in-memory**
  object, `{ left: { present: false, lastUpdatedAt: <process-start time> }, right: {...} }`,
  initialized once at process start. `POST /presence` is the only thing that ever mutates it —
  called exclusively by the Python stream (below), never by anything in the TypeScript server
  itself. `GET /presence` is `res.json(presenceData)` verbatim, no re-validation.
  `PresenceDataSchema` there is `z.object({ left: PresenceSideSchema.optional(), right:
  PresenceSideSchema.optional() })` with `PresenceSideSchema = z.object({ present: z.boolean(),
  lastUpdatedAt: z.string().optional() })` — both sides, and `lastUpdatedAt` itself, are already
  optional in upstream's own schema, which is exactly the leniency this change's read schema
  should mirror rather than tighten.
- **`biometrics/stream/biometric_processor.py`** — `_update_presence_api` (lines 126–166) POSTs
  `{ [side]: { present: is_present } }` to `http://127.0.0.1:3000/api/metrics/presence` from
  `detect_presence` (lines 168–189) as soon as a transition is detected, with a
  `no_presence_tolerance = 10` (line 104) second debounce before flipping to absent — so the
  Pod-side signal itself is already debounced; this change adds no debounce of its own on top.
- **`server/src/routes/metrics/vitals.ts`** — `GET /vitals` builds a Prisma
  `vitalsWhereInput` from optional `side`/`startTime`/`endTime` query params (`side` exact
  match if given; `timestamp.gte`/`timestamp.lte` from `moment(startTime).unix()` /
  `moment(endTime).unix()` if given), queries `prisma.vitals.findMany` ordered by `timestamp
  asc`, and returns `loadVitals(vitals)` — the raw Prisma row plus a converted ISO `timestamp`,
  **not** re-validated against any zod schema before the response is sent.
- **`prisma/schema.prisma`**'s `model vitals` — `side: String` (a **plain string column, not an
  enum**), `timestamp: Int` (epoch seconds), `heart_rate`/`hrv`/`breathing_rate`: `Float?`
  (**nullable**). `server/src/db/vitalsRecordSchema.ts`'s `vitalsRecordSchema` (`heart_rate`
  30–90, `hrv` 0–200, `breathing_rate` 5–30) is a **write/insert-side** shape used elsewhere in
  the codebase — it is never applied to what `GET /vitals` returns, and the real capture below
  already contains `hrv: 0`/`breathing_rate: 0`, both outside that write schema's own bounds,
  confirming the read side must not inherit those bounds.
- **`biometrics/stream/stream_processor.py`** (lines 38–39) — `BiometricProcessor(side='left',
  ..., insertion_frequency=60)` / same for `'right'` — vitals rows are inserted at a 60-second
  cadence, matching `docs/POD-API.md`'s "written every 60 s by the Python stream" and issue
  #8's polling-interval table entry for this endpoint.
- **`biometric_processor.py`** line 79 — heart-rate calculation (and, downstream, the DB
  insert) only runs `if self.left_processor.present_for > self.left_processor
  .heart_rate_window_seconds`, i.e. **no row is inserted at all while a side is unoccupied.**
  An empty query window for a side is therefore an entirely expected, routine state whenever
  that side is empty — not evidence the pipeline is broken (load-bearing for the `vitalsActive`
  decision below).
- **`server/src/db/servicesSchema.ts`** — `ServicesSchema.biometrics.enabled: z.boolean()`,
  already vendored verbatim into `src/pod/types.ts`'s `ServicesSchema` and already read by the
  shipped `services` endpoint class (`poller.ts`, `baseIntervalMs: this.slowPollIntervalMs`).
  This change adds no new request for it.

**Real captures used as fixtures (2026-09-06, Pod 3, free-sleep 2.1.5, read-only, no writes
performed to obtain them):**

```jsonc
// metrics-presence.json
{ "left":  { "present": false, "lastUpdatedAt": "2026-09-06T22:29:54-05:00" },
  "right": { "present": false, "lastUpdatedAt": "2026-09-06T22:29:54-05:00" } }
```

```jsonc
// metrics-vitals.json
[
  { "id": 2, "side": "right", "timestamp": "2026-09-06T16:34:24-05:00",
    "heart_rate": 75, "hrv": 0, "breathing_rate": 0 },
  { "id": 1, "side": "left",  "timestamp": "2026-09-06T16:34:31-05:00",
    "heart_rate": 46, "hrv": 0, "breathing_rate": 0 }
]
```

Both sides read `present: false` with an identical `lastUpdatedAt` — consistent with a capture
taken shortly after a restart, before any real transition had occurred (exactly the "unknown,
not empty" state the module doc above describes as the default). The vitals rows carry real,
distinct `heart_rate` values (75, 46) but `hrv: 0`/`breathing_rate: 0` — empirical confirmation
of `README.md`'s "HRV and breathing rate are explicitly unvalidated" and of the schema note
above. Note the rows are **not sorted with left first** and use **snake_case field names** —
the vendored read schema must not assume an order or relabel the keys.

## Goals / Non-Goals

**Goals:**

- Reading either source never reports confident-but-wrong occupancy. `StatusActive` is the
  mechanism; it must be correct for each source's own failure mode, not just present.
- Getting in and out of bed flips the sensor within one poll interval of that source, when
  biometrics is enabled and proven live (issue #19's "Done when").
- With biometrics off (or unproven), the sensor reports inactive, never a confident state.
- Reuses every existing mechanism (`enabled` predicate, watched-field diffing, service
  restore/prune, mock-as-oracle testing) with no new timer, no new subsystem, and no new
  config knob beyond making `occupancySource` live.

**Non-Goals:** see `proposal.md`'s "Non-Goals" — no writes, no custom vitals characteristics,
no cross-source fallback, no new configurable poll intervals, no other still-reserved key.

## Decisions

### `occupancySource: 'none'` publishes no `OccupancySensor` at all

Unlike the connection sensor (always published) but exactly like the LED/Prime/Test-alarm
switches (`docs/HOMEKIT.md`'s "Other service choices" table, all opt-in), the occupancy sensor
does not exist as an accessory service when `occupancySource` is `'none'` — the existing
default, so **every install that has not explicitly opted in sees zero behavioral or topology
change from this change shipping.** This is enforced the same way `sides: 'left'` already
removes the right thermostat: `enabledServiceKeysFor` (currently `(hap, role) =>
ReadonlySet<string>`) grows a third parameter, the configured `occupancySource`, and returns a
set that includes the occupancy subtype key for a side role only when it is not `'none'`.
`pruneServices`/`constructServicesFor` need no change beyond passing the config through — both
already operate generically off whatever `enabledServiceKeysFor` returns (`platform.ts`'s own
design intent: "a later change only has to grow `enabledServiceKeysFor`, never [`pruneServices`]
itself"). Switching `occupancySource` between two non-`'none'` values (`'presence'` ↔
`'vitals'`) does **not** change the enabled-service-key set — the occupancy subtype key is
present either way — so no prune/re-add churn happens on that transition, only the service's
own internal source-selection logic changes what it reads.

### `SnapshotStore` stores both sources' derived booleans unconditionally; the service picks one

Rather than teach `SnapshotStore` about `occupancySource` (it currently has no config
awareness at all — a deliberate boundary: `pod-snapshot`'s spec never mentions policy), it
gains four new per-side watched fields that are simply `undefined` until their own endpoint
class is enabled and has produced at least one observation:

```ts
// EffectiveSideStatus additions
presencePresent: boolean | undefined; // raw Pod present flag
presenceActive:  boolean | undefined; // StatusActive per the presence rule below
vitalsOccupied:  boolean | undefined; // derived: a fresh heart-rate row exists
vitalsActive:    boolean | undefined; // StatusActive per the vitals rule below
```

`OccupancySensorService` (`src/services/occupancy.ts`) reads `ctx.config.occupancySource` and
picks `(presencePresent, presenceActive)` or `(vitalsOccupied, vitalsActive)` accordingly — the
same shape as `ThermostatService` reading `ctx.config.noResponseAfterMs` for its own escalation
policy while `SnapshotStore` stays policy-free. When the class for the *other* source has never
been enabled this launch, its pair simply stays `undefined` forever, which the service already
treats identically to "never observed" (falls back to `characteristic.value`, HAP's own
persisted default). Four new `SideChangeField` variants (`'presencePresent'`, `'presenceActive'`,
`'vitalsOccupied'`, `'vitalsActive'`) join the existing `Change` union so `platform.ts`'s
routing table can push `OccupancySensorService.refresh()` on any of them, mirroring
`isThermostatChange`'s pattern exactly (`isOccupancyChange`).

### Presence `StatusActive`: prove a *change* from the launch baseline, not mere presence of data

The naive rule — `StatusActive = true` once `GET /api/metrics/presence` has answered at all —
is wrong, because the in-memory store's own default (`present: false`,
`lastUpdatedAt: <process start time>`) *is* a successful answer that carries no information
about whether biometrics has ever produced a real transition since this plugin started
watching. Concretely: if the Pod rebooted a minute before this plugin's own launch and no one
has gotten in or out of bed since, every observation reads that same stale default forever,
and a naive "answered at all" rule would report confident, permanent, wrong occupancy data —
exactly issue #19's warned-against failure, just reached via a different path than "never
observed."

**Decision:** `SnapshotStore.observePresence(data)` records, per side, the `lastUpdatedAt` from
its **first-ever observation this launch** as a baseline. `presenceActive[side]` becomes `true`
the first time a *later* observation's `lastUpdatedAt` differs from that baseline, and stays
`true` from then on (sticky — the same non-regressing shape `ConnectionState.lastSuccessAt`
already uses, and for the same reason: a value the plugin has already proven trustworthy once
does not become untrustworthy again just because the signal happens to repeat). `presencePresent`
itself is always just the raw, current `present` boolean, regardless of `presenceActive` — the
service, not the snapshot, decides whether to trust it (mirroring how `connection.online` is
stored unconditionally and `ConnectionService` alone decides what to do with it).

This baseline is **per plugin launch, not persisted** — a restart re-baselines and briefly
re-enters "inactive" until the next real transition. Accepted: the alternative (persisting the
baseline in `accessory.context`) adds real state for a gap that is at most one full sleep/wake
cycle wide and self-heals with no user action, and the plugin already re-derives an analogous
value fresh every launch for `ConnectionService`'s `StatusActive` (`platformStartedAt`).

### Vitals `StatusActive`: proven once any row is ever observed, sticky — not per-poll "zero now"

Issue #19's text is terse here: "Degrade to `StatusActive = false` when the query returns
nothing at all." Two readings are possible, and they produce materially different UX:

1. **Per-poll:** re-evaluate on every poll; the *current* poll's query window returning zero
   rows makes `StatusActive` false right now, regardless of history.
2. **Sticky:** the *first* poll to ever return a row for a side proves the pipeline works for
   that side; `StatusActive` becomes `true` and stays `true`, independent of later polls.

Reading (1) makes `StatusActive` **flap in lockstep with ordinary occupancy**, because — per
the upstream source above — no vitals row is inserted at all while a side is empty. A side
that is genuinely, correctly reported "not occupied" for a normal empty-bed stretch longer than
the query window would *also* flip its own trust signal to "not responding" every single time,
which reads to a user as a flaky sensor rather than as an accurate one, and defeats the whole
point of having a separate trust channel from the occupancy value itself.

**Decision: reading (2).** `vitalsActive[side]` becomes `true` the first time any poll's query
window returns at least one row for that side, and stays `true` from then on — symmetric with
`presenceActive`'s and `ConnectionState.lastSuccessAt`'s own "prove once, trust forever" shape,
and directly justified by the `present_for` gate in `biometric_processor.py` (Context): a zero-
row window is the *expected* steady state for an empty, correctly-idle side, not a signal
failure. `vitalsOccupied[side]` (the actual occupancy value, not the trust flag) is
recomputed fresh on every poll from that same query's rows: `true` iff at least one returned
row for that side has a non-null `heart_rate` — the query window itself already bounds
"recent" (see below), so no separate timestamp comparison is needed inside `SnapshotStore`.

**Flagged for tech-lead confirmation** — see Open Questions: this reading is a judgment call
about ambiguous issue text, not something upstream source can settle either way.

### One combined vitals query per poll, windowed to the "recent" threshold itself

`getVitals` is called with `startTime = now - 180_000` (3 minutes — issue #19's own "~3 min",
chosen as roughly 3× the 60 s insertion cadence, tolerant of one or two missed insertions) and
`endTime = now`, **no `side` filter** — one request returns both sides' recent rows in one
round trip, matching every other endpoint class's "one shared poll serves every reader" rule
(`pod-poller` spec). `180_000` is a fixed internal constant in `src/pod/snapshot.ts` (or
`poller.ts`, wherever the `vitals` class's `read` closure lives), not a config field — see
`proposal.md`'s Non-Goals. Because the query window already excludes anything older than 3
minutes, `vitalsOccupied` needs no independent staleness check against wall-clock time inside
`SnapshotStore`; the Pod already did that filtering.

### `OccupancySensorService` never escalates to a throwing `onGet`

Per `docs/HOMEKIT.md`, `OccupancySensor` legally declares `StatusFault`/`StatusActive` — the
same category as `ConnectionService`, and unlike `ThermostatService`, which escalates via
`assertNotEscalated()` precisely *because* it has no status outlet of its own. This service
follows `ConnectionService`'s pattern exactly: `StatusActive` is the "don't trust this" signal;
degrading it is the correct, complete response to any of "biometrics disabled," "source
unproven," or "the Pod is unreachable" (the last of which already prevents any new
observation from arriving, so `presenceActive`/`vitalsActive` simply stop advancing — no
special-casing needed for a Pod outage specifically). `StatusFault` is **not** added — issue
#19 asks only for `StatusActive`, and `docs/HOMEKIT.md`'s "Occupancy" section never mentions a
fault characteristic for this sensor; adding an unrequested characteristic increases the
compatibility surface for no described benefit. `OccupancyDetected` (the sensor's one required
characteristic) always reflects the raw current value regardless of `StatusActive` — same
reasoning as `ConnectionService`'s `contactState()`, which reads `connection.online`
unconditionally rather than gating on its own `StatusActive`.

### `EndpointClassId`, `PollerOptions`, and the two new descriptors

`EndpointClassId` becomes `'deviceStatus' | 'settings' | 'schedules' | 'services' | 'presence'
| 'vitals'`. `PollerOptions` gains `occupancySource?: 'none' | 'presence' | 'vitals'`
(default `'none'`) — a plain value, following the same "poller doesn't import config.ts"
discipline every existing option already follows; `platform.ts` maps
`parsed.data.occupancySource` through unchanged, the same way it already maps `keepAlive` to
`KeepAliveOptions.enabled`. Both new classes are **registered unconditionally** in the
constructor (mirroring the four shipped classes, which also register unconditionally and rely
on `enabled` to decide whether they actually fire):

```ts
this.registerClass({
  id: 'presence',
  baseIntervalMs: 30_000,
  read: (client, signal) => client.getPresence(signal),
  apply: (snapshot, value) => snapshot.observePresence(value as PresenceData),
  enabled: (snapshot) =>
    this.occupancySource === 'presence' && snapshot.documents.services?.biometrics.enabled === true,
});
this.registerClass({
  id: 'vitals',
  baseIntervalMs: 60_000,
  read: (client, signal) => client.getVitals({ startTime: ..., endTime: ... }, signal),
  apply: (snapshot, value) => snapshot.observeVitals(value as VitalsRecord[]),
  enabled: (snapshot) =>
    this.occupancySource === 'vitals' && snapshot.documents.services?.biometrics.enabled === true,
});
```

Neither class defines `recordFailure` — matching `settings`/`schedules`/`services` (only
`deviceStatus` tracks connection state today); a failed presence/vitals poll simply leaves the
last-known observation in place, per `pod-snapshot`'s general "a failure does not erase known
state" rule, with no new failure-kind bookkeeping needed.

`services` is polled on the slow (5-minute default) tier, so `biometrics.enabled` may be
unknown for up to that long after a fresh launch. Until the first successful `services` poll,
`documents.services` is `undefined` and the `enabled` predicate above reads that as `false` —
"assume disabled until proven enabled" is the same conservative default this codebase already
applies elsewhere (e.g. `ConnectionService`'s pre-first-success `StatusActive: false`).

## Risks / Trade-offs

- **[Risk] The vitals "sticky" reading (chosen above) could be wrong.** If the tech lead
  intends the literal per-poll reading instead, `vitalsActive` would need to be recomputed
  fresh every commit rather than latched — a small, localized change (drop the sticky flag,
  read directly off the current poll's row count) that does not touch anything else in this
  design. Flagged in Open Questions.
- **[Risk] A very short-lived presence transition inside one 30 s poll window is missed.**
  `_update_presence_api`'s own `no_presence_tolerance` (10 s) already debounces the upstream
  signal, and the poll interval (30 s, per issue #8's table) is fixed for this change — this is
  an accepted, pre-existing shape of "poll, don't stream," not something this change
  introduces or could reasonably close without adopting `GET /api/logs/:filename`'s SSE
  mechanism, which `docs/POD-API.md` already lists under "Endpoints we deliberately do not
  use" for unrelated reasons (logs only).
- **[Risk] `presenceActive`'s per-launch re-baseline means a very quiet household (no one gets
  in or out of bed at all) never proves the presence source live, for that launch.** Accepted —
  this is exactly the state issue #19 wants surfaced as `StatusActive: false` rather than
  guessed at, and it self-heals on the very next real transition without a restart.

## Migration Plan

No persisted state, no schema migration for existing keys — `occupancySource`'s shape in
`config.ts` is unchanged; only its doc comment moves from "reserved" to "consumed," and
`config.schema.json`/`README.md` drop their "(reserved, no effect yet)" wording for it, the
same mechanical edit `keep-alive`'s tasks.md 1.2/1.3 made for `keepAlive`. Every install that
has not set `occupancySource` keeps the default `'none'` and sees no new accessory, no new
request, and no behavior change. Rollback is reverting the touched files and deleting
`src/services/occupancy.ts`, its test, and the two new fixtures.

## Open Questions

Flagged for tech-lead review; per this project's convention (see the archived `keep-alive`
design's own Open Questions/Resolutions section), none of these change the specs, the chosen
approach, or the task breakdown as currently written — they are asking for confirmation, not
raising a blocker.

1. **Vitals `StatusActive`: sticky-once-proven vs. per-poll "zero rows now."** This design
   chose sticky, reasoned from `biometric_processor.py`'s `present_for` gate (Context) — an
   empty window is the expected steady state for an idle side, not evidence of failure.
   Confirm, or state the intended per-poll reading explicitly if issue #19's phrasing was meant
   literally.
2. **Presence `StatusActive`: baseline-then-changed, per launch, unpersisted.** Confirm the
   "prove a change from this launch's first observation" reading of "at least one
   `lastUpdatedAt` change," and that re-baselining on every restart (rather than persisting the
   baseline in `accessory.context`) is an acceptable trade-off.
3. **`occupancySource: 'none'` omits the service entirely**, rather than publishing an
   always-`StatusActive: false` sensor. Confirm this reads as "no behavior change for the
   default config" rather than as a surprising topology difference from, say, the always-
   published connection sensor.
4. **No `StatusFault` on the occupancy sensor.** Confirm `StatusActive` alone satisfies issue
   #19's intent, matching `docs/HOMEKIT.md`'s "Occupancy" section, which never mentions a fault
   characteristic for this sensor.

## Resolutions (tech lead, 2026-09-06)

All four open questions resolved as designed: (1) sticky vitals StatusActive — per-poll
would flap on every legitimately empty bed, given upstream only inserts rows while occupied;
(2) presence proof-of-life via observed change from the per-launch baseline — the restart
reset makes mere data non-evidence; (3) occupancySource 'none' omits the service entirely;
(4) StatusActive only, no StatusFault. The design honors the prime directive from
docs/HOMEKIT.md: a permanently-wrong "Not Occupied" is worse than no sensor.
