## MODIFIED Requirements

### Requirement: Mode and setpoint writes become one minimal Pod patch each

Writing off or automatic to the target heating/cooling state SHALL submit a power patch for
that side and nothing else. Writing the target temperature SHALL submit a target-temperature
patch, in whole degrees Fahrenheit, for that side and nothing else. Neither SHALL submit a
persisted-settings write.

Writes SHALL be submitted to the plugin's write path so that writes arriving close together are
merged into a single Pod request, and each write handler SHALL settle only when the dispatch
carrying it settles.

Every mode and setpoint write SHALL first pass through the away-mode guard. When neither side is
in away mode, this requirement's guarantees hold exactly as stated: one minimal patch, no
persisted-settings write. When either side is in away mode, the configured away-mode policy
applies instead of the unconditional guarantee:

- Under the `block` policy, the write MAY be refused before it reaches the Pod at all, in which
  case the Pod receives no request for it.
- Under the `mirror` policy, the write reaches the Pod exactly as described above, but the
  handler's settlement and the cached view additionally reflect the away-mode guard's mirrored
  update to the other side.

A write handler's rejection SHALL distinguish a refusal by the away-mode guard from a rejection
caused by a failed or unreachable Pod: the guard's refusal SHALL surface as
`HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE`, never the `SERVICE_COMMUNICATION_FAILURE` a genuine
write failure surfaces. A characteristic value HAP applied optimistically ahead of a refused
write SHALL be corrected back to the cached view shortly after the refusal, so the tile does not
keep showing a value the write never actually produced.

#### Scenario: Turning a side on submits only a power patch

- **WHEN** automatic is written to the target heating/cooling state, and neither side is in away
  mode
- **THEN** the Pod receives one status write whose body sets that side's power on, carrying no
  temperature field and no duration field

#### Scenario: A setpoint change submits only a temperature patch

- **WHEN** a target temperature is written, and neither side is in away mode
- **THEN** the Pod receives one status write whose body sets that side's target temperature to
  the corresponding whole degree Fahrenheit, and carries no power field

#### Scenario: A slider drag produces one Pod request

- **WHEN** a controller writes a rapid succession of target temperatures to one side, as
  dragging the Home app's temperature slider does, and neither side is in away mode
- **THEN** the Pod receives exactly one status write for that side, carrying the last value of
  the drag

#### Scenario: A mode change and a setpoint change together are one request

- **WHEN** the target heating/cooling state and the target temperature of the same side are
  written within a few milliseconds of each other, and neither side is in away mode
- **THEN** the Pod receives exactly one status write, whose body carries both the power field
  and the temperature field for that side

#### Scenario: No settings write is ever issued

- **WHEN** any sequence of mode, setpoint and display-unit writes is performed
- **THEN** the Pod receives no write to its persisted-settings endpoint, because such a write
  makes it cancel and rebuild every scheduled job

#### Scenario: A blocked write throws a distinct HAP status and reverts the tile

- **WHEN** the away-mode policy is `block`, either side is in away mode, and a target temperature
  or power write is submitted
- **THEN** the write handler throws `HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)`, the
  Pod receives no request for it, and the affected characteristic is shortly updated back to the
  cached snapshot's value

#### Scenario: A mirrored write's handler settles once, covering both sides' cached update

- **WHEN** the away-mode policy is `mirror`, either side is in away mode, and a target temperature
  write is submitted
- **THEN** the write handler settles successfully once the Pod accepts the addressed side's
  write, and the other side's thermostat reflects the same target temperature without a separate
  read from that side's controller
