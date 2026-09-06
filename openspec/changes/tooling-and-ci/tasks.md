## 1. Dependencies and package metadata

- [ ] 1.1 Add `eslint` and `typescript-eslint` to `devDependencies` at their current major
  versions; verify `npx eslint --version` reports 9.x or later and `node -e "require.resolve('typescript-eslint')"`
  resolves.
- [ ] 1.2 Add `@homebridge/hap-nodejs` and `zod` to `devDependencies`; verify
  `node --input-type=module -e "import('zod').then(m=>console.log(!!m.z))"` prints `true` and
  the same import form resolves `@homebridge/hap-nodejs`.
- [ ] 1.3 Add `supports-hap` to the `keywords` array in `package.json`, immediately after
  `homebridge-plugin`; verify with `node -p "const k=require('./package.json').keywords; k.includes('supports-hap') && !k.includes('supports-matter')"`
  printing `true`.
- [ ] 1.4 Generate and commit `package-lock.json` (`npm install`, then `git add -f` if
  needed); verify `npm ci` succeeds from a clean `node_modules/` and exits 0.

## 2. TypeScript configuration

- [ ] 2.1 Widen `tsconfig.json` `include` to `["src/**/*.ts", "test/**/*.ts"]` and remove
  `rootDir`/`outDir` from it; verify `npx tsc --noEmit --showConfig` lists files from both
  directories once `test/` has a file (re-verify after task 3.2).
- [ ] 2.2 Add `tsconfig.build.json` extending the root config with `include: ["src/**/*.ts"]`,
  `rootDir: "./src"`, `outDir: "./dist"`, and point the `build`/`watch` scripts at it; verify
  `npm run build` produces `dist/settings.js` and `dist/settings.d.ts` — and no `dist/src/`
  and no `dist/test/`.
- [ ] 2.3 Prove the NodeNext `.js`-extension convention: temporarily add a second module under
  `src/` imported from `settings.ts` as `./<name>.js`, run `npm run build` and
  `npm run typecheck`, confirm both exit 0 and `node dist/index.js`-style resolution works,
  then revert the scratch module. Verification is the two clean exits, recorded in the commit
  message.
- [ ] 2.4 Confirm `npm run typecheck` writes nothing: run it with a clean tree and verify
  `git status --porcelain` is empty and `dist/` is unchanged.

## 3. Vitest and the placeholder test

- [ ] 3.1 Add `vitest.config.ts` with `include: ["test/**/*.test.ts"]` and
  `environment: "node"`; verify `npx vitest list` enumerates the test files it will run
  (empty is expected until 3.2).
- [ ] 3.2 Add `test/settings.test.ts` asserting `PLUGIN_NAME === 'homebridge-free-sleep'` and
  `PLATFORM_NAME === 'FreeSleep'`, importing from `../src/settings.js`; verify `npm test`
  reports at least one passing test and exits 0.
- [ ] 3.3 Verify the test gate is not vacuous and needs no Pod: break one assertion, confirm
  `npm test` exits non-zero, restore it; then run `npm test` with networking unavailable and
  confirm it still passes.

## 4. ESLint

- [ ] 4.1 Add `eslint.config.js` composing `@eslint/js` recommended and `typescript-eslint`
  recommended, with `ignores: ["dist/", "coverage/"]`; verify `npm run lint` exits 0 on the
  current tree.
- [ ] 4.2 Verify the lint gate actually covers both trees and skips output: introduce a
  deliberate violation (e.g. an unused variable) first in a `src/` file and then in a `test/`
  file, confirming `npm run lint` fails and names each; run `npm run build` first and confirm
  no `dist/` file appears in lint output. Revert the violations.

## 5. CI workflow

- [ ] 5.1 Add `.github/workflows/ci.yml`: triggers `push` to `main` and `pull_request`; one
  job with `strategy.matrix.node-version: [22, 24, 26]`; steps `actions/checkout`,
  `actions/setup-node` (with `cache: npm`), `npm ci`, `npm run lint`, `npm run typecheck`,
  `npm test`. Verify locally with `npx --yes @action-validator/cli --verbose .github/workflows/ci.yml`
  or equivalent YAML/schema check.
- [ ] 5.2 Verify the matrix matches `engines.node` (`^22 || ^24 || ^26`) by reading both
  files side by side; note any `actions/setup-node` limitation on Node 26 in a comment in the
  workflow if the version cannot be resolved.
- [ ] 5.3 Push the branch and open a PR; verify GitHub Actions reports three passing jobs
  (`node 22`, `node 24`, `node 26`) — this is the acceptance check for the whole change.

## 6. Documentation scaffolding

- [ ] 6.1 Create root `CLAUDE.md` covering: the four dev commands and what each gate checks;
  the five hard Pod constraints from the project context (deviceStatus polling, expensive
  settings/schedules writes, the 12-hour `isOn` expiry, the away-mode both-sides coupling,
  the daily reboot); pointers to `docs/POD-API.md` and `docs/HOMEKIT.md`; and the conventions
  — conventional commits, the OpenSpec change workflow, and the rule that every behavioural
  claim about the Pod API must cite a file path in the free-sleep repo at `~/Code/free-sleep`.
  Verify by reading it back against this list and against `openspec/config.yaml`'s context
  block, item by item.
- [ ] 6.2 Reference the existing ADRs from `CLAUDE.md` — `docs/adr/` is already populated with
  `0001-synthetic-fixtures-until-hardware.md` and
  `0002-sdd-orchestration-and-change-decomposition.md`, authored separately by the tech lead.
  Verify `git ls-files docs/adr` lists both files (committing them if still untracked) and
  that `CLAUDE.md` links to the directory. Do **not** edit or author ADR content.

## 7. Acceptance

- [ ] 7.1 From a clean clone: `npm ci && npm run lint && npm run typecheck && npm test`;
  verify all four exit 0 in sequence.
- [ ] 7.2 Confirm CI is green on all three Node versions on the PR (task 5.3), then confirm
  the repo state matches the spec's requirements one by one — lint gate, typecheck-covers-tests
  gate, build-emits-src-only, test gate, CI matrix, `supports-hap` metadata, root `CLAUDE.md`.
