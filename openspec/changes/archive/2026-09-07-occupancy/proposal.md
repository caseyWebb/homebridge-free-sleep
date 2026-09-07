## Why

Issue #19 (M4) asks for an `OccupancySensor` per side, driven by `occupancySource: 'none' |
'presence' | 'vitals'` — a key `src/config.ts` already reserves for exactly this change. Two
real, source-verified signals exist on the Pod for "is someone in this side of the bed,"
neither of which the plugin reads today:

- `GET /api/metrics/presence` — populated in near-real time by the Python biometrics stream
  (`BiometricProcessor._update_presence_api`, `biometrics/stream/biometric_processor.py`),
  which POSTs a transition to `http://127.0.0.1:3000/api/metrics/presence` as soon as it
  detects one from the piezo signal. But the store is **in-memory**
  (`server/src/routes/metrics/presence.ts`) and resets to `present: false` on every process
  restart — indistinguishable, on read alone, from "genuinely empty."
- `GET /api/metrics/vitals?side&startTime&endTime` — SQLite rows written every 60 s
  (`BiometricProcessor(..., insertion_frequency=60)`,
  `biometrics/stream/stream_processor.py:38-39`) while a side is occupied. It does not reset
  on restart, but a row is only ever inserted once someone has been detected present long
  enough to compute a heart rate (`present_for > heart_rate_window_seconds`,
  `biometrics/stream/biometric_processor.py:79`), so an empty bed legitimately produces zero
  rows for a stretch — that absence is not itself a defect signal.

Both require biometrics enabled (`GET /api/services` → `biometrics.enabled`,
`server/src/db/servicesSchema.ts`) and, per issue #19, the Pod firewalled off from Eight
Sleep's cloud. Reading either source naively and reporting it as confident occupancy risks
exactly the failure issue #19 calls out by name: **an occupancy sensor that is permanently and
wrongly "Not Occupied" is worse than no sensor**, because a user builds an automation on it
that silently never fires. This change's central job is making the `StatusActive` gating that
avoids that failure correct for both sources, not just wiring up two more GET requests.

## What Changes

- Vendors lenient read types for both endpoints in `src/pod/types.ts`: a `PresenceSchema`
  (`{ left?, right?: { present: boolean, lastUpdatedAt?: string } }`) and a
  `VitalsRecordSchema` (`{ id, side, timestamp, heart_rate, hrv, breathing_rate }`, all numeric
  fields nullable, no range bounds — read-lenient, matching this file's established rule that
  a value the Pod never re-validates on read must still parse). Field names stay exactly as
  the wire reports them (`heart_rate`, not `heartRate`) — these are vendored contracts, not
  restyled ones.
- Adds `PodClient.getPresence()` and `PodClient.getVitals({ startTime?, endTime? })` — reads
  only, no corresponding `post*` method for either endpoint.
- Adds two new `PodPoller` endpoint classes, `'presence'` (30 s) and `'vitals'` (60 s) per
  issue #8's interval table, each gated by the poller's existing `enabled` predicate — the
  extension point `poller.ts`'s own module doc names for exactly this change ("#19") and that
  no shipped class has used until now. Both classes are enabled only when
  `occupancySource` names that source **and** the last-observed `GET /api/services` reports
  `biometrics.enabled === true`; before the first successful `services` poll, biometrics is
  treated as not-yet-proven-enabled, so occupancy polling defaults to off rather than on.
- Extends `SnapshotStore`: raw presence/vitals documents, four new per-side watched fields
  (`presencePresent`, `presenceActive`, `vitalsOccupied`, `vitalsActive`) and their `Change`
  variants, and the proof-of-life bookkeeping described in `design.md` that makes each
  source's `StatusActive` correct — a **changed** `lastUpdatedAt` for presence (not merely an
  observed one, which the reboot-reset default would satisfy falsely), and any-row-ever
  (sticky) for vitals.
- Adds `src/services/occupancy.ts`: an `OccupancySensor` per side (`OccupancyDetected` +
  `StatusActive`), never escalating to a throwing `onGet` — like `ConnectionService`, unlike
  `ThermostatService` — because `StatusActive` is this service's own designated "don't trust
  this" outlet.
- Makes `occupancySource` a **consumed** config key: `'none'` (the existing default) publishes
  no occupancy service at all — behavior is unchanged for every install that never sets it;
  `'presence'`/`'vitals'` publish it per side, gated into `platform.ts`'s existing
  enabled-service-keys/prune machinery exactly like the thermostat and connection sensor
  already are.
- Extends the `pod-test-double` capability: two new committed fixtures
  (`test/fixtures/metricsPresence.json`, `test/fixtures/metricsVitals.json` — real captures,
  provenance below) and mock handlers for `GET /api/metrics/presence` and
  `GET /api/metrics/vitals`, including the real Pod's `side`/`startTime`/`endTime` query
  filtering, plus state-override support so a test can seed "left present" or a fresh/stale
  vitals row.

## Non-Goals

- **No writes to either endpoint.** `POST /api/metrics/presence` exists upstream (the
  biometrics stream is its only real caller); this change adds no `postPresence`/`postVitals`
  to `PodClient` and the mock's own write semantics for it are out of scope.
- **No custom HomeKit characteristics for heart rate, HRV, or breathing rate.** Already decided
  in `docs/HOMEKIT.md` ("Vitals as custom characteristics — not in v1"): no native HomeKit
  characteristic exists for them, the Home app renders nothing for a custom one, and a bad
  custom **service** can mark a whole bridged accessory "Not Supported." `occupancySource:
  'vitals'` only ever surfaces a derived boolean.
- **No cross-source fallback.** If `occupancySource: 'presence'` is configured and biometrics
  later reports `enabled: false`, the sensor degrades to `StatusActive: false` (per its own
  requirement) rather than silently switching to `'vitals'` or vice versa. The user chose one
  source; auto-switching would make an already-subtle trust signal harder to reason about.
- **No new configurable poll intervals for these two classes.** 30 s / 60 s (issue #8's table)
  are fixed constants, the same way `poller.ts`'s `HARD_FLOOR_MS` is — `config.ts`'s
  `pollIntervals` schema was never pre-reserved with an occupancy-specific field the way
  `alarmPollIntervalMs` was pre-reserved for #16, which this change reads as a standing
  decision not to expose one yet.
- **No `waterLowSensorType`, hub accessory, or any other still-reserved config key.** Those
  belong to #20 and are untouched here.

## Capabilities

### New Capabilities

- `occupancy-sensor`: the per-side `OccupancySensor` HomeKit service — which config source
  drives it, its `StatusActive` trust semantics per source, and its restore/prune behavior.

### Modified Capabilities

- `pod-client`: adds `getPresence`/`getVitals`, both read-only.
- `pod-poller`: adds the `'presence'`/`'vitals'` endpoint classes as the first real consumer
  of the `enabled` predicate extension point.
- `pod-snapshot`: adds the raw presence/vitals layer, four new watched fields, and per-source
  proof-of-life state.
- `config`: `occupancySource` moves from "reserved, no effect yet" to consumed.
- `platform`: accessory topology and the service-routing table both gain the occupancy sensor,
  conditional on `occupancySource !== 'none'`.
- `pod-test-double`: two new fixtures and two new mock endpoints, with query filtering and
  state overrides.

## Impact

- **Endpoints touched:** `GET /api/metrics/presence` (in-memory, near-real-time, cheap — no
  DB or hardware round-trip) and `GET /api/metrics/vitals?startTime&endTime` (a SQLite read,
  cheap). `GET /api/services` is already polled by the shipped `services` endpoint class
  (`poller.ts`); this change only adds a new *reader* of its already-cached `biometrics.enabled`
  field, not a new request. **No write is added or made expensive** — this change makes no
  `POST` call of any kind.
- **Code:** `src/pod/types.ts` (two new schemas), `src/pod/client.ts` (`getPresence`/
  `getVitals`), `src/pod/poller.ts` (`EndpointClassId` gains `'presence' | 'vitals'`,
  `PollerOptions` gains `occupancySource`), `src/pod/snapshot.ts` (raw layer, watched fields,
  `Change` variants, proof-of-life), `src/services/occupancy.ts` (new), `src/platform.ts`
  (`enabledServiceKeysFor` takes the configured source, construction + routing table gain the
  new service), `src/config.ts` (doc-comment move only — the schema shape for `occupancySource`
  is unchanged), `test/mockPod.ts` + `test/fixtures/` (two new fixtures, two new endpoints).
- **No migration, no persisted state beyond the existing `accessory.context` mechanism.**
  Rollback is reverting the above files and deleting the two new fixtures and
  `src/services/occupancy.ts` plus its test.
