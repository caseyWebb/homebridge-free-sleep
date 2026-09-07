# Verified-plugin application checklist

A ready-to-file checklist for the Homebridge
[verified-plugin](https://github.com/homebridge/plugins/wiki/Verified-Plugins) application,
transcribing the research already done in
[issue #22](https://github.com/caseyWebb/homebridge-free-sleep/issues/22)'s comments (no
criterion below is invented beyond what that research established).

**Filing the application is a deliberate, separate action for the tech lead.** This document
only prepares the checklist — nothing here files it, and nothing in this repository does either.
See `docs/ROADMAP.md`'s M5 entry for #22, which calls this out as an explicit follow-up, not
something this change (or any automated process) completes.

## Lead differentiator

The verified-plugin process's own "not the same or less functionality than an existing verified
plugin" criterion means an application should lead with what makes this plugin different from
the one Eight-Sleep plugin already on the verified list,
[`@omarshahine/homebridge-eight-sleep`](https://github.com/homebridge/plugins/wiki/Verified-Plugins)
(verified 2026-09-02, per issue #22's research comment):

> This plugin is **LAN-only** against the open-source **free-sleep** firmware — no Eight Sleep
> account, no cloud dependency, and it works on a Pod that has been **firewalled off from the
> internet entirely** (the recommended free-sleep setup). `@omarshahine/homebridge-eight-sleep`
> and every other existing Eight Sleep HomeKit plugin authenticate against Eight Sleep's cloud
> with account credentials — exactly what free-sleep exists to let an owner opt out of. A
> household that has already firewalled its Pod cannot use a cloud-dependent plugin at all;
> this plugin is what makes HomeKit control possible for that setup.

This is the sentence to lead the application with (see README.md's own "What this is" section,
which states the same differentiation to a human reader).

## Criteria self-assessment

Each row traces to a specific, checkable place in this repository.

| Criterion | Status | Evidence |
|---|---|---|
| Published on npm | ✅ | `@caseywebb/homebridge-free-sleep`, versions 0.1.0/0.2.0/0.3.0 all live (`npm view @caseywebb/homebridge-free-sleep versions`); confirmed in issue #22's own comments at publish time for each. |
| Public GitHub repo with issue tracking | ✅ | `caseyWebb/homebridge-free-sleep`; every feature and fix referenced above traces to a numbered issue (`gh issue list`), and `package.json`'s `bugs.url` points at it. Repo visibility flips to public as the very last M5 action, per `docs/ROADMAP.md` — must be done before filing. |
| `config.schema.json` present and accurate | ✅ | `config.schema.json` at repo root, `pluginType: "platform"`, every config key documented with a `title`/`description`/`default` matching `src/config.ts`'s zod schema one-for-one (cross-checked in `README.md`'s config-key table, this change's task 4.1). |
| Supported Node.js versions are current LTS | ✅ | `package.json`'s `engines.node: "^22 \|\| ^24 \|\| ^26"` — matrixed in CI (`.github/workflows/ci.yml`) across all three. |
| `engines.homebridge` set appropriately | ✅ | `package.json`'s `engines.homebridge: "^2.0.0"`. |
| Declares HAP-transport support | ✅ | `package.json`'s `keywords` include both `homebridge-plugin` and `supports-hap` (docs/HOMEKIT.md's "Homebridge 2.x API notes" explains why this plugin never depends on `@homebridge/hap-nodejs` at runtime despite declaring it). |
| No post-install scripts | ✅ | `package.json`'s `scripts` has no `postinstall`/`preinstall` — only `prepublishOnly` (`npm run build`), which runs for the maintainer at publish time, never on an end user's `npm install`. |
| Installs without starting unconfigured | ✅ | `src/platform.ts`'s constructor: `FreeSleepConfigSchema.safeParse` failure (including a config block that never mentions `host`, since `host` is required and un-defaulted) logs an error and returns immediately — no accessory, no poller, no write queue is ever constructed against an absent/invalid config. |
| A GitHub release per published version | ✅ | `gh release list` shows `v0.1.0`, `v0.2.0`, `v0.3.0`, each with release notes (`gh release view v<version>`); mirrored in `CHANGELOG.md`. |
| Implements a dynamic platform | ✅ | `src/platform.ts`: `FreeSleepPlatform implements DynamicPlatformPlugin`, registered via `api.registerPlatform` in `src/index.ts`. |
| Error-handling discipline | ✅ | Every write failure maps to a `HapStatusError` with an appropriate `HAPStatus` (`SERVICE_COMMUNICATION_FAILURE`/`NOT_ALLOWED_IN_CURRENT_STATE`) rather than throwing raw errors into HAP; every `onGet` degrades to last-known-cached values rather than throwing, except the bounded `noResponseAfterMs` escalation (`docs/HOMEKIT.md`'s "No Response" section). Every non-trivial change in this repo's history went through adversarial code review with findings executed, not just proposed (`openspec/changes/archive/*/design.md`'s own "PR review" resolutions). |
| `files` scoped to what's actually published | ✅ | `package.json`'s `files: ["dist", "config.schema.json"]` — test files, `@homebridge/hap-nodejs` (a devDependency only), and `openspec/` planning artifacts never ship; npm additionally always includes `README.md`/`LICENSE`/`package.json` regardless of `files`. |

## Known open items before filing

- **Repo visibility**: still private (`docs/ROADMAP.md`'s M5). Must flip to public
  (`gh repo edit caseyWebb/homebridge-free-sleep --visibility public`) before an application can
  be filed at all — a private repo cannot be reviewed.
- **Frontend discoverability confirmation**: issue #22's research confirmed the exact-name
  search mechanism against `homebridge-config-ui-x`'s own source
  (`plugins.service.ts:504-515`, `isScopedPlugin`) — backend-confirmed, but not yet
  human-confirmed against a running Homebridge UI instance end to end.
- **This change's own `#49` (ConfiguredName)**: ships in the same release cycle as this
  checklist; not itself a verified-plugin criterion, but worth having landed and stable before
  filing, since a verified-plugin review may include a functional pass over the paired
  accessory's HomeKit presentation.

None of the above block preparing this checklist — only filing the application itself.
