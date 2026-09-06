# homebridge-free-sleep

A Homebridge plugin that exposes an Eight Sleep Pod running the open-source
[`free-sleep`](https://github.com/throwaway31265/free-sleep) firmware to Apple HomeKit. The
plugin is a pure HTTP client against free-sleep's unauthenticated LAN REST API
(`http://<pod-ip>:3000/api/`); it runs on separate always-on hardware, not on the Pod itself,
and has no runtime dependency on the free-sleep repo. One dynamic platform publishes three
bridged accessories: left side, right side, and a hub.

Tech stack: TypeScript (ESM, NodeNext, strict), Node >=22, Homebridge 2.x / HAP-NodeJS,
vitest, undici/fetch for HTTP.

## Dev commands

- `npm run lint` — ESLint (flat config, `typescript-eslint` recommended) over both `src/` and
  `test/`. Fails on any rule violation; `dist/`, `coverage/`, and `node_modules/` are ignored.
- `npm run typecheck` — `tsc --noEmit` using the root `tsconfig.json`, which covers `src/` and
  `test/` under the project's strict settings. Emits nothing; the working tree is unchanged
  after it runs.
- `npm test` — `vitest run` (single pass, not watch mode) over `test/**/*.test.ts`. Needs no
  Pod and no network — nothing in the suite may perform I/O.
- `npm run build` — `tsc -p tsconfig.build.json`, which compiles `src/` only into `dist/`.
  Test files and test-only dependencies (e.g. `@homebridge/hap-nodejs`) never end up in the
  published artifact.

All four run in CI (`.github/workflows/ci.yml`) on every push to `main` and every pull
request, as a matrix over every Node major version in `engines.node`
(`^22 || ^24 || ^26` — currently 22, 24, 26), installing from the committed
`package-lock.json` via `npm ci`.

## Hard constraints on the Pod

These drive most design decisions. The full, source-verified list lives in
`docs/POD-API.md`; the five load-bearing ones:

- `GET /api/deviceStatus` is a live hardware round-trip over a Unix socket with a sequential
  queue. Never poll per-characteristic — one shared poller feeds a cache, and every HAP
  `onGet` reads that cache synchronously.
- Writes to `settingsDB.json` / `schedulesDB.json` make the Pod cancel and rebuild every
  scheduled job. Settings writes must be rare and user-initiated.
- `isOn: true` is implemented server-side as a 12-hour duration; it silently expires.
- If either side has `awayMode` on, a write to one side is applied to **both** sides.
- The Pod reboots daily. Connection loss is a normal state, not an error path.

## Reference docs

- `docs/POD-API.md` — the full, source-verified list of Pod REST API behaviour.
- `docs/HOMEKIT.md` — HAP/HomeKit modeling decisions (accessory layout, characteristics,
  the `supports-hap` package metadata, why the plugin never depends on `@homebridge/hap-nodejs`
  at runtime).
- `docs/adr/` — architecture decision records:
  [`0001-synthetic-fixtures-until-hardware.md`](docs/adr/0001-synthetic-fixtures-until-hardware.md),
  [`0002-sdd-orchestration-and-change-decomposition.md`](docs/adr/0002-sdd-orchestration-and-change-decomposition.md).
- `docs/ROADMAP.md` — milestones, linked to tracked issues.

## Conventions

- Conventional commits.
- Prefer small, verifiable changes.
- Every behavioural claim about the Pod API must cite a file path in the free-sleep repo
  (`~/Code/free-sleep`) rather than being assumed.
- Work is planned and tracked through OpenSpec (`openspec/`) — proposal, design, and tasks
  artifacts per change, under `openspec/changes/<name>/`. See `openspec/config.yaml` for the
  schema and per-artifact rules (e.g. every proposal states which free-sleep API endpoints it
  touches and whether any write is expensive; every design cites free-sleep source paths for
  Pod-behaviour claims and calls out anything that needs confirmation on a real paired device;
  every task must be independently verifiable).
