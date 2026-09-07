# Fixture provenance

Per ADR-0001 (`docs/adr/0001-synthetic-fixtures-until-hardware.md`), the four canonical
fixtures were originally synthetic. Issue #3 is now closed: they are **real captures** from a
Pod 3 running free-sleep **2.1.5**, taken 2026-09-06 while the unit was mid-priming cycle, via:

```sh
curl -s http://<pod-ip>:3000/api/deviceStatus | jq . > test/fixtures/deviceStatus.priming.json
curl -s http://<pod-ip>:3000/api/settings     | jq . > test/fixtures/settings.json
curl -s http://<pod-ip>:3000/api/schedules    | jq . > test/fixtures/schedules.json
curl -s http://<pod-ip>:3000/api/services     | jq . > test/fixtures/services.json
```

Issue #19 (the `occupancy` change) added two more real captures from the same unit, same
free-sleep version, taken 2026-09-06 — read-only, no writes performed to obtain them:

```sh
curl -s http://<pod-ip>:3000/api/metrics/presence | jq . > test/fixtures/metricsPresence.json
curl -s http://<pod-ip>:3000/api/metrics/vitals   | jq . > test/fixtures/metricsVitals.json
```

| File | Status | Date | Notes |
|---|---|---|---|
| `deviceStatus.json` | captured, **edited** | 2026-09-06 | The raw capture had `isPriming: true` (the unit was mid-prime at capture time); this file flips it to `false` so the canonical fixture represents the common idle state. Every other field is the real capture, byte-for-byte. Raw, unedited capture preserved as `deviceStatus.priming.json`. |
| `deviceStatus.priming.json` | captured, verbatim | 2026-09-06 | The exact `GET /api/deviceStatus` response, including `isPriming: true`. Exercises priming as a live device-status state. |
| `deviceStatus.bothOff.json` | synthetic, **permanent** | 2026-09-06 | Shared/global fields (`coverVersion`, `hubVersion`, `freeSleep.version`, the nested `settings` block, `wifiStrength`) updated to match the real capture; `left`/`right`/`secondsRemaining: 0`/`isOn: false` are hand-derived and unchanged. Power-off / derived-`isOn` edge case. |
| `deviceStatus.waterLow.json` | synthetic, **permanent** | 2026-09-06 | Same shared-field update as above; `waterLevel: "false"` hand-derived and unchanged. `interpretWaterLevel` → `'low'`. |
| `deviceStatus.waterUnknown.json` | synthetic, **permanent** | 2026-09-06 | Same shared-field update as above; `waterLevel: "unknown"` hand-derived and unchanged. `interpretWaterLevel` → `'unknown'`, never `'low'`. |
| `settings.json` | captured, **scrubbed** | 2026-09-06 | Real capture; `id` replaced with `"00000000-0000-0000-0000-000000000000"` (see Scrubbing below). Names are the real unit's literal defaults, `"Left"`/`"Right"`. |
| `schedules.json` | captured, verbatim | 2026-09-06 | Real capture — every day, both sides, has an empty `temperatures` map and `power`/`alarm` disabled (`enabled: false`), the Pod's out-of-the-box default schedule. |
| `services.json` | captured, verbatim | 2026-09-06 | Real capture. |
| `metricsPresence.json` | captured, verbatim | 2026-09-06 | Real capture, `GET /api/metrics/presence` (Pod 3, free-sleep 2.1.5). Both sides read `present: false` with an identical `lastUpdatedAt` — consistent with a capture taken shortly after a restart, before any real presence transition had occurred (the "unknown, not empty" default state `openspec/changes/occupancy/design.md` describes). |
| `metricsVitals.json` | captured, verbatim | 2026-09-06 | Real capture, `GET /api/metrics/vitals` (Pod 3, free-sleep 2.1.5). Two rows, one per side, **not** sorted with left first — the capture is preserved in the order the endpoint actually returned it. Both rows carry `hrv: 0`/`breathing_rate: 0`, empirically confirming this file's own "HRV and breathing rate are explicitly unvalidated" note (the write-side bounds `heart_rate` 30-90/`hrv` 0-200/`breathing_rate` 5-30 are never applied to what `GET /vitals` returns). |

The synthetic-derivation note from ADR-0001 no longer applies to the four primary fixtures
(`deviceStatus.json`, `settings.json`, `schedules.json`, `services.json`) — they are real
captures now. The three `deviceStatus.*` edge-case variants remain **permanently synthetic**:
there is no "real" bothOff/waterLow/waterUnknown capture, because these are states the
fixture needs to exist in, not states a single capture session will find the Pod in.

## Scrubbing

Every fixture has been checked for: IP addresses, MAC addresses, serial numbers, account or
household identifiers, and personal names. `settings.json`'s `id` was a real UUID assigned by
the captured unit; it has been replaced with the literal placeholder
`"00000000-0000-0000-0000-000000000000"`. Nothing else in these fixtures identifies a real
unit or household: names are the literal defaults (`"Left"`/`"Right"`), and `schedules.json` /
`services.json` contain no identifying data.

## Verification observations (closing #3)

- The real `deviceStatus` response has **no `taps` key** on either side — confirms the
  assumption behind #21 (gesture tap counters are never present over HTTP); the tripwire in
  `test/fixtures.test.ts` still passes.
- `waterLevel` is the string `"true"` — matches the assumed shape, not a boolean.
- `wifiStrength` is present as a number (`60` in the canonical/priming captures) — matches
  `DeviceStatusSchema`.
- `coverVersion` / `hubVersion` are `"Pod 3"`, not the placeholder `"Pod 5"` ADR-0001 and
  design.md's Open Question 3 guessed. Nothing in the codebase branches on this value, so the
  guess being wrong was benign — see the ADR's 2026-09-06 update.

## Do not hand-edit further

Do **not** hand-edit a captured fixture beyond the two documented, deliberate edits above
(`settings.json`'s `id` scrub, `deviceStatus.json`'s `isPriming` flip). If a captured value
looks wrong, re-capture rather than patch it in place, so the file stays an honest snapshot.
