## Context

See proposal.md — Why. The only pre-existing state that shapes this design: `package.json`
already declares the four scripts (`build`, `test`, `lint`, `typecheck`) and
`engines.node: "^22 || ^24 || ^26"`; `tsconfig.json` is strict ESM/NodeNext with
`rootDir: ./src`, `outDir: ./dist`, and `include: ["src/**/*.ts"]`; `src/` holds only
`settings.ts` and `test/` holds only an empty `fixtures/` directory.

No claim in this document concerns Pod behaviour, so there is nothing to cite from
`~/Code/free-sleep`, and no HAP behaviour here needs confirmation on a paired device — the
`supports-hap` keyword is metadata read by the Homebridge UI, not by HAP itself
(`docs/HOMEKIT.md`, "Declare the `supports-hap` keyword...").

## Goals / Non-Goals

**Goals:**

- One command per gate, identical locally and in CI — no CI-only steps.
- `typecheck` sees strictly more files than `build` emits.
- Prove the NodeNext `.js`-extension import convention compiles before any code depends on it.

**Non-Goals:**

- Type-aware ESLint rules (the `projectService` / `recommendedTypeChecked` tier). Deferred:
  it roughly triples lint time and duplicates what `typecheck` already catches on a codebase
  this small. Revisit if a class of bug appears that only type-aware rules catch.
- Caching, concurrency groups, or job splitting in CI. Three short jobs do not need it.

## Decisions

### TypeScript config layout: root config is the typecheck config; build gets its own

`tsconfig.json` becomes the editor/typecheck config — `include: ["src/**/*.ts",
"test/**/*.ts"]`, no `rootDir`, and it keeps `noEmit` off only because `typecheck` passes
`--noEmit` explicitly. A new `tsconfig.build.json` extends it with
`include: ["src/**/*.ts"]`, `rootDir: "./src"`, `outDir: "./dist"`, and `build` becomes
`tsc -p tsconfig.build.json`.

Rationale: the root `tsconfig.json` is what editors and `typescript-eslint` pick up by
default, so the config with the *widest* file set belongs there — otherwise tests get no
editor diagnostics. The narrower build config is only ever invoked explicitly.

Alternatives considered:

- *Keep `tsconfig.json` as the build config, add `tsconfig.typecheck.json`.* Inverts the
  default: editors and lint would see only `src/`, and `test/` would be red-squiggle-free
  but unchecked in the IDE. Rejected.
- *Project references / solution-style root config.* Correct at scale, but two configs and
  three source files do not justify `composite`, `.tsbuildinfo` files, and `tsc -b`.
- *Single config with `exclude: ["test"]` on build.* `tsc --noEmit` cannot then widen the
  set; you would need the second config anyway.

Note that with `test/**/*.ts` included and no `rootDir`, the build config must re-assert
`rootDir: "./src"` so `dist/` stays flat (`dist/settings.js`, not `dist/src/settings.js`).

### ESLint: flat config, `typescript-eslint` non-type-aware tier

`eslint.config.js` (plain JS, ESM — the package is `"type": "module"`) composing
`@eslint/js` `recommended` and `typescript-eslint` `recommended`, with an explicit
`ignores: ["dist/", "coverage/"]` block. `eslint .` already walks the repo, and flat config
ignores `node_modules/` by default; `dist/` and `coverage/` must be listed explicitly
because flat config does not read `.gitignore` unless told to.

Rationale: flat config is the only format ESLint 9+ supports without a compatibility shim,
and `typescript-eslint`'s `config()` helper handles the parser/plugin wiring that would
otherwise be hand-written. Keeping the config in JS rather than TS avoids needing `jiti` to
load it.

Alternatives considered: `eslint.config.ts` (needs an extra loader dependency for no benefit
here); eslintrc + `FlatCompat` (deprecated path, more moving parts).

### Vitest: config file rather than script flags

`vitest.config.ts` with `include: ["test/**/*.test.ts"]` and `environment: "node"`. The
`test` script stays `vitest run`.

Rationale: a config file is where later milestones will add fixture setup files, coverage
config (#3, #5), and per-suite timeouts; putting it in place now means those are one-line
additions. Vitest transpiles TS through esbuild without type errors stopping the run — which
is precisely why the typecheck gate must cover `test/` separately (previous decision).

The placeholder test asserts the two constants in `src/settings.ts`. That looks trivial, but
it is the assertion that both are stable identifiers Homebridge resolves the plugin by — and
mechanically it proves the runner, the TS transform, and the `.js`-extension import
convention all work end to end.

### CI: one workflow, one job, `strategy.matrix.node: [22, 24, 26]`

`npm ci` (fails on lockfile drift, unlike `npm install`) then the three gates as separate
steps so the failing gate is identifiable from the job summary. `fail-fast` left at its
default `true` — for a green-baseline workflow there is no value in burning the other two
runners after one has failed.

The matrix must stay in sync with `engines.node`. That coupling is asserted by the spec, not
by tooling; if it drifts often enough to matter, a lint rule can be added later.

### `zod` and `@homebridge/hap-nodejs` land now, unused

Both are devDependencies here even though nothing imports them until #2 and M2. Adding them
in the same commit as the lockfile means the first commit that actually imports them does not
also churn `package-lock.json`, and it verifies now that they install cleanly on all three
Node versions. `noUnusedLocals` does not flag unimported packages, so this costs nothing at
the gates.

`zod` will move to `dependencies` when #2 vendors the Pod schemas; `@homebridge/hap-nodejs`
stays dev-only forever (`docs/HOMEKIT.md`: the plugin must not depend on it at runtime).

## Risks / Trade-offs

- **`tsc --noEmit` with the root config picks up `vitest.config.ts` / `eslint.config.js`
  and fails on them.** → Config files at the root are outside `include`, so they are not
  typechecked; if a future config file needs checking, add it to `include` deliberately
  rather than widening to `**/*.ts`.
- **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` make third-party type
  definitions awkward.** → Only surfaces once real code lands; `skipLibCheck: true` is
  already set, which limits the blast radius to our own call sites.
- **Node 26 may not have a stable `actions/setup-node` release channel at implementation
  time.** → If `setup-node` cannot resolve 26, pin that matrix entry to the current
  nightly/RC channel and note it in the workflow rather than dropping the version — the
  `engines` range promises it.
- **The `test` gate passes vacuously if the placeholder is ever deleted.** → The spec
  requires at least one executing test; vitest's default behaviour of failing on an empty
  suite is the backstop.
- **Lint and typecheck overlap.** → Accepted. They fail for different reasons and both are
  fast; deduplicating them would mean the type-aware ESLint tier this design declines.

## Migration Plan

Not applicable — nothing is deployed or published by this change, and there are no consumers
to migrate. Rollback is `git revert`.
