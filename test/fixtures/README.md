# Fixture provenance

Per ADR-0001 (`docs/adr/0001-synthetic-fixtures-until-hardware.md`), no Pod is reachable from
the development machine yet, so every fixture below is **synthetic**: generated from
free-sleep's own seed factories in `app/src/mocks/mockData.ts`, at the same pinned point
`src/pod/types.ts` vendors from — **v2.1.5, commit `dc0c710`**.

| File | Status | Derived from | Date | Exercises |
|---|---|---|---|---|
| `deviceStatus.json` | synthetic | `createDeviceStatus()`, `app/src/mocks/mockData.ts:310` | 2026-09-06 | Nominal device-status read: both sides on, `waterLevel: "true"`, no `taps` |
| `deviceStatus.bothOff.json` | synthetic, **permanent** | hand-derived from `deviceStatus.json` (`secondsRemaining: 0`, `isOn: false` both sides) | 2026-09-06 | Power-off / derived-`isOn` edge case |
| `deviceStatus.waterLow.json` | synthetic, **permanent** | hand-derived from `deviceStatus.json` (`waterLevel: "false"`) | 2026-09-06 | `interpretWaterLevel` → `'low'` |
| `deviceStatus.waterUnknown.json` | synthetic, **permanent** | hand-derived from `deviceStatus.json` (`waterLevel: "unknown"`) | 2026-09-06 | `interpretWaterLevel` → `'unknown'`, never `'low'` |
| `settings.json` | synthetic | `createSettings()`, `app/src/mocks/mockData.ts:197` | 2026-09-06 | Settings read; away-mode mirroring tests start from this seed |
| `schedules.json` | synthetic | `createSchedules()`, `app/src/mocks/mockData.ts:120` | 2026-09-06 | Schedules read |
| `services.json` | synthetic | `createServices()`, `app/src/mocks/mockData.ts:257` | 2026-09-06 | `biometrics.enabled` read |

The four canonical fixtures (`deviceStatus.json`, `settings.json`, `schedules.json`,
`services.json`) are named to match the capture commands below character for character — a
real capture is a plain overwrite, no code change. The three `deviceStatus.*` variants are
hand-derived edge cases and are **permanently synthetic**: there is no "real" bothOff/waterLow/
waterUnknown capture command, because these are states the fixture needs to exist in, not
states a single capture session will find the Pod in.

## Two deliberate departures from upstream's seed values (canonical `deviceStatus.json` only)

- `isPriming: false` — upstream's mock ships `true`, which is a UI demo state, not a resting
  state.
- `freeSleep.version: "2.1.5"`, `branch: "main"` — matches the version `src/pod/types.ts` was
  vendored from, rather than upstream's mock value of `"1.2.0"`.

`coverVersion` / `hubVersion` keep upstream's `"Pod 5"` (tech-lead resolution, design.md,
Open Question 3) — this is the value most likely to be wrong for the actual paired unit
(`docs/POD-API.md`'s worked example shows `"Pod 3"`); nothing in this change branches on it.

`services.json`'s per-job `timestamp` fields are fixed ISO-8601 strings rather than
upstream's `Date.now()`-relative ones, since this is a static committed file, not a live mock
response.

## Scrubbing

Every fixture has been checked for: IP addresses, MAC addresses, serial numbers, account or
household identifiers, and personal names. `settings.json`'s `id` is the literal placeholder
string `"demo-user"` (upstream's own mock value) — not a real UUID. There is nothing upstream's
seed data carries that identifies a real unit or household, since it was never associated with
one.

## Capturing real fixtures (closes #3)

Once a real Pod is reachable on the LAN, overwrite the four canonical files with real captures:

```sh
curl -s http://<pod-ip>:3000/api/deviceStatus | jq . > test/fixtures/deviceStatus.json
curl -s http://<pod-ip>:3000/api/settings     | jq . > test/fixtures/settings.json
curl -s http://<pod-ip>:3000/api/schedules    | jq . > test/fixtures/schedules.json
curl -s http://<pod-ip>:3000/api/services     | jq . > test/fixtures/services.json
```

Before committing a captured file:

1. **Scrub** it: remove/replace any real serial number, MAC or IP address, household name, or
   real UUID in `settings.json`'s `id` (replace with a placeholder such as `"demo-user"`).
2. **Update this table**: change the file's row to `captured`, record the date and the Pod's
   reported `freeSleep.version`, and drop the "derived from" column (there is no seed factory
   for a real capture).
3. **Re-run the suite**: `npm test`. In particular:
   - `test/fixtures.test.ts` — confirms the capture still parses through the vendored read
     schemas, and re-runs the `taps`-absence assertion. **If a real capture contains `taps`**,
     this test fails loudly and names #21 — that is the tripwire working as intended, not a
     bug to work around.
   - `test/mockPod.test.ts` and `test/client.test.ts` — since the mock seeds from these same
     fixtures, every mock-based test is automatically re-validated against real data.
4. Leave the three `deviceStatus.*` edge-case variants alone — they stay synthetic forever (see
   table above).

Do **not** hand-edit a captured fixture afterwards beyond scrubbing; if a captured value looks
wrong, re-capture rather than patch it in place, so the file stays an honest snapshot.
