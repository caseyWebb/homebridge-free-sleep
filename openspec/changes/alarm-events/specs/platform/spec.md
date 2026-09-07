## MODIFIED Requirements

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

#### Scenario: A failing service does not stop the others

- **WHEN** one service throws while handling a change notification
- **THEN** the other services still receive that notification, the failure is logged, and
  subsequent notifications are still delivered to all of them
