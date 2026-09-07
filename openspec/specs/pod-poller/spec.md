# pod-poller Specification

## Purpose

Decides when the plugin talks to the Pod at all: one shared, jittered, self-rescheduling poll
per endpoint class that feeds the cached snapshot, backs off when the Pod goes away, speeds up
when something is about to change, and stays within a request budget small enough that the
Pod's serialised hardware queue never notices us.

## Requirements

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

### Requirement: Every interval carries jitter from an injected randomness source

Each scheduled delay SHALL be the effective interval varied by up to ±10 %, so that the
plugin's polling cannot settle into lockstep with the Pod's own internal status loop, which
competes for the same hardware socket.

The randomness SHALL come from a source supplied to the poller rather than read from a global,
so that a test can make every delay exact.

#### Scenario: Successive delays differ

- **WHEN** several polling periods elapse with a real randomness source
- **THEN** the intervals between requests are not all identical, and each lies within ±10 % of
  the effective interval

#### Scenario: Tests can eliminate jitter

- **WHEN** the poller is given a randomness source that always returns its midpoint
- **THEN** every delay equals the effective interval exactly

### Requirement: A class never has two polls in flight

The poller SHALL NOT issue a request for an endpoint class while a request for that class is
still outstanding. A scheduled tick that comes due during an in-flight poll SHALL be skipped
rather than queued, so that a slow Pod produces fewer requests rather than a growing backlog.

The next delay for a class SHALL be measured from the moment its previous poll settles, not
from the moment it started.

#### Scenario: A slow poll suppresses the ticks it overruns

- **WHEN** a device-status request takes longer than three polling periods to settle
- **THEN** exactly one request was in flight throughout, and the next request is issued one
  interval after that request settled — not immediately, and not three times

#### Scenario: No backlog accumulates

- **WHEN** the Pod is slow for several minutes and then becomes fast again
- **THEN** no queued-up burst of requests is issued on recovery

### Requirement: Poll cadence is driven by a stack of mode requests

A caller SHALL be able to request that an endpoint class be polled at a stated interval until
a stated time, giving a reason, and SHALL receive a means of releasing that request early.
Multiple requests SHALL be able to be active at once; the effective interval SHALL be the
shortest active request's interval, or the class's base interval when none is active. A
request SHALL stop applying when its time elapses or it is released, whichever comes first,
after which the cadence SHALL return to the next shortest active request or the base.

Changing the effective interval SHALL take effect promptly: when a shorter interval becomes
effective, the pending delay SHALL be recomputed from the last poll rather than waiting out
the longer delay already scheduled.

#### Scenario: The shortest active request wins

- **WHEN** a 5 second request and a 3 second request are both active for the device-status
  class
- **THEN** polling proceeds at 3 seconds, and when the 3 second request ends it proceeds at
  5 seconds

#### Scenario: A shorter interval applies without waiting out the current delay

- **WHEN** a base-interval delay is pending and a much shorter request becomes active
- **THEN** the next poll happens on the shorter schedule measured from the previous poll,
  rather than at the end of the already-pending base delay

#### Scenario: Expiry restores the base cadence

- **WHEN** the only active request's stated end time passes
- **THEN** subsequent polls resume at the class's base interval

#### Scenario: An arbitrary interval is accepted for future features

- **WHEN** a caller requests an interval of 3 seconds for a bounded window, as a scheduled
  alarm window requires
- **THEN** the request is honoured through the same mechanism, with no feature-specific
  behaviour needed

### Requirement: Device status is polled fast after a write and while priming

The device-status class SHALL be polled at a fast interval of approximately 5 seconds for
approximately 90 seconds after any successful write to the Pod, so that the confirming read
arrives while the user is still looking at the app. Both the interval and the duration SHALL
be configurable.

The device-status class SHALL also be polled at that fast interval for as long as the Pod
reports that it is priming, and SHALL return to the base interval once priming ends.

#### Scenario: A write speeds up the next reads

- **WHEN** a write to the Pod succeeds
- **THEN** device status is polled at the fast interval for the configured fast window and then
  returns to the base interval

#### Scenario: Priming holds the fast cadence

- **WHEN** an observation reports the Pod priming and subsequent observations continue to
- **THEN** polling remains at the fast interval for the whole priming period, without the fast
  window elapsing part way through

#### Scenario: Priming ending restores the base cadence

- **WHEN** an observation reports that priming has finished and no other fast request is active
- **THEN** polling returns to the base interval

### Requirement: Consecutive failures back off exponentially and recover on the first success

On each consecutive failed poll of an endpoint class, the delay before the next attempt SHALL
grow exponentially, capped at approximately 60 seconds. The cap SHALL be configurable.

Backoff SHALL never make polling more frequent than the class's own effective interval: for a
class whose interval already exceeds the cap, backoff SHALL leave the interval unchanged. On
the first successful poll of a class, its delay SHALL return immediately to the effective
interval, with no gradual recovery.

Failures SHALL NOT stop polling. The Pod reboots daily; being unreachable is a normal state.

#### Scenario: Delays grow and are capped

- **WHEN** the device-status endpoint fails repeatedly from a 5 second effective interval
- **THEN** successive attempts are separated by roughly 10, 20, 40 and then 60 seconds, and
  stay at roughly 60 seconds however long the failures continue

#### Scenario: Backoff never outpaces a slow class

- **WHEN** a class polled every 5 minutes fails repeatedly
- **THEN** its interval remains approximately 5 minutes rather than dropping to the 60 second
  cap

#### Scenario: Recovery is immediate

- **WHEN** a poll succeeds after a long run of failures
- **THEN** the next poll is scheduled at the class's effective interval, not at the backed-off
  delay

#### Scenario: Polling survives an outage

- **WHEN** the Pod is unreachable for an hour and then returns
- **THEN** the poller is still attempting, and the snapshot is updated from the first
  successful poll after the Pod returns

### Requirement: A bootstrap poll runs once before handlers are wired, and cannot fail startup

The poller SHALL offer a bootstrap operation that polls every enabled class once and resolves
when they have all settled, intended to run before HomeKit handlers are wired so that the
first read has real data.

The bootstrap SHALL NOT reject, whatever happens: a class whose bootstrap poll fails SHALL
simply remain unknown in the snapshot, with the failure logged, and its recurring schedule
SHALL start regardless. The bootstrap SHALL also be bounded by a deadline, after which it
resolves even though some classes are still outstanding, so that a slow or absent Pod cannot
stall plugin startup; classes still outstanding at the deadline SHALL continue in the
background and update the snapshot when they settle.

A bootstrap failure SHALL count towards that class's consecutive-failure backoff.

#### Scenario: Bootstrap populates the snapshot

- **WHEN** the bootstrap runs against a reachable Pod
- **THEN** it resolves with every class observed, and a subsequent read returns real values

#### Scenario: Bootstrap against an unreachable Pod still resolves

- **WHEN** the bootstrap runs and every request fails
- **THEN** it resolves rather than rejecting, every class reads as unknown, the failures are
  logged, and recurring polling has started

#### Scenario: A hanging Pod does not stall startup

- **WHEN** the Pod accepts connections but never answers
- **THEN** the bootstrap resolves at its deadline, and the outstanding polls update the
  snapshot later if they eventually succeed

### Requirement: An out-of-band refresh can be requested without disturbing the schedule

A caller SHALL be able to request an immediate poll of a named endpoint class — the mechanism
a write's confirming read and a post-settings-write re-read need. If a poll of that class is
already in flight, the request SHALL attach to it rather than issuing a second request. A
refresh SHALL reset the class's next scheduled delay so that a refresh followed immediately by
a scheduled tick does not produce two requests in quick succession.

#### Scenario: Refresh reads now

- **WHEN** a refresh of the settings class is requested midway through its 5 minute period
- **THEN** a settings request is issued at once and the snapshot is updated from it

#### Scenario: Refresh during an in-flight poll issues nothing

- **WHEN** a refresh is requested for a class whose poll is already in flight
- **THEN** no second request is issued, and the caller's request settles with the in-flight
  poll's outcome

### Requirement: Time and randomness are injected, never read from globals

The poller SHALL obtain scheduling, the current time, and randomness from dependencies given
to it, so that its entire behaviour over hours of simulated time can be exercised
deterministically under fake timers within a test that completes in milliseconds.

#### Scenario: Hours of behaviour run instantly

- **WHEN** a test drives an hour of polling under fake timers
- **THEN** the full sequence of requests, backoff and recovery is observable without any real
  time elapsing

#### Scenario: Nothing escapes the injected clock

- **WHEN** a test supplies a clock that never advances
- **THEN** no interval, backoff, mode expiry or overlay expiry the poller is responsible for
  ever elapses

### Requirement: Stopping the poller releases everything

Stopping the poller SHALL cancel every pending timer, prevent any further request from being
issued, and ignore the result of any request still in flight. After stopping, the process
SHALL be able to exit with no open handle left behind, and a stopped poller SHALL NOT be
restartable into a half-scheduled state.

#### Scenario: Tests exit cleanly

- **WHEN** a test starts the poller, drives it, and stops it
- **THEN** no timer remains scheduled and the test process exits without an open-handle warning

#### Scenario: An in-flight poll cannot resurrect a stopped poller

- **WHEN** the poller is stopped while a request is outstanding and that request later succeeds
- **THEN** no snapshot commit and no further scheduling result from it

### Requirement: A five-minute Home-app session stays within a fixed request budget

A simulated five-minute session under fake timers — a bootstrap, a burst of eighty snapshot
reads at the start, a second burst of eighty a minute in, and a temperature slider drag in the
middle — SHALL cause the Pod to receive **no more than 40 requests in total, of which exactly
one is a write**, and **no fewer than 10 device-status reads**, proving the poller is still
running.

This budget is a guardrail, not an optimisation target. It exists so that any later change
which makes a read handler contact the Pod, leaves the fast poll permanently engaged, or drops
the in-flight suppression fails loudly rather than silently overloading the hardware queue.

#### Scenario: The session fits the budget

- **WHEN** the simulated session is run against the mock Pod with jitter fixed
- **THEN** the recorded request count is at most 40, exactly one recorded request is a write,
  and at least 10 device-status reads were recorded

#### Scenario: A read handler that contacts the Pod breaks the budget

- **WHEN** the snapshot read path is changed so that each read triggers a device-status request
- **THEN** the session exceeds the budget and the test fails

### Requirement: Presence and vitals are polled only for the configured occupancy source, and only once biometrics is confirmed enabled

The poller SHALL support a presence endpoint class, polled at approximately 30 seconds, and a
vitals endpoint class, polled at approximately 60 seconds. Each SHALL be enabled only while
both of the following hold: the configured occupancy source names that class's endpoint, and
the most recently observed services document reports biometrics as enabled. Before any services
document has been observed, biometrics SHALL be treated as not enabled.

Neither class SHALL be polled when the configured occupancy source names neither of them, or
names the other one.

#### Scenario: Neither class polls when occupancy is off

- **WHEN** the occupancy source is configured as none
- **THEN** neither the presence class nor the vitals class ever issues a request

#### Scenario: Only the configured source's class polls

- **WHEN** the occupancy source is configured as presence, and biometrics is confirmed enabled
- **THEN** the presence class polls on its own schedule and the vitals class never polls

#### Scenario: Biometrics must be confirmed, not merely unknown

- **WHEN** the occupancy source names a class, and no services document has yet been
  successfully observed
- **THEN** that class does not poll, until a services observation confirms biometrics enabled

#### Scenario: Biometrics turning off stops polling and turning it back on resumes it

- **WHEN** a previously-enabled class's occupancy source is unchanged, and a later services
  observation reports biometrics no longer enabled, and a still later one reports it enabled
  again
- **THEN** the class stops polling after the first change and resumes polling on its own
  schedule after the second, with no restart required

### Requirement: The vitals poll requests a single, fixed, recent window covering both sides

Each poll of the vitals class SHALL request a bounded, recent time window ending at the time of
the request, without restricting the request to one side, so that one request serves the
occupancy computation for both sides.

#### Scenario: One request serves both sides

- **WHEN** the vitals class polls
- **THEN** exactly one request is made, and its response is used to derive both sides' vitals-
  based occupancy

#### Scenario: The requested window is bounded and recent

- **WHEN** the vitals class's request is inspected
- **THEN** it requests a window ending at the time of the request and extending back a fixed,
  short duration, not an unbounded history
