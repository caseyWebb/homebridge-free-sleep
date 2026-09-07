## MODIFIED Requirements

### Requirement: Exactly three bridged accessories, each carrying the services its role enables

When `sides` is `'both'` (the default) and `host` is configured, the platform SHALL publish
exactly three bridged accessories: `Pod Left`, `Pod Right`, and `Pod` (the hub). Each SHALL
carry `AccessoryInformation` plus exactly the services its role, and — for the hub only — its
current configuration, currently enable: a side accessory carries its thermostat; the hub
carries the connection contact sensor and the water-level sensor unconditionally, plus
whichever of the prime switch, LED lightbulb, test-alarm switch, and server-fault sensor its
configuration currently enables. No accessory SHALL carry a service outside that enabled set.

#### Scenario: Fresh install publishes three accessories with their services

- **WHEN** the platform starts with `host` configured, `sides: 'both'`, and no accessories in
  the Homebridge cache
- **THEN** exactly three accessories are registered, named `Pod Left`, `Pod Right`, and `Pod`;
  each side accessory has `AccessoryInformation` and one thermostat; and the hub has
  `AccessoryInformation`, one contact sensor, and one water-level sensor

#### Scenario: No service outside the enabled set is added

- **WHEN** any of the three accessories is inspected after startup
- **THEN** it exposes only `AccessoryInformation` and the services its role and (for the hub)
  its configuration enable, and in particular no side accessory carries a sensor and the hub
  carries no thermostat

#### Scenario: Narrowing sides removes that side's services with its accessory

- **WHEN** the platform previously ran with `sides: 'both'` and is restarted with `sides:
  'left'`
- **THEN** `Pod Right` and the thermostat it carried are gone, and `Pod Left` and the hub keep
  their services

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

#### Scenario: Disabling a hub service in config prunes it without touching the hub accessory

- **WHEN** the hub previously carried the LED lightbulb (LED enabled in configuration) and the
  platform restarts with LED disabled
- **THEN** the LED lightbulb is removed from the hub accessory during restore, and the hub
  accessory itself, its connection sensor, and its water-level sensor are unaffected
