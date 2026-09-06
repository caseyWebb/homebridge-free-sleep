## Purpose

Defines the dynamic-platform lifecycle that publishes and maintains the plugin's three
bridged HomeKit accessories — their identity, their survival across a Homebridge restart,
and the startup guard that keeps the plugin inert until it is configured.

## ADDED Requirements

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

### Requirement: Exactly three bridged accessories, each carrying only AccessoryInformation

When `sides` is `'both'` (the default) and `host` is configured, the platform SHALL publish
exactly three bridged accessories: `Pod Left`, `Pod Right`, and `Pod` (the hub). After this
change, every one of the three SHALL carry only the `AccessoryInformation` service — no
thermostat, sensor, switch, or any other service exists yet.

#### Scenario: Fresh install publishes three accessories

- **WHEN** the platform starts with `host` configured, `sides: 'both'`, and no accessories
  in the Homebridge cache
- **THEN** exactly three accessories are registered, named `Pod Left`, `Pod Right`, and
  `Pod`, and each has exactly one service: `AccessoryInformation`

#### Scenario: No non-information service is added

- **WHEN** any of the three accessories is inspected, at any point after this change is
  applied
- **THEN** it exposes no service other than `AccessoryInformation`

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

### Requirement: Restoring from the accessory cache never duplicates, and prunes what is no longer enabled

On every launch, the platform SHALL reconcile the Homebridge accessory cache against the
currently-enabled set of accessories and services rather than unconditionally creating new
ones. An accessory whose UUID is already in the cache SHALL be reused, not re-created and
not re-registered. Any service present on a cached accessory whose subtype is not part of
the currently-enabled set SHALL be removed from that accessory, without removing the
accessory itself or its `AccessoryInformation` service.

#### Scenario: Unchanged config restarts without duplication

- **WHEN** the platform restarts with the same `host` and `sides` configuration as the
  previous launch, and all expected accessories are already in the Homebridge cache
- **THEN** no new accessory is registered, no cached accessory is unregistered, and the set
  of accessory UUIDs after restart is identical to the set before restart

#### Scenario: A no-longer-enabled service is pruned on restore

- **WHEN** a cached accessory carries a service whose subtype is not in the current
  enabled set for that accessory
- **THEN** that service is removed from the accessory during restore, and the accessory's
  `AccessoryInformation` service and its other still-enabled services are unaffected

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
