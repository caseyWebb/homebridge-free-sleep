# homebridge-free-sleep

Control an Eight Sleep Pod from Apple Home — **locally**, with no Eight Sleep account and no
cloud.

> **Status: in development.** Nothing works yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

## What this is

[free-sleep](https://github.com/throwaway31265/free-sleep) replaces the firmware on an Eight
Sleep Pod with an open-source server that runs on the Pod itself and exposes a local REST
API. This plugin bridges that API into HomeKit.

Every other Eight Sleep HomeKit plugin authenticates against Eight Sleep's **cloud** with
your account credentials. That is exactly what free-sleep exists to avoid, and it does not
work at all on a Pod that has been firewalled off from the internet — which is the
recommended free-sleep setup. This plugin talks only to your Pod, on your LAN.

## Requirements

- An Eight Sleep Pod 3 / 4 / 5 running [free-sleep](https://github.com/throwaway31265/free-sleep)
  (Pod 1 and 2 are not supported by free-sleep).
- The Pod reachable on your LAN, ideally with a static DHCP reservation.
- Homebridge 2.x on **separate always-on hardware** — a NAS, a Mac mini, a Pi. Not the Pod:
  it reboots daily and is memory-constrained.

Occupancy and vitals additionally require free-sleep's biometrics pipeline to be enabled, and
that only produces data when the Pod cannot reach Eight Sleep's cloud. See
[docs/POD-API.md](docs/POD-API.md).

## Security

free-sleep's API has **no authentication**. Anything on your LAN can control the bed. This
plugin does not change that — do not expose port 3000 to the internet.

## Documentation

- [docs/POD-API.md](docs/POD-API.md) — source-verified notes on free-sleep's API and the
  constraints that shape this plugin.
- [docs/HOMEKIT.md](docs/HOMEKIT.md) — HAP service/characteristic modeling decisions and the
  HomeKit-side gotchas they work around.
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones and non-goals.
- `openspec/` — spec-driven change proposals. `openspec list` to see what is in flight.

## Licence

MIT
