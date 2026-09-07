# Changelog

All notable user-facing changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match npm/GitHub releases
(`gh release view v<version>`).

## [Unreleased]

### Added

- Every HAP service on every accessory now carries a distinct `ConfiguredName`, seeded once at
  construction and never overwritten afterward — controller (Home app) renames persist exactly
  like accessory-level renames already do. Fixes tiles that previously all showed the same
  shared accessory-name label (e.g. every switch under a side accessory reading "Casey") instead
  of a meaningful per-service name ("Away Mode", "Skip Next Alarm", "Dismiss Alarm", "Prime",
  "LED", "Pod Connection", "Water Level", "Occupancy", …). (#49)

### Documentation

- README rewritten: a complete, verified config-key reference table, a refreshed feature tour
  matching the full M1–M4 shipped capability set, updated honesty/caveats section tracing every
  open item to issue #36, and an install section with the exact Homebridge UI search instruction
  (type the scoped package name directly — generic terms don't find it yet, which is an npm
  search-index lag, not a metadata problem). (#21)
- `docs/HOMEKIT.md`: new "Service ConfiguredName" section documenting the seeding mechanism and
  the short-label convention. `docs/ROADMAP.md`: M1–M4 marked complete, M5 reframed as in
  progress. (#21, #49)
- New `docs/verified-plugin-application.md` — a ready-to-file Homebridge verified-plugin
  application checklist, transcribing the discoverability/verification research from issue #22.
  Filing the application itself is a deliberate follow-up action, not automated by this change.
  (#22)

## [0.3.0] — 2026-09-07 "Everything else worth exposing"

M4 complete — the full HomeKit surface from `docs/HOMEKIT.md`'s service table.

### Added

- **Occupancy sensor per side** (#19): `occupancySource: 'presence' | 'vitals'` (default
  `'none'` — zero polling until you opt in), with honest proof-of-life semantics: the sensor
  reports `StatusActive` only after observing a real in-bed detection, so a dead detection
  stream can never masquerade as "Not Occupied".
- **Alarm events** (#16): a per-side `StatelessProgrammableSwitch` fires when the vibration
  alarm starts (a ±3min/3s fast-poll window arms around each scheduled alarm), plus a Dismiss
  switch that always works — even under away-mode `'block'`.
- **Away Mode & Skip Next Alarm switches** (#17, #18): the rare, user-initiated expensive
  settings writes, with debounce, rate limits, no-op suppression, and the guard-ordering race
  closed.
- **Hub accessory extras** (#20): water-low sensor (contact or leak style), Prime switch, LED
  brightness, per-side Test Alarm switches (deliberately per-side — a test must never vibrate a
  sleeping partner), and a server-fault sensor.

892 tests; every change went through adversarial review with executed findings. Verification on
real hardware tracked in #36.

## [0.2.0] — 2026-09-07 "Correctness hardening"

M3: the plugin now protects sleepers from three classes of silent wrongness.

### Added

- **Keep-alive** (#12): a side turned on no longer silently expires after the Pod's 12-hour
  timer — it is re-armed below a threshold, via writes that are structurally unable to turn the
  bed off, with an explicit user off always winning any race, and a freshness guard so a stale
  cache can never re-ignite a side you turned off.
- **Away-mode write guard** (#13): the Pod's both-sides coupling (either side away → writes hit
  both) is now handled: default `mirror` policy tells HomeKit the truth about both sides;
  `block` refuses writes cleanly with a proper HomeKit error.
- **Anti-jitter** (#14), proven by a 56-degree continuous drag test racing stale observations —
  zero regressing pushes; plus the out-of-range target clamp (#33).

477 tests, CI green on Node 22/24/26. Live Pod load check (#15) pending the next hardware
session.

## [0.1.0] — 2026-09-06 "MVP"

First release: each side of the bed as a HomeKit thermostat (Off/Auto, 55–110°F) with a shared
poller/cached snapshot, coalescing write queue, and graceful handling of the Pod's daily reboot
(Pod Connection contact sensor on the hub accessory; last-known values through outages).

Implemented against free-sleep v2.1.5, tested against a behavioral mock encoding the Pod's
verified quirks plus real captured Pod 3 API responses, and smoke-verified read-only against
real hardware. Not yet verified with a paired Apple Home app at time of release — tracked in
#9/#11.

[Unreleased]: https://github.com/caseyWebb/homebridge-free-sleep/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/caseyWebb/homebridge-free-sleep/releases/tag/v0.3.0
[0.2.0]: https://github.com/caseyWebb/homebridge-free-sleep/releases/tag/v0.2.0
[0.1.0]: https://github.com/caseyWebb/homebridge-free-sleep/releases/tag/v0.1.0
