# Roadmap

Milestones map 1:1 to GitHub milestones, and every bullet below is a tracked issue. Each
milestone was independently shippable — a working, paired HomeKit accessory existed from the
end of M2 onward. **M1–M4 are complete** (each has an archived `openspec/changes/archive/`
change); M5 is in progress.

Design rationale lives in [POD-API.md](POD-API.md) (what the Pod actually does) and
[HOMEKIT.md](HOMEKIT.md) (how we model it in HAP). Several non-obvious decisions are recorded
there rather than in the issues. [CHANGELOG.md](../CHANGELOG.md) has the user-facing summary of
what shipped in each release.

## M1 — Foundations ✅

Repo, build, and a typed client that can talk to a real Pod. No HomeKit yet.

- #1 Build tooling: ESLint, vitest, CI on Node 22/24/26.
- #2 Vendor Pod types from free-sleep's zod schemas.
- #3 Capture real Pod fixtures.
- #4 `PodClient`: typed HTTP client with timeout, dedupe, retry policy.
- #5 Stateful mock Pod as the executable spec.
- #6 Temperature conversion and `TargetTemperature` props.

**Done when:** `npm test` is green and a smoke script can read live status from the real Pod. —
done.

## M2 — Core thermostat ✅

The minimum viable plugin: each side of the bed as a HomeKit thermostat.

- #7 Dynamic platform, accessory topology, and config schema.
- #8 `PodPoller`: single shared poll, cached snapshot, change diffing.
- #9 Thermostat service per side.
- #10 `WriteQueue`: debounce, coalesce, optimistic overlay.
- #11 Offline handling across the daily reboot — note this is *not* HAP "No Response" by
  default; see [HOMEKIT.md](HOMEKIT.md) for why `updateCharacteristic(c, new Error())` is a
  no-op in an `onGet`-based plugin.

**Done when:** paired in the Home app, both sides controllable, state survives a Pod reboot. —
done; released as v0.1.0.

## M3 — Correctness hardening ✅

The things that make it trustworthy rather than a demo.

- #12 Keep-alive so "on" does not silently expire after 12 hours.
- #13 Away-mode write guard for the both-sides coupling.
- #14 Eliminate Home app temperature slider jitter.
- #15 Load check: no new franken timeouts on the Pod.

**Done when:** the plugin runs unattended for a week with no manual intervention. — done;
released as v0.2.0.

## M4 — Everything else worth exposing ✅

- #16 Alarm event and dismiss, with scheduled fast-poll.
- #17 Skip Next Alarm switch per side (via `scheduleOverrides.alarm.expiresAt`, **not**
  `.disabled` — see [POD-API.md](POD-API.md)).
- #18 Away Mode switch per side.
- #19 Occupancy sensor per side.
- #20 Hub accessory: water, prime, LED, test alarm, server fault.

Released as v0.3.0. Real-hardware confirmation of this milestone's own behavior (slider drag,
occupancy transitions, hub extras, alarm timing, settings switches) remains open, tracked in
#36 (see README's "Honesty caveat" section).

## M5 — Release (in progress)

- #21 README, config reference, and honest feature caveats — this change (`release-polish`).
- #22 Publish to npm and verify Homebridge UI discoverability — published (0.1.0/0.2.0/0.3.0 all
  live); exact-name UI search confirmed by research (`plugins.service.ts`'s scoped-package
  short-circuit), backend-confirmed / frontend-inferred; a human confirmation of the frontend
  search on a real Homebridge UI, and **optionally filing the verified-plugin application**
  (ready-to-file checklist: `docs/verified-plugin-application.md`), remain open follow-ups —
  filing itself is a deliberate action for the tech lead, not automated by this change.
- #49 Distinct `ConfiguredName` per HAP service, so every tile in the Home app shows its own
  label instead of a shared accessory-name fallback — this change (`release-polish`).

The repo is **private** until this milestone is otherwise complete. Flip it with
`gh repo edit caseyWebb/homebridge-free-sleep --visibility public` as the last M5 action, once
#21/#22/#49 are all done.

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

Tracked in #23. Not required for anything above, but each would make this plugin better —
the highest-value one by far is exposing `FrankenMonitor`'s existing in-memory snapshot as an
SSE stream, which would remove polling entirely.
