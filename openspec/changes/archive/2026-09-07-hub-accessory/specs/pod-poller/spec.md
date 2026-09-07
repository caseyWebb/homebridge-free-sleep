## MODIFIED Requirements

### Requirement: One shared poll per endpoint class serves every reader

The plugin SHALL issue at most one recurring poll per API endpoint class, regardless of how
many accessories, services, or characteristics depend on the data. Consumers SHALL obtain
values from the cached snapshot rather than by requesting a read.

The endpoint classes polled by this capability SHALL be the device status, the settings, the
schedules, the services, and the subsystem-health endpoints. The subsystem-health class SHALL
be enabled only while the server-fault sensor is configured on; while disabled, its schedule
SHALL continue to run but SHALL issue no request, exactly as this capability's existing
enabled-predicate extension point already allows for any class. The set of classes SHALL
remain extensible by describing a new class — its endpoint, its base interval, and the
condition under which it is enabled — without altering the scheduling, jitter, backoff, or
in-flight machinery.

#### Scenario: Many consumers, one request

- **WHEN** every service on both sides and the hub depends on device status, and one polling
  period elapses
- **THEN** the Pod receives exactly one device-status request for that period

#### Scenario: Classes are scheduled independently

- **WHEN** the device-status class and the settings class are both running
- **THEN** each is requested on its own cadence, and neither's timing is affected by the
  other's

#### Scenario: The subsystem-health class polls only while its sensor is enabled

- **WHEN** the server-fault sensor is disabled and a polling period for the subsystem-health
  class elapses
- **THEN** no subsystem-health request is issued, and the class's own schedule continues
  running so that enabling the sensor later resumes polling without restarting the plugin

#### Scenario: Enabling the server-fault sensor resumes subsystem-health polling

- **WHEN** the server-fault sensor is enabled at startup
- **THEN** the subsystem-health class is polled on its own cadence from that launch onward

### Requirement: Poll intervals are configurable within enforced bounds

The base interval SHALL be approximately 30 seconds for the device-status class and
approximately 5 minutes for the settings, schedules, services, and subsystem-health classes.
Both the fast and slow base intervals SHALL be configurable.

A configured device-status interval below 5 seconds SHALL be rejected and replaced with the
5 second minimum, and a configured slow-class interval below 60 seconds SHALL likewise be
raised, with the substitution logged. Independently of configuration, no computed interval
SHALL ever be shorter than a hard floor of 3 seconds.

#### Scenario: An unsafe configured interval is clamped and logged

- **WHEN** the device-status interval is configured to 1 second
- **THEN** polling proceeds at the 5 second minimum and a warning naming the configured and
  effective values is logged

#### Scenario: The hard floor holds regardless of caller

- **WHEN** any mechanism requests an interval below 3 seconds
- **THEN** the effective interval is 3 seconds

#### Scenario: The subsystem-health class shares the slow-class interval configuration

- **WHEN** the slow-class base interval is configured to a non-default value
- **THEN** the subsystem-health class, like settings, schedules, and services, polls at that
  configured interval when its sensor is enabled
