## Context

See proposal.md — Why. The relevant existing machinery, all already merged:

- `src/services/thermostat.ts` keeps `accessory.context.publishedF: { targetF?, currentF? }`
  and `accessory.context.publishedIsOn`. Writes claim into these shadows synchronously, before
  `writeQueue.submitSide` is awaited; `refresh()`/`pushTemperature` push a temperature update
  only when the observed °F differs from the shadow (design cited from the archived
  `thermostat-and-offline` design, "The °F shadow: `publishedF` in `accessory.context`").
- `src/pod/writeQueue.ts`'s `WriteQueue.submit` installs an optimistic overlay on the
  `SnapshotStore` **synchronously**, inside the `Promise` executor, at submission time — not at
  dispatch. `syncOverlays()` runs before `submit`'s executor returns, so the overlay for a
  field is live before any `await` yields control back to the event loop. The overlay is held
  for `writeSettleMs` (default 15000, `src/config.ts`), re-based to a fresh `writeSettleMs`
  window on every successful dispatch (`rebaseOwnership`), and cleared immediately on failure.
- `src/pod/snapshot.ts`'s `SnapshotStore` computes `effective = raw with overlay entries
  applied where present` on every commit (module doc, "The snapshot is a layered value"). While
  an overlay entry exists for `(side, 'targetTemperatureF')`, `effective[side].targetTemperatureF`
  is the overlay's value regardless of what `raw` (the actual last-observed Pod value) says. A
  poll landing with a different value updates `raw` but not `effective` for that field, and
  therefore does not change what any `onGet` or `refresh()` sees.
- `src/pod/types.ts`'s `SideStatusSchema` (the read schema) is deliberately lenient — no
  min/max on `targetTemperatureF` — while `SideStatusPatchSchema` (the write/request schema)
  enforces 55–110 (`docs/POD-API.md`'s "read lenient, write strict" split, matching
  `server/src/routes/deviceStatus/updateDeviceStatus.ts`'s own validation, which is what makes an
  out-of-range Pod-reported value unlikely but not impossible — free-sleep's own write path is
  the only thing keeping it in range, and this plugin cannot assume every write to the Pod's
  `settingsDB.json`/`deviceStatusDB.json` went through that path).
- `src/pod/temperature.ts` is a stateless leaf module (imports nothing) that already owns
  `F_MIN`, `F_MAX`, `fToC`, `cToF`, `TARGET_TEMP_PROPS` as the single source of truth for the
  settable range.

No claim above is new; all of it is cited to confirm what the existing tests
(`test/services/thermostat.test.ts` sections 5.1–5.3, S2; `test/integration/session.test.ts`
"slider-drag guardrail (8.4)") already exercise, so this design can reason precisely about what
those tests do and do not yet prove.

## Goals / Non-Goals

**Goals:**

- Settle, with evidence rather than assertion, whether #14's remaining "full-range drag" and
  "explicit `writeSettleMs` window" asks require new production code.
- Close the actual correctness gap in #33: an out-of-range observed target temperature must not
  permanently desynchronize `publishedF.targetF`.
- Keep the fix at the HomeKit service boundary, per #33's own framing — `src/pod/types.ts`'s
  read schema stays untouched.

**Non-Goals:**

- Rewriting or replacing the overlay/shadow mechanism. If the investigation below found it
  insufficient, that would be a `pod-write-queue` or `pod-snapshot` change, not this one — this
  change touches only `src/services/thermostat.ts` and tests.
- `lastNonZeroBrightness` (see proposal's Non-goals — #20's territory, doesn't exist yet).
- Real-hardware verification (ADR-0001; tracked separately on #14's `needs-hardware` label).

## Decisions

### #14: the overlay already provides a strictly stronger guarantee than a time-boxed window — proven, not assumed

The archived `thermostat-and-offline` design already made this argument in its "What #14 adds
on top, deliberately deferred" section, reasoning from the overlay's *existence*. This design
checks the argument against the overlay's actual *lifecycle* code, because "strictly stronger"
is a claim about ordering and coverage, not just presence:

1. **Claim happens before overlay install, both synchronously, both before the first `await`.**
   In `ThermostatService`'s `targetTempChar.onSet`, `context.publishedF = {...}` runs as the
   first statement, then `this.ctx.writeQueue.submitSide(...)` is called. `submitSide` →
   `submit` constructs a `new Promise((resolve, reject) => { ... syncOverlays() })` — the
   executor, including the `syncOverlays()` call that installs the overlay, runs synchronously
   during construction, before `submitSide` returns a pending promise to the `await` in `onSet`.
   So there is no tick, and therefore no possible poll completion, between "shadow claims the
   degree" and "overlay pins the snapshot to that degree." A poll's `PodClient` response can only
   ever be parsed and committed to the snapshot on a **later** tick (it is genuinely
   asynchronous I/O), so it cannot land in the gap because the gap has zero width.

2. **The overlay's suppression window is duration-based and re-armed on every value, which is
   what a full-range drag needs.** `applyOrClearOverlay` is called from `syncOverlays()` on
   *every* `submit` call for the lane, not just the first in a batch — so during a drag from 55
   to 110, each intermediate degree re-installs the overlay for `(side, 'targetTemperatureF')`
   with a fresh `writeSettleMs` window and the newest value. The overlay entry for that field is
   never absent during a continuous drag: the previous entry is replaced, not cleared then
   reinstated, because `value !== undefined` for every intermediate write. There is no gap in
   which `effective` would briefly answer from `raw`.

3. **A drag that spans `writeMaxDebounceMs` (default 2000ms) starts a second write cycle with
   its own `overlayOwnership` map, but the snapshot's overlay table is keyed by `(side, field)`,
   not by cycle** — so the second cycle's `syncOverlays()` calls `setOverlay` again for the same
   key, which simply replaces the first cycle's entry with a newer `generation`. The first
   cycle's later `rebaseOwnership` (once its own dispatch settles) reads the *current* effective
   value off the snapshot — which by then is whatever the second cycle most recently wrote — and
   re-installs with that same value, so the two cycles never fight over what value the overlay
   holds; they agree, because both are chasing the same drag. (This per-cycle-ownership-vs.
   shared-key design is exactly what `pod-write-queue`'s own module doc describes as "why a
   later cycle's install, rebase, or clear from ever touching an earlier cycle's still-live
   overlay for that same field" is *not* a concern here — both cycles installing the *same
   field* is expected and correct; the isolation that module doc is about is between different
   *fields* accumulated across cycles, not a claim that two cycles can't legitimately share a
   key.)

4. **`writeSettleMs` already is the "explicit suppression window keyed on a write" that #14
   asked for** — it is not a separate mechanism layered on top of the overlay; it *is* the
   overlay's lifetime parameter (`src/pod/writeQueue.ts`'s constructor, `src/config.ts`'s
   `writeSettleMs` schema entry, default 15000). The archived design's "two designs claim the
   same key" resolution (`thermostat-and-offline`'s design.md) already settled that this key
   belongs to the write queue, not to a parallel time-boxed check in `thermostat.ts`. Building a
   second, `thermostat.ts`-local timestamp comparison alongside it would suppress a strict
   *subset* of what the overlay already suppresses (a poll landing *after* `writeSettleMs`
   elapses but the overlay hasn't yet retired because `raw` still disagrees — which the overlay
   correctly keeps suppressing and a naive fixed-duration timer would incorrectly stop
   suppressing) — i.e. adding it would make behavior *worse*, not better.

**Conclusion**: no new production code for #14. What's missing is a test that actually drives a
full-range drag — spanning `writeMaxDebounceMs` — while a disagreeing poll observation lands
mid-drag, and asserts the published value never regresses. The existing "slider-drag guardrail
(8.4)" test proves single-POST coalescing over six writes 50ms apart (well under one debounce
window); it does not drive the full range, does not span a batch boundary, and does not
introduce a racing observation. That gap is closed by 3.1–3.2 below.

**This needs no tech-lead confirmation on the architecture** — it's a direct reading of merged,
tested code — but the resulting recommendation (closing #14 without new machinery) is worth a
tech-lead's explicit sign-off before the issue is closed, since #14's own "Done when" clause was
written before the overlay's lifecycle was fully fleshed out by `poller-and-write-queue`, and
because #14 carries a `needs-hardware` label that this change deliberately does not satisfy
(Open Questions).

### #33: clamp at three read sites in `thermostat.ts`, not in `pod/types.ts` or `pod/snapshot.ts`

`targetTemperatureF` flows from `SnapshotStore.get()[side].targetTemperatureF` into exactly
three places in `ThermostatService`:

| Site | Current behavior | Fix |
|---|---|---|
| `targetTempChar.onGet` | `return fToC(side.targetTemperatureF)` | clamp before `fToC` |
| `refresh()` → `pushTemperature(..., side.targetTemperatureF, ..., 'targetF')` | compares raw `observedF` against `shadow.targetF`, pushes raw `fToC(observedF)` | clamp before the call, so both the comparison and the pushed value use the clamped degree |
| `computeCurrentState`'s `delta = side.targetTemperatureF - side.currentTemperatureF` | raw, unclamped | **left unclamped** — deliberate, see below |

A single helper, `clampTargetF(f: number): number` (new export in `src/pod/temperature.ts`,
next to `F_MIN`/`F_MAX`, since that module is already this codebase's single source of truth
for the settable range and is imported by both `thermostat.ts` and its tests), replaces the raw
value at the first two sites. `pushTemperature`'s call site becomes:

```ts
const targetF = side.targetTemperatureF === undefined ? undefined : clampTargetF(side.targetTemperatureF);
this.pushTemperature(targetTempChar, targetF, context, 'targetF');
```

`pushTemperature` itself is unchanged — the clamp happens at the call site, not inside the
shared helper, because the identical helper is also called for `currentTemperatureF` with no
clamp, and threading a "clamp or don't" flag through it is more moving parts than clamping once
at each of the two target-only call sites.

**Why `computeCurrentState`'s delta stays unclamped**: that computation decides heat vs. cool
for the *sticky deadband*, not what value gets published on `TargetTemperature`. If the Pod
ever genuinely targets outside 55–110°F (a state this plugin cannot write but might observe if
something else wrote it, or during a firmware anomaly), the *direction* the bed is heating
toward is still meaningfully "toward 130°F" even though HomeKit can only ever display "toward
110°F". Clamping the delta calculation would make a bed genuinely cooling toward an unreachable
low target report `HEAT` if the clamped delta's sign flipped — a worse, silent misrepresentation
of an already-degenerate state. This mirrors the existing, spec'd asymmetry between
`CurrentTemperature` (never clamped, because it can be a true sub-55°F reading) and
`TargetTemperature` (clamped only where it is compared against or written into the HomeKit-facing
shadow). **Flagged for tech-lead review** in Open Questions — it's a judgment call about a state
that should not occur in practice (`docs/POD-API.md`'s write-path validation), not one back by a
test on real hardware.

**Why not clamp in `pod/types.ts` or `pod/snapshot.ts` instead**: #33's own text is explicit —
"clamp to F_MIN..F_MAX at the service boundary... keeping the read schema lenient." Clamping in
the read schema would make `SnapshotStore`'s `raw` layer lie about what the Pod actually said,
which breaks the "observed truth" contract every other consumer of `raw`/`effective` relies on
(there is exactly one other planned consumer path today — nothing in a landed change reads
`targetTemperatureF` besides `thermostat.ts` — but the snapshot layer's own module doc is
explicit that `raw` is "last-observed truth," not a HomeKit-shaped view of it).

## Risks / Trade-offs

- **[Risk] The full-range-drag test proves the property under the mock's timing, not real
  hardware.** → Accepted per ADR-0001; the property being tested (overlay suppresses every
  disagreeing observation for its lifetime) is a claim about this plugin's own code, not about
  Pod timing, so a virtual clock exercising the same code paths is sufficient evidence. Real
  Pod confirmation remains tracked on #14's `needs-hardware` label (Open Questions).
- **[Risk] Closing #14 without satisfying its literal `needs-hardware` label.** → Mitigation:
  say so plainly in this design and in the final task list; let the tech lead decide whether to
  close #14 outright, downgrade the label, or leave it open pending hardware while this change
  lands the software-side fix. Not resolved by this document (Open Questions).
- **[Risk] A future call site reads `side.targetTemperatureF` directly without the new clamp
  helper**, reintroducing #33. → The two call sites are the entirety of where this field reaches
  HomeKit today (table above); `computeCurrentState`'s intentional exception is commented in
  code. No new abstraction is warranted for two call sites (mirrors the archived design's own
  "two services is not enough to justify a base class" reasoning) — a code comment at each site
  pointing at the other is the guard.

## Migration Plan

No data migration, no config change, no `accessory.context` shape change. Two source edits
(`src/pod/temperature.ts` adds one pure function; `src/services/thermostat.ts` calls it at two
sites) plus tests and a docs update. Rollback is a plain revert — nothing persisted depends on
the new clamp function's existence.

## Open Questions

- Should #14 be closed outright once this change lands, given it still carries `needs-hardware`
  and this change deliberately provides no real-Pod confirmation? Or should the label stay and
  the issue stay open, tracking only the hardware confirmation, with this change's tasks
  referenced as "the software side is done"? Tech-lead call; does not change this change's scope
  either way.
- `computeCurrentState`'s delta staying unclamped when `targetTemperatureF` is out of range
  (Decisions, "#33") is a judgment call about a state that free-sleep's own write validation
  should prevent. Worth a second opinion, but does not block implementation — the alternative
  (clamp the delta too) is a one-line change if the tech lead prefers it.

## Resolutions (tech lead, 2026-09-06)

1. **Close #14 when this change merges.** The mock-plus-virtual-clock proof satisfies everything
   CI can settle; the real-device full-range-drag observation moves to #36's hardware session
   checklist so the needs-hardware residue is tracked, not lost.
2. **`computeCurrentState` keeps the raw delta.** An out-of-range target still truthfully
   describes which direction the Pod is driving; clamping the delta would misreport HEAT/COOL.
   The clamp exists solely to protect the published HomeKit value and the shadow.
