## Purpose

Lets the iPhone's own Sleep alarm drive the bed through plain Home actions: a per-side
momentary switch that fires a configured alarm, and a per-side momentary switch that stops a
ringing alarm while bumping that side's target temperature by a configured delta. Together
with the existing "Dismiss Alarm" switch and the Thermostat's Off mode, the three iOS triggers
("goes off", "is snoozed", "is dismissed") each map to one or two accessory writes.

## ADDED Requirements

### Requirement: Each switch is published per side only when its own config key enables it

A "Wake Alarm" `Switch` SHALL be published on a side accessory only when `wakeAlarmSwitch` is
`true`, and a "Snooze" `Switch` only when `snoozeSwitch` is `true`; both keys default to
`false`. Each SHALL carry its own stable subtype, SHALL be restored (not duplicated) across a
restart, SHALL be pruned on restore when its key is turned off, and SHALL never be published on
the hub accessory.

#### Scenario: Default config publishes neither

- **WHEN** the platform starts with neither key set
- **THEN** no side accessory carries a Wake Alarm or Snooze switch

#### Scenario: Disabling a switch prunes it on restore without touching the thermostat

- **WHEN** a cached side accessory carrying a Wake Alarm switch is restored under a config with
  `wakeAlarmSwitch: false`
- **THEN** that switch is removed and the side's Thermostat remains

### Requirement: Turning Wake Alarm on fires the configured alarm for that side only

Writing ON to a side's Wake Alarm switch SHALL post an alarm request for that side with
`config.wakeAlarm`'s `duration`, `vibrationIntensity` and `vibrationPattern` and `force: true`,
SHALL never post for the other side, SHALL NOT retry, and SHALL surface a rejected post to
HomeKit as a communication failure. Writing OFF SHALL do nothing.

#### Scenario: Defaults

- **WHEN** `wakeAlarm` is not configured and the right Wake Alarm switch is turned on
- **THEN** exactly one alarm request `{side: 'right', duration: 180, vibrationIntensity: 100,
  vibrationPattern: 'double', force: true}` is posted

#### Scenario: A rejected post is visible

- **WHEN** the Pod rejects the alarm request
- **THEN** the write fails with `SERVICE_COMMUNICATION_FAILURE` and a warning is logged

### Requirement: Turning Snooze on dismisses the alarm and bumps the side's target in one submission

Writing ON to a side's Snooze switch SHALL submit one side patch containing
`isAlarmVibrating: false`, `isOn: true`, and `targetTemperatureF` equal to the side's current
*effective* cached target plus `snoozeTemperatureDeltaF`, rounded to a whole degree and
clamped to 55–110 °F. Successive presses SHALL compound from the effective target. When no
target has been observed yet, the patch SHALL contain only `isAlarmVibrating: false` and a
warning SHALL be logged. Writing OFF SHALL do nothing.

#### Scenario: Default delta

- **WHEN** the right side's effective target is 88 °F and its Snooze switch is turned on with the
  default delta
- **THEN** the dismiss is sent and the side is written `{isOn: true, targetTemperatureF: 98}`

#### Scenario: Presses stack and clamp

- **WHEN** the switch is pressed twice in quick succession from 105 °F with a +10 delta
- **THEN** the first write targets 110 and the second also targets 110

### Requirement: Snooze's dismiss is never blocked by the away-mode guard; its bump may be

Because the write queue dispatches the `isAlarmVibrating` field as its own guard-exempt request
before the remainder, a Snooze press SHALL always send the dismiss. If the remainder is refused
by the away-mode guard, the press SHALL fail with `NOT_ALLOWED_IN_CURRENT_STATE`; any other
write failure SHALL fail with `SERVICE_COMMUNICATION_FAILURE`.

#### Scenario: Partner side away under the block policy

- **WHEN** `awayModeWritePolicy` is `'block'`, the left side is away, and the right Snooze switch
  is turned on
- **THEN** `{right: {isAlarmVibrating: false}}` is posted, nothing else is posted, and the write
  fails with `NOT_ALLOWED_IN_CURRENT_STATE`

### Requirement: Both switches are momentary and release their timers on shutdown

Each switch's `On` SHALL be pushed back to `false` roughly one second after an ON write,
regardless of whether the underlying request succeeded, failed, or is still outstanding, with
no controller write required. Platform shutdown SHALL clear any pending self-reset timer.

#### Scenario: Reset after a failed request

- **WHEN** an ON write's request fails
- **THEN** the switch still reads off about one second after the write
