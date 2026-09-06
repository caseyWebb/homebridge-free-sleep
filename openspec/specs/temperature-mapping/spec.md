# temperature-mapping Specification

## Purpose

Defines the plugin's Fahrenheit/Celsius boundary: the range of bed temperatures a user may
set, the conversion between the Pod's native °F and HomeKit's °C, and the HAP characteristic
properties that must make every whole degree Fahrenheit in that range — both endpoints
included — selectable and stable in the Home app.

## Requirements

### Requirement: Settable temperature range is 55–110 °F inclusive

The plugin SHALL treat 55 °F as the lowest and 110 °F as the highest settable bed
temperature, with both endpoints selectable, and SHALL expose that range as the single
source of truth for every temperature-setting surface it later publishes.

#### Scenario: Both endpoints are inside the range

- **WHEN** the settable range is consulted
- **THEN** it reports a minimum of 55 °F and a maximum of 110 °F, and both are valid
  settable values rather than exclusive bounds

### Requirement: Fahrenheit and Celsius convert exactly and invertibly

The plugin SHALL convert between Fahrenheit and Celsius using the exact affine relation,
without rounding, clamping, or unit-formatting, and the two directions SHALL be inverses of
each other to within floating-point representation error.

#### Scenario: Known anchor points convert correctly

- **WHEN** a temperature is converted from Fahrenheit to Celsius
- **THEN** 32 °F yields 0 °C, 212 °F yields 100 °C, and −40 °F yields −40 °C

#### Scenario: Conversion is invertible across the settable range

- **WHEN** each integer Fahrenheit value from 55 through 110 is converted to Celsius and
  back
- **THEN** the returned Fahrenheit value equals the original to within floating-point
  representation error, and rounds to exactly the original integer

#### Scenario: Conversion does not clamp

- **WHEN** a Fahrenheit value outside the settable range — such as a sub-55 °F measured room
  reading — is converted
- **THEN** the conversion returns the true Celsius equivalent rather than a value clamped to
  the settable range

### Requirement: Target temperature properties snap HAP onto whole degrees Fahrenheit

The plugin SHALL publish a single set of HomeKit target-temperature properties whose step
size is exactly one degree Fahrenheit expressed in Celsius, and whose minimum is the
Celsius equivalent of the range minimum, so that HAP's value grid — which is anchored at the
declared minimum — lands on whole degrees Fahrenheit and on nothing else.

#### Scenario: Every grid point is a whole degree Fahrenheit

- **WHEN** a HomeKit target-temperature characteristic is configured with these properties
  and every value it accepts is enumerated
- **THEN** each enumerated value converts to a whole number of degrees Fahrenheit

#### Scenario: The slider does not skip degrees

- **WHEN** consecutive accepted values are compared
- **THEN** they differ by exactly one degree Fahrenheit, so no two adjacent positions round
  to the same whole degree and no whole degree in the range is absent

### Requirement: The declared maximum survives HAP's floored effective maximum

HAP derives an effective maximum by flooring the number of whole steps that fit between the
declared minimum and maximum, a computation that is subject to floating-point truncation.
The declared maximum SHALL therefore carry enough margin above the Celsius equivalent of
110 °F that 110 °F remains selectable, while staying below the next step boundary so no
value above 110 °F becomes selectable.

#### Scenario: HAP enumerates exactly the 56 whole degrees from 55 to 110

- **WHEN** a HomeKit target-temperature characteristic is configured with these properties
  and its valid values are enumerated through HAP's own validator
- **THEN** exactly 56 values are enumerated, corresponding to 55 °F through 110 °F inclusive

#### Scenario: The upper endpoint is reachable

- **WHEN** the Celsius equivalent of 110 °F is written to that characteristic
- **THEN** the characteristic holds a value that reads back as 110 °F, rather than being
  rejected or reduced to 109 °F

#### Scenario: Nothing above the range becomes selectable

- **WHEN** the enumerated valid values are inspected
- **THEN** the highest of them corresponds to 110 °F, with no additional grid point above it

### Requirement: Whole degrees Fahrenheit round-trip through a HomeKit characteristic

Writing the Celsius equivalent of any whole degree Fahrenheit in the settable range to a
configured HomeKit target-temperature characteristic SHALL leave that characteristic holding
a value that converts back to the same whole degree Fahrenheit. This SHALL be verified
against a real HAP characteristic implementation rather than against the plugin's own
arithmetic, because HAP's snapping and validation are the behaviour under test.

#### Scenario: Golden round-trip over the full range

- **WHEN** for each integer Fahrenheit value from 55 through 110 the corresponding Celsius
  value is written to a configured HAP target-temperature characteristic
- **THEN** the characteristic's stored value converts back to that same integer Fahrenheit
  value after rounding, for all 56 values

#### Scenario: Verification exercises HAP, not a substitute

- **WHEN** the round-trip and valid-value checks are performed
- **THEN** they run against an actual HAP characteristic with these properties applied, not
  against a stub, mock, or reimplementation of HAP's snapping rules

### Requirement: The temperature boundary is stateless, offline, and free of runtime HAP dependencies

The temperature range, the conversions, and the property constants SHALL hold no state, make
no network calls, contact no Pod, and pull no HomeKit library into the plugin's runtime
dependency graph. HAP may be used only by the verification suite.

#### Scenario: No Pod and no network are required

- **WHEN** the temperature behaviour is exercised on a machine with no Eight Sleep Pod
  reachable and no network access
- **THEN** it behaves identically and its verification suite passes

#### Scenario: Results depend only on the input

- **WHEN** the same temperature is converted repeatedly, in any order relative to other
  conversions
- **THEN** the same result is returned every time, with no dependence on call order or
  prior use

#### Scenario: HomeKit libraries stay out of the runtime graph

- **WHEN** the plugin's published runtime dependency graph is inspected
- **THEN** no HAP implementation package is reachable from this capability
