## Context (delta rationale, not part of the synced spec)

`platform`'s existing "Exactly three bridged accessories, each carrying the services its role
currently enables" requirement already frames the enabled-service set as something later
changes grow; this delta is exactly that growth, conditioned on config the way `sides` already
conditions which accessories exist at all. The restore/prune requirement's mechanism
(`enabledServiceKeysFor`, `pruneServices`) needs no change beyond what it is given to compute
from; the requirement text about *how* pruning works is unmodified. The routing requirement
gains one more destination field, following its own existing shape exactly.

## MODIFIED Requirements

### Requirement: Exactly three bridged accessories, each carrying the services its role currently enables

When `sides` is `'both'` (the default) and `host` is configured, the platform SHALL publish
exactly three bridged accessories: `Pod Left`, `Pod Right`, and `Pod` (the hub). Each SHALL
carry `AccessoryInformation` plus exactly the services its role currently enables: a side
accessory carries its thermostat and, when `occupancySource` is not `'none'`, an occupancy
sensor; the hub carries the connection contact sensor. No accessory SHALL carry a service
outside that enabled set.

#### Scenario: Fresh install with occupancy configured publishes the sensor per side

- **WHEN** the platform starts with `host` configured, `sides: 'both'`, `occupancySource` set
  to `'presence'` or `'vitals'`, and no accessories in the Homebridge cache
- **THEN** exactly three accessories are registered; each side accessory has
  `AccessoryInformation`, one thermostat, and one occupancy sensor; and the hub has
  `AccessoryInformation` and one contact sensor

#### Scenario: Fresh install with occupancy off publishes no occupancy sensor

- **WHEN** the platform starts with `occupancySource: 'none'` (the default)
- **THEN** neither side accessory carries an occupancy sensor, and every other aspect of the
  three-accessory topology is unchanged from before this capability existed

#### Scenario: No service outside the enabled set is added

- **WHEN** any of the three accessories is inspected after startup
- **THEN** it exposes only `AccessoryInformation` and the services its role and configuration
  currently enable, and in particular the hub carries no occupancy sensor and no thermostat

### Requirement: Restoring from the accessory cache never duplicates, and prunes what is no longer enabled

On every launch, the platform SHALL reconcile the Homebridge accessory cache against the
currently-enabled set of accessories and services rather than unconditionally creating new
ones — where "currently enabled" for a side's services now depends on both its role and the
configured `occupancySource`, exactly as it already depends on `sides` for which accessories
exist at all. An accessory whose UUID is already in the cache SHALL be reused, not re-created
and not re-registered. Any service present on a cached accessory whose subtype is not part of
the currently-enabled set SHALL be removed from that accessory, without removing the accessory
itself or its `AccessoryInformation` service.

#### Scenario: Unchanged config restarts without duplication

- **WHEN** the platform restarts with the same `host`, `sides`, and `occupancySource`
  configuration as the previous launch, and all expected accessories are already in the
  Homebridge cache
- **THEN** no new accessory or service is registered, no cached accessory or service is
  unregistered, and the set of accessory UUIDs and each accessory's service set after restart
  is identical to before restart

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

#### Scenario: A no-longer-enabled service is pruned on restore

- **WHEN** a cached accessory carries a service whose subtype is not in the current
  enabled set for that accessory
- **THEN** that service is removed from the accessory during restore, and the accessory's
  `AccessoryInformation` service and its other still-enabled services are unaffected

### Requirement: Observed changes are routed to the services that publish them

The platform SHALL subscribe to the cached view's change notifications once, and SHALL route
each reported change to the service that publishes the affected characteristic — a side's
change to that side's thermostat or occupancy sensor, a reachability change to the hub's
connection sensor. A change to a field no published service publishes SHALL be ignored without
error.

Routing SHALL be the only mechanism by which a published characteristic is updated from
observed state; no service SHALL poll or re-read on its own.

#### Scenario: A side change reaches only that side

- **WHEN** an observation changes the left side's target temperature
- **THEN** the left side's thermostat is updated and the right side's thermostat receives no
  update

#### Scenario: A reachability change reaches the hub

- **WHEN** an observation changes the Pod's reachability
- **THEN** the hub's connection sensor is updated and no thermostat characteristic is updated as
  a result

#### Scenario: An unpublished field is ignored

- **WHEN** a change is reported for a field no published service publishes
- **THEN** no update is pushed and no error is raised

#### Scenario: A side's occupancy change reaches only that side's occupancy sensor

- **WHEN** an observation changes the left side's vitals-derived occupancy or its presence
  trust flag
- **THEN** the left side's occupancy sensor is updated, the right side's occupancy sensor
  receives no update, and no thermostat characteristic is updated as a result

#### Scenario: An occupancy change is ignored when the sensor is not published

- **WHEN** `occupancySource` is `'none'` and an observation nonetheless reports a presence or
  vitals value (for example, because a previous configuration's poll is still draining)
- **THEN** no update is pushed anywhere and no error is raised

#### Scenario: A failing service does not stop the others

- **WHEN** one service, including an occupancy sensor, throws while handling a change
  notification
- **THEN** the other services — including the other side's occupancy sensor — still receive
  that notification, the failure is logged, and subsequent notifications are still delivered to
  all of them
