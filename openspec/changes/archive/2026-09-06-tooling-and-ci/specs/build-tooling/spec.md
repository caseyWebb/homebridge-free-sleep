## Purpose

Defines the repository's verifiable quality gates — what linting, typechecking, and testing
must cover, which Node versions continuous integration must prove green, and the package
metadata the Homebridge UI reads to classify this plugin.

## ADDED Requirements

### Requirement: Lint gate

The repository SHALL provide an `npm run lint` script that statically checks every
TypeScript source file in the project — both plugin sources and tests — and exits non-zero
when any rule is violated.

#### Scenario: Clean tree lints successfully

- **WHEN** `npm run lint` is run on an unmodified checkout with dependencies installed
- **THEN** the command exits 0 and reports no errors

#### Scenario: A lint violation fails the gate

- **WHEN** a TypeScript file under `src/` or `test/` violates an enabled rule
- **THEN** `npm run lint` exits non-zero and names the offending file and rule

#### Scenario: Generated and vendored output is not linted

- **WHEN** `npm run lint` is run with a populated `dist/`, `coverage/`, or `node_modules/`
- **THEN** files under those directories are ignored and do not affect the result

### Requirement: Typecheck gate covers tests as well as sources

The repository SHALL provide an `npm run typecheck` script that typechecks both `src/` and
`test/` under the project's strict TypeScript settings, without emitting build output.

#### Scenario: A type error in a test file fails typecheck

- **WHEN** a file under `test/` contains a type error
- **THEN** `npm run typecheck` exits non-zero and reports that file

#### Scenario: Typecheck emits nothing

- **WHEN** `npm run typecheck` completes
- **THEN** no files are written to `dist/` and the working tree is unchanged

### Requirement: Build emits only plugin sources

`npm run build` SHALL compile only `src/` into `dist/`, so that test files and test-only
dependencies are never part of the published artifact.

#### Scenario: Test files are excluded from build output

- **WHEN** `npm run build` is run with files present under `test/`
- **THEN** `dist/` contains compiled output for `src/` only, and the entry point declared in
  `package.json` (`dist/index.js` once sources exist) resolves within `dist/`

#### Scenario: ESM module resolution is proven

- **WHEN** a TypeScript source file imports another local module using a relative specifier
  with a `.js` extension
- **THEN** both `npm run build` and `npm run typecheck` resolve the import successfully under
  NodeNext module resolution

### Requirement: Test gate executes at least one test

The repository SHALL provide an `npm test` script that runs the test suite once
(non-watching) and exits non-zero on any failing test. The suite SHALL contain at least one
executing test so the gate cannot pass vacuously.

#### Scenario: Test suite runs and passes

- **WHEN** `npm test` is run on an unmodified checkout
- **THEN** the runner reports at least one passing test and exits 0

#### Scenario: A failing test fails the gate

- **WHEN** any test assertion fails
- **THEN** `npm test` exits non-zero

#### Scenario: Tests require no Pod and no network

- **WHEN** the test suite is run on a machine with no Eight Sleep Pod reachable and no
  network access
- **THEN** the suite still passes

### Requirement: Continuous integration proves the gates on every supported Node version

The repository SHALL run lint, typecheck, and test in CI on every Node major version listed
in the `engines.node` range of `package.json` (currently 22, 24, and 26), on pushes to the
default branch and on pull requests, installing dependencies from the committed lockfile.

#### Scenario: Pull request runs the full matrix

- **WHEN** a pull request is opened against `main`
- **THEN** CI runs one job per supported Node major version, each executing a lockfile-exact
  install followed by lint, typecheck, and test

#### Scenario: A failure on any single version fails CI

- **WHEN** lint, typecheck, or test fails on exactly one Node version in the matrix
- **THEN** the overall CI result for that commit is a failure

#### Scenario: Lockfile drift is caught

- **WHEN** `package.json` declares a dependency that the committed lockfile does not satisfy
- **THEN** the CI install step fails rather than silently resolving new versions

### Requirement: Plugin metadata declares its HomeKit transport

`package.json` SHALL declare the `supports-hap` keyword alongside `homebridge-plugin`, and
SHALL NOT declare `supports-matter`, because this plugin publishes accessories through
HAP-NodeJS and does not register through `api.matter`.

#### Scenario: Homebridge UI reads a complete transport declaration

- **WHEN** the Homebridge UI inspects this package's keywords
- **THEN** it finds both `homebridge-plugin` and `supports-hap`, and does not find
  `supports-matter`

### Requirement: Contributor and agent guidance is discoverable from the repo root

The repository SHALL provide a root `CLAUDE.md` documenting the development commands, the
Pod behavioural constraints that govern design decisions, pointers to the source-verified
Pod and HomeKit references, and the project's change and commit conventions.

#### Scenario: A new contributor finds the gates and the constraints

- **WHEN** someone opens `CLAUDE.md` at the repository root
- **THEN** it states how to run lint, typecheck, test, and build; lists the hard Pod
  constraints; links to `docs/POD-API.md` and `docs/HOMEKIT.md`; and states that any
  behavioural claim about the Pod API must cite a file path in the free-sleep repository
