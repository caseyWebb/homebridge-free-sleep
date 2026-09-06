## Why

The repo has `lint`, `typecheck`, and `test` scripts but nothing behind them: there is no
ESLint config, no ESLint dependency, no vitest config, no test, and no CI. `tsconfig.json`
also only includes `src/**/*.ts`, so `npm run typecheck` would silently skip everything
under `test/`. Every later milestone (M1 #2–#6 onward) assumes a green baseline it can add
to, so the toolchain has to land first — and the ESM/NodeNext setup needs to be proven to
actually compile before code is written against it.

Resolves #1 (milestone M1 — Foundations).

## What Changes

- **ESLint**: add a flat config (`eslint.config.js`) using `typescript-eslint`, wired to the
  existing `lint` script (`eslint .`). Add `eslint` and `typescript-eslint` devDependencies.
- **Vitest**: add `vitest.config.ts` and a trivial placeholder test covering
  `src/settings.ts`, so `npm test` exercises the runner rather than exiting on "no tests".
- **Typecheck covers tests**: restructure the TS config so `npm run typecheck` sees both
  `src/` and `test/`, while `npm run build` still emits `dist/` from `src/` only. Confirm
  relative imports carrying `.js` extensions resolve under NodeNext.
- **Dependencies**: add the devDependencies later milestones already assume —
  `@homebridge/hap-nodejs` (test-only; see docs/HOMEKIT.md) and `zod` — and commit
  `package-lock.json` so CI can `npm ci`.
- **Package metadata**: add the `supports-hap` keyword alongside `homebridge-plugin`. Do
  **not** add `supports-matter` — that keyword is only for plugins registering through
  `api.matter` (docs/HOMEKIT.md).
- **CI**: add `.github/workflows/ci.yml` — one job, matrix over Node 22 / 24 / 26, running
  `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, triggered on push to `main`
  and on `pull_request`.
- **Project `CLAUDE.md`**: dev commands, the five hard Pod constraints, pointers to
  `docs/POD-API.md` and `docs/HOMEKIT.md`, and the OpenSpec / commit conventions.
- **`docs/adr/`**: link the two ADRs the tech lead authored separately (`0001-synthetic-fixtures-until-hardware.md`,
  `0002-sdd-orchestration-and-change-decomposition.md`) from `CLAUDE.md`. This change does not
  author or edit them.

**Done when:** `npm run lint`, `npm run typecheck`, and `npm test` all pass locally and on
all three Node versions in CI.

## Non-goals

- No plugin runtime code. No `PodClient`, no platform, no accessories, no HAP registration —
  those are #4 and M2.
- No vendored Pod types or zod schemas (#2); `zod` is added as a dependency only, unused for
  now.
- No fixtures or mock Pod (#3, #5). `test/fixtures/` stays empty.
- No coverage thresholds, no Prettier/format script, no commitlint or Husky hooks, no
  Dependabot/Renovate, no release or publish automation (#22).
- No authoring or editing of the two ADRs in `docs/adr/` — only linking them.
- No `supports-matter` keyword.
- No changes to `config.schema.json` or the README.

## free-sleep API endpoints touched

**None.** This change adds no network calls of any kind. Nothing here reads
`GET /api/deviceStatus`, and nothing writes `settingsDB.json` or `schedulesDB.json`, so
there are no expensive writes and no risk of triggering a scheduled-job rebuild on the Pod.
No test in this change contacts a real Pod.

## Capabilities

### New Capabilities

- `build-tooling`: the project's verifiable quality gates — what `lint`, `typecheck`, and
  `test` must cover, the Node versions CI must prove green, and the package metadata the
  Homebridge UI reads (the `supports-hap` transport declaration).

### Modified Capabilities

None — this is the first capability in the repo.

## Impact

- **Files added**: `eslint.config.js`, `vitest.config.ts`, `tsconfig.build.json`,
  `test/settings.test.ts`, `.github/workflows/ci.yml`, `CLAUDE.md`, `package-lock.json`.
- **Files modified**: `package.json` (devDependencies, `supports-hap` keyword, `build`
  script pointed at the build config), `tsconfig.json` (`include` widened to `src/` and
  `test/`; `rootDir`/`outDir` move to the build config).
- **Dependencies**: `eslint`, `typescript-eslint`, `@homebridge/hap-nodejs`, `zod` (all dev;
  `zod` will become a runtime dependency when #2 lands).
- **Systems**: GitHub Actions becomes a required signal on PRs. No Pod, no network, no
  HomeKit impact.
