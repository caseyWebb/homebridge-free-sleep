# ADR-0002: SDD orchestration model and change decomposition for the MVP

Status: accepted (2026-09-06)

## Context

The MVP (milestones M1 + M2, issues #1–#11) is being developed autonomously using the
OpenSpec spec-driven workflow. The GitHub issues are unusually complete — each has an
acceptance line and much of the design is already locked in `docs/POD-API.md` and
`docs/HOMEKIT.md` — so the unit of work should be a coherent capability, not one
OpenSpec change per issue (too much ceremony) or one giant change (unreviewable).

## Decision

Issues map to six OpenSpec changes:

| Change | Issues | Depends on |
|---|---|---|
| `tooling-and-ci` | #1 | — |
| `pod-client` | #2 #3 #4 #5 | tooling-and-ci |
| `temperature-mapping` | #6 | tooling-and-ci |
| `platform-foundation` | #7 | tooling-and-ci (pod-client for types) |
| `poller-and-write-queue` | #8 #10 | pod-client |
| `thermostat-and-offline` | #9 #11 | all of the above |

Process per change: propose (planning agent) → reconcile (tech lead reviews artifacts
against issues/docs, decides unknowns, records ADRs) → implement (agent on branch
`change/<name>`, PR) → code review → merge on green CI → sync + archive the change.

Parallelism only where file sets are disjoint: `pod-client` ∥ `temperature-mapping`,
and `platform-foundation` ∥ `poller-and-write-queue`. `thermostat-and-offline` is the
serial integration change.

Merges happen autonomously once CI is green and review findings are resolved
(explicitly authorized by the project owner on 2026-09-06).

## Consequences

- #4 and #5 live in one change because the mock Pod is the executable spec for the
  client — their tests are meaningless apart.
- #9 and #11 live in one change because offline behavior is expressed through the
  thermostat's onGet/onSet handlers; splitting them would create a change that cannot
  meet its own "Done when".
- Spec capabilities in `openspec/specs/` accumulate per change at sync time, so main
  always describes what main actually does.
