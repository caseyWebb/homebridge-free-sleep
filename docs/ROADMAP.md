# Roadmap

Milestones map 1:1 to GitHub milestones. Each is independently shippable — you should have a
working, paired HomeKit accessory at the end of M2 and can stop any time after that.

## M1 — Foundations

Repo, build, and a typed client that can talk to a real Pod. No HomeKit yet.

- Project scaffolding: TypeScript ESM/NodeNext, vitest, lint, CI.
- `FreeSleepClient` — typed HTTP client with timeouts, retry and backoff.
- Vendored types derived from free-sleep's zod schemas.
- Vendored stateful Pod test double, based on upstream's MSW mock.
- Temperature conversion utilities (°F ↔ °C) with round-trip tests.

**Done when:** `npm test` is green and a smoke script can read live status from the real Pod.

## M2 — Core thermostat

The minimum viable plugin: each side of the bed as a HomeKit thermostat.

- Dynamic platform, accessory cache, config schema.
- `PodPoller`: single shared poll, cached snapshot, change diffing, `updateCharacteristic` push.
- `WriteQueue`: per-side debounce, coalescing, optimistic state, confirm reads.
- Thermostat service per side.
- Offline handling across the daily reboot — note this is *not* HAP "No Response" by default;
  see docs/HOMEKIT.md for why `updateCharacteristic(c, new Error())` does not work.

**Done when:** paired in the Home app, both sides controllable, state survives a Pod reboot.

## M3 — Correctness hardening

The things that make it trustworthy rather than a demo.

- Keep-alive so "on" does not silently expire after 12 hours.
- Away-mode write guard for the both-sides coupling.
- Temperature rounding that does not make the Home slider jitter.
- Load check: no new franken timeouts in the Pod's logs versus baseline.

**Done when:** the plugin runs unattended for a week with no manual intervention.

## M4 — Everything else worth exposing

- Away Mode switch per side.
- Skip Alarm switch per side (via `scheduleOverrides.alarm.expiresAt`).
- Alarm event as a StatelessProgrammableSwitch plus a Dismiss switch, with scheduled
  fast-poll windows so short alarms are not missed.
- Hub connection sensor so outages are visible as data rather than as No Response.
- Occupancy sensor per side, auto-gated on `biometrics.enabled`.
- Hub accessory: prime switch, water-low sensor, LED lightbulb.

## M5 — Release

- README with setup instructions and the biometrics/occupancy caveats.
- `config.schema.json` polished for the Homebridge UI.
- Publish to npm, verify discoverability in Homebridge UI.

## Explicit non-goals

- Running on the Pod itself. The Pod reboots daily and is memory-constrained; the bridge
  belongs on stable always-on hardware.
- Schedule editing from HomeKit. No sane HomeKit model for a per-weekday temperature curve,
  and every write rebuilds all jobs on the Pod.
- Exposing `/api/jobs` (reboot, update) or `/api/execute`.
- Tap gestures as HomeKit buttons — the counters are not reachable over HTTP at all
  (see `docs/POD-API.md`). Would need an upstream change first.
- Anything that depends on Eight Sleep's cloud API.

## Possible upstream contributions to free-sleep

Not required for anything above, but they would each make this plugin better:

- **SSE for device status.** `FrankenMonitor` already keeps a fresh snapshot in memory and
  refreshes it every 2 s (Pod 4/5) or 60 s (Pod 3). Exposing it as
  `GET /api/deviceStatus/stream` would let clients drop polling entirely. Useful to Home
  Assistant users too.
- **Expose `taps` over HTTP**, which would unlock tap-to-trigger-a-scene.
- **Persist presence**, or report a "presence is unknown" state after restart, instead of
  defaulting to `present: false`.
