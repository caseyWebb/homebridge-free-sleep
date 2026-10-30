## MODIFIED Requirements

### Requirement: Turning the dismiss switch on is accepted and reverted, never sent to the Pod — unless `alarmSwitchStartsAlarm` is on

While `alarmSwitchStartsAlarm` is `false` (the default), writing ON to a side's dismiss switch
SHALL be accepted, SHALL send nothing to the Pod, and SHALL revert to the observed value after
roughly 500 ms (unchanged). While `alarmSwitchStartsAlarm` is `true`, writing ON SHALL instead
behave as the "Starting an alarm from the switch" requirement below specifies.

#### Scenario: Default — accepted and reverted

- **WHEN** `alarmSwitchStartsAlarm` is `false` and a side's dismiss switch is written ON
- **THEN** no request is sent to the Pod and the switch reverts to the observed value after
  about 500 ms

## ADDED Requirements

### Requirement: Starting an alarm from the switch

With `alarmSwitchStartsAlarm` on, writing ON to a side's dismiss switch SHALL post one alarm
request for that side with `alarmSwitchAlarm`'s `duration`, `vibrationIntensity` and
`vibrationPattern` and `force: true`, SHALL never post for the other side, and SHALL NOT retry.
On success the switch SHALL read on immediately, the alarm-press event SHALL fire once, and the
plugin SHALL request faster `deviceStatus` polling until the alarm's real duration
(`max(10, duration)` seconds) plus 30 seconds have elapsed. On failure the write SHALL fail
with `SERVICE_COMMUNICATION_FAILURE`, no press SHALL fire, no faster polling SHALL be requested,
and the switch SHALL revert to the observed value.

#### Scenario: Default alarm

- **WHEN** `alarmSwitchAlarm` is not configured and the right dismiss switch is written ON
- **THEN** exactly one alarm request `{side: 'right', duration: 180, vibrationIntensity: 100,
  vibrationPattern: 'double', force: true}` is posted and the switch reads on

#### Scenario: Rejected start

- **WHEN** the Pod rejects the alarm request
- **THEN** the write fails with `SERVICE_COMMUNICATION_FAILURE`, no press fires, and the switch
  reads off again within about 500 ms

### Requirement: The switch's on-state after a start follows the Pod, and ends on its own regardless

After a successful start, the switch SHALL continue to read on until either the Pod is observed
not vibrating or the alarm's real duration has elapsed with no confirming observation,
whichever comes first; once a poll has confirmed the vibration, the observed value alone SHALL
govern (so the switch stays on past the nominal end if the Pod is still vibrating, and turns off
as soon as the Pod reports it stopped). Writing OFF at any point SHALL submit the usual dismiss
write and SHALL make the switch read off immediately.

#### Scenario: Nothing observed

- **WHEN** an alarm of 180 s is started and no device-status observation arrives
- **THEN** the switch reads on for 180 s and off thereafter, with no write made to produce that

#### Scenario: Confirmed, then stopped by the Pod

- **WHEN** a poll confirms the vibration and a later poll reports it stopped
- **THEN** the switch reads on until that later poll and off from then on, and no second press
  fires for the confirming poll

#### Scenario: Dismissed from the switch

- **WHEN** the switch is written OFF while on after a start
- **THEN** `{[side]: {isAlarmVibrating: false}}` is posted and the switch reads off at once

### Requirement: Shutdown releases the start's resources

Platform shutdown SHALL clear a pending start overlay's timer and release any fast-poll window
the switch requested.

#### Scenario: Stop after a start

- **WHEN** the platform shuts down shortly after a successful start
- **THEN** no timer the start created remains pending and the poll window's release has been
  called
