# platform Specification

## Purpose

Defines the dynamic-platform lifecycle that publishes and maintains the plugin's three
bridged HomeKit accessories — their identity, their survival across a Homebridge restart,
and the startup guard that keeps the plugin inert until it is configured.

## Requirements

### Requirement: The platform will not start without a configured host

The platform SHALL require a configured Pod host to do anything. When `host` is missing
from the platform config, the constructor SHALL log a clear, actionable error and SHALL NOT
register, restore, prune, or unregister any accessory — including accessories already
present from a previous launch.

#### Scenario: Host missing at startup

- **WHEN** the platform is constructed with a config block that has no `host`
- **THEN** it logs an error naming the missing configuration, and it neither calls to
  register new accessories nor unregisters any previously-cached accessory

#### Scenario: Host present at startup

- **WHEN** the platform is constructed with a config block containing a non-empty `host`
- **THEN** it proceeds with normal accessory topology, restore, and prune behavior

#### Scenario: Cached accessories survive a temporarily-missing host

- **WHEN** the platform starts with `host` missing, and accessories from a previous launch
  (when `host` was configured) exist in the Homebridge accessory cache
- **THEN** those cached accessories are left untouched — neither unregistered nor
  modified — so restoring `host` on a later launch can reclaim them without duplication

### Requirement: Exactly three bridged accessories, each carrying the services its role enables

When `sides` is `'both'` (the default) and `host` is configured, the platform SHALL publish
exactly three bridged accessories: `Pod Left`, `Pod Right`, and `Pod` (the hub). Each SHALL
carry `AccessoryInformation` plus exactly the services its role currently enables: a side
accessory carries its thermostat, its alarm programmable switch, and its dismiss switch; the
hub carries the connection contact sensor. No accessory SHALL carry a service outside that
enabled set.

#### Scenario: Fresh install publishes three accessories with their services

- **WHEN** the platform starts with `host` configured, `sides: 'both'`, and no accessories in
  the Homebridge cache
- **THEN** exactly three accessories are registered, named `Pod Left`, `Pod Right`, and `Pod`;
  each side accessory has `AccessoryInformation`, one thermostat, one alarm programmable switch,
  and one dismiss switch; and the hub has `AccessoryInformation` and one contact sensor

#### Scenario: No service outside the enabled set is added

- **WHEN** any of the three accessories is inspected after startup
- **THEN** it exposes only `AccessoryInformation` and the services its role enables, and in
  particular no side accessory carries a sensor and the hub carries no thermostat, alarm
  programmable switch, or dismiss switch

#### Scenario: Narrowing sides removes that side's services with its accessory

- **WHEN** the platform previously ran with `sides: 'both'` and is restarted with `sides:
  'left'`
- **THEN** `Pod Right` and the services it carried (including its alarm programmable switch and
  dismiss switch) are gone, and `Pod Left` and the hub keep their services

#### Scenario: Fresh install with occupancy configured publishes the sensor per side

- **WHEN** the platform starts with `host` configured, `sides: 'both'`, `occupancySource` set
  to `'presence'` or `'vitals'`, and no accessories in the Homebridge cache
- **THEN** exactly three accessories are registered; each side accessory has
  `AccessoryInformation`, one thermostat, one occupancy sensor, one alarm programmable switch,
  and one dismiss switch; and the hub has `AccessoryInformation` and one contact sensor

#### Scenario: Fresh install with occupancy off publishes no occupancy sensor

- **WHEN** the platform starts with `occupancySource: 'none'` (the default)
- **THEN** neither side accessory carries an occupancy sensor, and every other aspect of the
  three-accessory topology is unchanged from before this capability existed

#### Scenario: The hub's enabled set grows and shrinks with its own configuration

- **WHEN** the platform starts with the prime-switch, LED, test-alarm, and server-fault
  configuration values all enabled, and is later restarted with all four disabled
- **THEN** the hub carries all four additional services (plus the always-present connection
  and water-level sensors) on the first launch, and carries only the connection and
  water-level sensors on the second — with no accessory unregistered, since the hub itself
  still has enabled services

### Requirement: Restoring from the accessory cache never duplicates, and prunes what is no longer enabled

On every launch, the platform SHALL reconcile the Homebridge accessory cache against the
currently-enabled set of accessories and services rather than unconditionally creating new
ones. An accessory whose UUID is already in the cache SHALL be reused, not re-created and
not re-registered. Any service present on a cached accessory whose subtype is not part of
the currently-enabled set SHALL be removed from that accessory, without removing the
accessory itself or its `AccessoryInformation` service.

#### Scenario: Unchanged config restarts without duplication

- **WHEN** the platform restarts with the same `host`, `sides`, and hub-service configuration
  as the previous launch, and all expected accessories are already in the Homebridge cache
- **THEN** no new accessory is registered, no cached accessory is unregistered, and the set
  of accessory UUIDs after restart is identical to the set before restart

#### Scenario: A no-longer-enabled service is pruned on restore

- **WHEN** a cached accessory carries a service whose subtype is not in the current
  enabled set for that accessory
- **THEN** that service is removed from the accessory during restore, and the accessory's
  `AccessoryInformation` service and its other still-enabled services are unaffected

#### Scenario: Enabling occupancy on restart adds the service without duplicating others

- **WHEN** the platform previously ran with `occupancySource: 'none'` and is restarted with
  `occupancySource: 'presence'`
- **THEN** each enabled side accessory gains exactly one occupancy sensor, and its existing
  thermostat is unaffected and not duplicated

#### Scenario: Disabling occupancy on restart prunes the service

- **WHEN** the platform previously ran with a non-`'none'` `occupancySource` and is restarted
  with `occupancySource: 'none'`
- **THEN** the occupancy sensor is removed from every side accessory that carried it, and that
  accessory's `AccessoryInformation` and thermostat are unaffected

#### Scenario: Switching between non-none sources changes neither the accessory nor its service count

- **WHEN** the platform previously ran with `occupancySource: 'presence'` and is restarted with
  `occupancySource: 'vitals'`
- **THEN** the same occupancy sensor service is reused on each side accessory — it is neither
  removed nor duplicated — and only what drives its reported value changes

#### Scenario: Disabling a hub service in config prunes it without touching the hub accessory

- **WHEN** the hub previously carried the LED lightbulb (LED enabled in configuration) and the
  platform restarts with LED disabled
- **THEN** the LED lightbulb is removed from the hub accessory during restore, and the hub
  accessory itself, its connection sensor, and its water-level sensor are unaffected

### Requirement: Accessory identity is derived from the configured host, not runtime network state

Each accessory's UUID and its `AccessoryInformation.SerialNumber` SHALL be derived
deterministically from the *configured* host string and the accessory's role (left side,
right side, or hub) — never from a DHCP-assigned IP address, a MAC address, or any value
read from the Pod itself. The same configured host and role SHALL always yield the same
UUID and the same `SerialNumber`, across restarts and regardless of what address the host
name currently resolves to.

#### Scenario: Identity is stable across restarts

- **WHEN** the platform is restarted twice with an unchanged `host` configuration
- **THEN** each of the three accessories has the same UUID and the same
  `AccessoryInformation.SerialNumber` on both launches

#### Scenario: Identity is unaffected by DNS/IP changes

- **WHEN** the configured host is a name whose resolved IP address changes between two
  launches, with the configured host string itself unchanged
- **THEN** each accessory's UUID and `SerialNumber` are unchanged

#### Scenario: Changing the configured host changes identity

- **WHEN** the configured `host` value is changed to a different string
- **THEN** the derived UUIDs and `SerialNumber`s for all three accessories differ from
  those derived under the previous host — a deliberate new identity, documented as
  expected rather than a defect

### Requirement: The `sides` option controls which side accessories exist

`sides` SHALL accept exactly `'both'`, `'left'`, or `'right'`, defaulting to `'both'`. When
a side is not selected, that side's accessory SHALL NOT exist: if it is present in the
Homebridge cache from a prior configuration, it SHALL be unregistered.

#### Scenario: `sides: 'left'` excludes the right accessory

- **WHEN** the platform starts with `sides: 'left'`
- **THEN** `Pod Left` and `Pod` (hub) exist, and `Pod Right` is not registered

#### Scenario: `sides: 'right'` excludes the left accessory

- **WHEN** the platform starts with `sides: 'right'`
- **THEN** `Pod Right` and `Pod` (hub) exist, and `Pod Left` is not registered

#### Scenario: Narrowing `sides` removes the now-excluded accessory

- **WHEN** the platform previously ran with `sides: 'both'` (so `Pod Right` is in the
  Homebridge cache) and is restarted with `sides: 'left'`
- **THEN** `Pod Right` is unregistered during that startup, and it does not reappear on a
  subsequent restart with `sides: 'left'` unchanged

### Requirement: Display names are seeded once, at accessory creation, and never rewritten

When a side accessory (`Pod Left` or `Pod Right`) is created for the first time — meaning
its UUID is not already present in the Homebridge accessory cache — the platform SHALL
attempt to read the Pod's current settings once and, if that read succeeds before the
accessory is registered, SHALL seed the accessory's initial display name from that side's
configured name. If the read does not succeed before the accessory must be registered, the
accessory SHALL be created with a static fallback display name instead. Once an accessory
has been created, its display name SHALL NOT be changed by any later settings read, poll,
or restart, regardless of whether the Pod becomes reachable or its configured name changes.

#### Scenario: New accessory, Pod reachable

- **WHEN** a side accessory does not yet exist in the Homebridge cache, and a read of the
  Pod's settings for that side succeeds before the accessory is registered
- **THEN** the accessory is created with that side's configured name as its initial
  display name

#### Scenario: New accessory, Pod unreachable

- **WHEN** a side accessory does not yet exist in the Homebridge cache, and the settings
  read for that side does not succeed (the Pod is unreachable, or the read errors or does
  not complete) before the accessory must be registered
- **THEN** the accessory is created with a static fallback display name, and startup is not
  blocked waiting indefinitely for the Pod to become reachable

#### Scenario: Existing accessory is never renamed

- **WHEN** a side accessory already exists in the Homebridge cache, under any display name
- **THEN** no settings read is performed for the purpose of naming it, and its display name
  is left exactly as persisted — even on a later launch where the Pod is reachable and its
  configured name differs from the accessory's current display name

#### Scenario: No settings read when nothing needs naming

- **WHEN** all accessories the current configuration calls for already exist in the
  Homebridge cache
- **THEN** the platform does not read the Pod's settings during that startup

### Requirement: The platform owns the poll and write lifecycle, and observes the Pod before wiring handlers

The platform SHALL construct exactly one cached-snapshot store, one poller, one write path, and
one alarm-window scheduler per launch, and SHALL share the snapshot store across every
accessory and service it publishes. It SHALL perform its bootstrap observation of the Pod, and
SHALL wait for that bootstrap to settle, before registering any read or write handler — so that
the first read a controller makes has real data rather than a placeholder.

A bootstrap that fails or times out SHALL NOT prevent the platform from publishing its
accessories or from starting recurring polling.

When Homebridge shuts down, the platform SHALL stop polling, stop the write path, and stop the
alarm-window scheduler, leaving no pending timer and no in-flight work that could still touch
HomeKit.

#### Scenario: One poller serves every service

- **WHEN** the platform has started with both sides enabled and one polling period elapses
- **THEN** the Pod receives exactly one status request for that period, regardless of how many
  services are published

#### Scenario: Handlers are wired after the bootstrap settles

- **WHEN** the platform starts against a reachable Pod
- **THEN** the bootstrap observation has settled before the first read handler is registered,
  and the first read returns an observed value rather than a default

#### Scenario: An unreachable Pod does not block startup

- **WHEN** the platform starts against a Pod that never answers
- **THEN** the bootstrap settles at its deadline, all accessories are still published with their
  services, recurring polling is running, and no read fails

#### Scenario: Shutdown releases everything

- **WHEN** Homebridge shuts down
- **THEN** polling stops, the write path stops, the alarm-window scheduler stops, no timer
  remains scheduled, and the process can exit without an open handle

### Requirement: Observed changes are routed to the services that publish them

The platform SHALL subscribe to the cached view's change notifications once, and SHALL route
each reported change to the service that publishes the affected characteristic — a side's
temperature or power change to that side's thermostat, a side's alarm-vibration change to that
side's alarm services, and a reachability change to the hub's connection sensor. A change to a
field no published service publishes SHALL be ignored without error.

Routing SHALL be the only mechanism by which a published characteristic is updated from observed
state; no service SHALL poll or re-read on its own.

#### Scenario: A side change reaches only that side

- **WHEN** an observation changes the left side's target temperature
- **THEN** the left side's thermostat is updated and the right side's thermostat receives no
  update

#### Scenario: A side's alarm-vibration change reaches that side's alarm services

- **WHEN** an observation changes a side's alarm-vibrating state
- **THEN** that side's alarm programmable switch and dismiss switch are updated as their own
  requirements specify, and no other side's or the hub's services receive an update as a result

#### Scenario: A reachability change reaches the hub

- **WHEN** an observation changes the Pod's reachability
- **THEN** the hub's connection sensor is updated and no thermostat or alarm-service
  characteristic is updated as a result

#### Scenario: An unpublished field is ignored

- **WHEN** a change is reported for a field no published service publishes
- **THEN** no update is pushed and no error is raised

#### Scenario: A side's occupancy change reaches only that side's occupancy sensor

- **WHEN** an observation changes the left side's vitals-derived occupancy or its presence
  trust flag
- **THEN** the left side's occupancy sensor is updated, the right side's occupancy sensor
  receives no update, and no thermostat or alarm-service characteristic is updated as a result

#### Scenario: An occupancy change is ignored when the sensor is not published

- **WHEN** `occupancySource` is `'none'` and an observation nonetheless reports a presence or
  vitals value (for example, because a previous configuration's poll is still draining)
- **THEN** no update is pushed anywhere and no error is raised

#### Scenario: A failing service does not stop the others

- **WHEN** one service, including an occupancy sensor, throws while handling a change
  notification
- **THEN** the other services — including the other side's occupancy sensor and alarm services
  — still receive that notification, the failure is logged, and subsequent notifications are
  still delivered to all of them

### Requirement: A simulated Home-app session against a mock Pod stays within its request budget

The project SHALL include an in-process test that starts the whole platform — configuration,
accessories, services, poller and write path — against the stateful mock Pod through a fake
Homebridge interface, with no real Homebridge process, no real Pod and no paired controller,
and drives a simulated session under controlled time.

That session SHALL assert, at minimum, that a burst of reads across every published
characteristic causes no Pod request, that a rapid succession of target-temperature writes to
one side causes exactly one Pod write, and that a mock-Pod outage and recovery changes the
connection sensor exactly twice.

This test is the guardrail for the invariants no unit test can protect: it fails loudly if a
read handler is later made to contact the Pod, if write coalescing is lost, or if the connection
sensor starts flapping.

#### Scenario: A read burst costs nothing

- **WHEN** every characteristic of every published service is read repeatedly at the start of
  the session, and again later in it
- **THEN** the mock Pod's recorded request count is unchanged across each burst

#### Scenario: A drag is one write

- **WHEN** a rapid succession of target temperatures is written to one side
- **THEN** the mock Pod recorded exactly one write for that side, carrying the last value

#### Scenario: An outage is two transitions

- **WHEN** the mock Pod stops answering for long enough to span several polling attempts and
  then answers again
- **THEN** the connection sensor's value changed exactly twice, and every read during the outage
  returned a last-known value

#### Scenario: The session runs offline and deterministically

- **WHEN** the test is run with no network access and no Pod on the network
- **THEN** it passes deterministically, but takes tens of seconds of real wall-clock time rather
  than milliseconds — the mock Pod is reached over real HTTP, not simulated, and `PodClient`'s
  own retry backoff on a failed request is real, un-injected `setTimeout` time that no virtual
  clock accelerates (design.md, "The integration test: real HTTP, virtual clock"); only the
  poller's and write queue's own intervals, timeouts and expiries above that layer are driven by
  controlled time
