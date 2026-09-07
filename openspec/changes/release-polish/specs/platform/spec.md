## ADDED Requirements

### Requirement: Each published service has a distinct ConfiguredName, seeded once and never rewritten

Every HAP service the platform publishes — on every side accessory and on the hub accessory —
SHALL carry a `ConfiguredName` optional characteristic, so that the Apple Home app can show a
distinct label per service tile on a bridged, multi-service accessory rather than falling back to
the one label it derives from the accessory's own display name.

`ConfiguredName` SHALL be added to a service (via HAP's optional-characteristic mechanism, not by
relying on it being already declared) and given an initial value exactly once, at the moment that
service is first constructed for a given accessory. The initial value SHALL be a label distinct
from every other service's label on the same accessory, derived from the unified per-service
naming convention this capability defines.

Once `ConfiguredName` has been added to a service, the platform SHALL NOT set its value again on
any later construction of that same service — whether on a later poll, a later restart, or any
other event. A value a controller (the Home app) has written to the characteristic SHALL persist
exactly as it does today for any other controller-writable characteristic, undisturbed by the
plugin's own restart or reconstruction of that service.

#### Scenario: A service published for the first time gets a distinct default label

- **WHEN** a service is constructed for an accessory that has never carried that service before
- **THEN** the service's `ConfiguredName` characteristic is added and set to that service's
  unified-convention label, distinct from every other service's label on the same accessory

#### Scenario: A service already carrying ConfiguredName is left untouched on reconstruction

- **WHEN** a service is constructed for an accessory whose cached state already includes a
  `ConfiguredName` characteristic for that service, whether still at its seeded default or
  renamed by a controller
- **THEN** the platform does not set the characteristic's value, and the existing value — default
  or user-renamed — is served unchanged

#### Scenario: A controller rename survives a plugin restart

- **WHEN** a controller has written a custom value to a service's `ConfiguredName` and the plugin
  is later restarted
- **THEN** the service reports the controller-written value, not its original seeded default

#### Scenario: Upgrading a paired install adds ConfiguredName without disturbing existing renames

- **WHEN** an already-paired accessory is restored from the Homebridge accessory cache after an
  upgrade to a plugin version carrying this requirement, for a service that did not carry
  `ConfiguredName` in any earlier version
- **THEN** the service gets `ConfiguredName` added and seeded to its unified-convention default on
  that restart, and no other characteristic's value or any accessory-level display name is changed
  as a result
