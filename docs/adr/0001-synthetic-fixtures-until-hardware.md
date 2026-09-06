# ADR-0001: Synthetic Pod fixtures until real hardware is reachable

Status: accepted (2026-09-06)

## Context

Issue #3 calls for capturing real API responses from a Pod into `test/fixtures/` before
writing code against assumptions, and M1's exit criterion includes a live smoke read.
No Pod is reachable from the development machine at the start of this development run;
one may become available mid-run.

Blocking the entire M1/M2 pipeline on hardware would serialize everything behind an
unknown wait. The upstream free-sleep repo is checked out at `~/Code/free-sleep` and
contains both the zod schemas that define the wire types
(`server/src/routes/deviceStatus/deviceStatusSchema.ts`, `server/src/db/settingsSchema.ts`,
`server/src/db/schedulesSchema.ts`) and its own 599-line stateful mock
(`app/src/mocks/mockData.ts`), giving a high-fidelity source to derive fixtures from.

## Decision

- Generate fixtures synthetically from free-sleep's own mock data and zod schemas.
  Each fixture directory carries a `README.md` stating provenance (free-sleep version,
  commit, source file) and that the data is synthetic.
- Issue #3 stays **open** until real captures replace the synthetic ones. The exact
  `curl` capture commands and the swap procedure are documented on the issue.
- The M1 smoke script is written and committed now; its live run against a real Pod is
  recorded as a pending hardware-verification step, not an M1 blocker.
- If a Pod IP is provided mid-run: capture real responses, scrub identifying data,
  replace the synthetic fixtures, re-run the suite, and run the smoke script live.

## Consequences

- Types (#2) and client (#4) can proceed immediately; the "types parse the fixtures"
  acceptance check runs against synthetic data first and is re-run on real captures.
- Risk: this specific unit's `coverVersion` / `waterLevel` shape may differ from the
  synthetic assumption. Mitigated by deriving from upstream's own schemas (which the
  Pod's server actually validates against) and by keeping #3 open as the tripwire.

## Update 2026-09-06

A Pod became reachable and real captures landed, closing #3 (`test/fixtures/README.md` has
the full provenance table). The `coverVersion`/`waterLevel` risk called out above
materialized, benignly: the real unit reports `coverVersion`/`hubVersion: "Pod 3"`, not the
`"Pod 5"` this ADR and design.md's Open Question 3 had guessed. Nothing in the codebase
branches on this value, so the wrong guess cost nothing — the full test suite passed against
the real capture without a single fixture-content-driven test change. `waterLevel`'s shape
(the raw string `"true"`, not a boolean) matched the synthetic assumption exactly.

This ADR is now historical context: the fixtures it motivated generating synthetically are
real captures, and the decision that made that acceptable (derive from upstream's own
schemas, keep #3 open as a tripwire) is validated rather than superseded.
