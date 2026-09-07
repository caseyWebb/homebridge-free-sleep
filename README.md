# homebridge-free-sleep

Control an Eight Sleep Pod from Apple Home — **locally**, with no Eight Sleep account and no
cloud.

## What this is

[free-sleep](https://github.com/throwaway31265/free-sleep) replaces the firmware on an Eight
Sleep Pod with an open-source server that runs on the Pod itself and exposes a local REST
API. This plugin bridges that API into HomeKit.

Every other Eight Sleep HomeKit plugin authenticates against Eight Sleep's **cloud** with
your account credentials. That is exactly what free-sleep exists to avoid, and it does not
work at all on a Pod that has been firewalled off from the internet — which is the
recommended free-sleep setup. This plugin talks only to your Pod, on your LAN.

## Status: v0.1.0 (MVP)

This is a first, minimal release: **each side of the bed as a HomeKit thermostat** (Off/Auto,
55–110°F) driven from a live cache of the Pod's status, plus a **"Pod Connection" contact
sensor** on the hub accessory that reports reachability and handles the Pod's daily reboot
gracefully (last-known values served through the outage; the sensor flags it; nothing throws
"No Response" for a routine restart). Implemented and tested against **free-sleep v2.1.5**.

Not yet included: alarms, away mode, occupancy, and the rest of the hub accessory (water low,
prime, LED, test alarm). See [docs/ROADMAP.md](docs/ROADMAP.md) for what's planned (milestone
M4) and why some things are deliberately non-goals.

### Honesty caveat — read this before installing

This plugin has been extensively tested against a behavioral mock of the Pod's API and
against real API responses captured from a physical Pod 3, and it has been smoke-verified
read-only against real hardware (reachability, status shape, and latency all confirmed live).

**It has not yet been verified end-to-end with a paired Apple Home app.** That verification —
pairing the plugin, controlling a real bed from the Home app, and confirming behavior across
an actual daily reboot — is tracked in
[#9](https://github.com/caseyWebb/homebridge-free-sleep/issues/9) (thermostat service) and
[#11](https://github.com/caseyWebb/homebridge-free-sleep/issues/11) (offline handling).
Consider this release **pre-release / use-at-your-own-risk** until those close.

## Requirements

- An Eight Sleep Pod running [free-sleep](https://github.com/throwaway31265/free-sleep)
  (tested against Pod 3 / free-sleep 2.1.5; Pod 1 and 2 are not supported by free-sleep).
- Node >=22 and Homebridge 2.x, on **separate always-on hardware** — a NAS, a Mac mini, a Pi.
  Not the Pod: it reboots daily and is memory-constrained.
- The Pod reachable on your LAN. A **static DHCP reservation for the Pod is strongly
  recommended** — this plugin identifies the Pod by the configured hostname/IP, and an address
  that changes underneath it will look like a permanent outage.

## Install

```sh
npm install -g @caseywebb/homebridge-free-sleep
```

Or, once published, search for "Free Sleep" in the Homebridge UI's plugin search and install
from there.

## Configuration

Minimal config — everything but `host` is optional:

```json
{
  "platforms": [
    {
      "platform": "FreeSleep",
      "host": "192.168.1.50"
    }
  ]
}
```

`sides` lets you publish only one side if the other is unused:

```json
{
  "platforms": [
    {
      "platform": "FreeSleep",
      "host": "192.168.1.50",
      "sides": "left"
    }
  ]
}
```

### Config keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `host` | string | *(required)* | Pod's LAN hostname or IP. Normalized to lowercase. |
| `sides` | `'both'` \| `'left'` \| `'right'` | `'both'` | Which side accessories to publish. |
| `pollIntervals.*` | object | see `config.schema.json` | Advanced poll/write timing overrides (base/fast/slow poll intervals, backoff ceiling, write debounce). Most installs should leave these alone. |
| `writeSettleMs` | number (ms) | `15000` | How long a write's optimistic value is protected from being overwritten by an in-flight poll. |
| `noResponseAfterMs` | number (ms) | `600000` | How long the Pod must be unreachable before thermostat reads start throwing instead of serving last-known values. `0` disables escalation. |
| `occupancySource` | `'none'` \| `'presence'` \| `'vitals'` | `'none'` | **Reserved — no effect yet.** Planned for M4 (#19). |
| `waterLowSensorType` | `'contact'` \| `'leak'` | `'contact'` | **Reserved — no effect yet.** Planned for M4 (#20). |
| `keepAlive` | boolean | `true` | While a side is on, periodically re-posts its remaining time so the Pod's 12-hour `isOn` duration never silently expires. `false` disables the component entirely — no timer, no writes. |
| `keepAliveMs` | number (ms) | `43200000` (12h) | The duration re-posted as a side's remaining time when it is re-armed, matching the Pod's own 12-hour duration. |
| `keepAliveThresholdMs` | number (ms) | `1800000` (30min) | A side is re-armed once its remaining time drops below this. Must be strictly less than `keepAliveMs`; the config UI cannot enforce that, so an invalid combination fails loudly at Homebridge startup instead. Minimum `120000` (2min) — below that, the plugin's own internally-derived check cadence can no longer guarantee it catches every side before it expires. |
| `awayModeWritePolicy` | `'mirror'` \| `'block'` | `'mirror'` | Governs a write to one side while either side has away mode on (the Pod itself always applies such a write to both sides). `'mirror'` (default) lets the write through and issues a second real `POST /api/deviceStatus` to the other side, updating its cached state to match, so HomeKit shows the truth immediately. `'block'` refuses the write before it reaches the Pod, surfacing "not allowed" in the Home app instead. Either way, an away-mode change made outside this plugin (e.g. free-sleep's own web UI) is only detected on the next settings poll (default every 300s), not sooner. |

Reserved keys are validated now (a typo fails loudly) so a future release can start reading
them without a config migration, but they currently have no effect.

## Security

free-sleep's API has **no authentication**. Anything on your LAN can control the bed. This
plugin does not change that — do not expose port 3000 to the internet.

## Documentation

- [docs/POD-API.md](docs/POD-API.md) — source-verified notes on free-sleep's API and the
  constraints that shape this plugin.
- [docs/HOMEKIT.md](docs/HOMEKIT.md) — HAP service/characteristic modeling decisions and the
  HomeKit-side gotchas they work around.
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones, what's not built yet, and non-goals.
- `openspec/` — spec-driven change proposals. `openspec list` to see what is in flight.

## Licence

MIT
