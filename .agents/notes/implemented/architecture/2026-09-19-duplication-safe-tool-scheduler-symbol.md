# Agent Note: Duplication-safe tool scheduler symbol under source launch

Status: implemented

English | [中文](2026-09-19-duplication-safe-tool-scheduler-symbol.zh.md)

## Problem

The [source launch](2026-07-29-dsh-source-launch-tsx-esm.md) runs `apps/cli/src/bin.ts` under `node --import tsx/esm`, and tsx projects in-repo workspace imports onto `src` through tsconfig `paths` — but only for importers that sit under the repo tsconfig; it consults the importer's location.

The Loader resolves plugin ENTRIES through `internal.import(name, ctx.baseUrl)`, and `ctx.baseUrl` is the profile directory (`$DSH_HOME/profiles/<profile>/`), outside the repository. tsx finds no tsconfig there, so a plugin-entry specifier like `@deepseek-ai/dsh-agent-loop` falls through to Node resolution and the package's `exports` — the built `lib/`. Once that `lib/` module runs, its own in-repo imports (`import … from '@deepseek-ai/dsh-tools'`) DO sit under the repo tsconfig, so tsx remaps them to `src`.

A workspace package reached from both planes therefore loads twice: the plugin entry pulls it from `lib`, and a sibling plugin's in-file import pulls it from `src`. Two module instances tolerate each other until one carries identity a peer must share. `@deepseek-ai/dsh-tools` exposes `TOOL_RUNTIME_SCHEDULER`, a symbol keying `ToolRuntime`'s scheduler field. With a module-local `Symbol(...)`, each copy mints a distinct symbol: the `ToolRuntime` instance (`ctx.tools`, from the `lib` copy) stores the field under the `lib` symbol; `dsh-agent-loop` reads `ctx.tools[TOOL_RUNTIME_SCHEDULER]` with the `src` symbol, gets `undefined`, and every tool dispatch throws `Cannot read properties of undefined (reading 'prepare')` at `startCall`. Text-only turns never dispatch a tool, so the failure surfaces only once a run calls any tool.

## Decision

`TOOL_RUNTIME_SCHEDULER` is a global-registry symbol — `Symbol.for('@deepseek-ai/dsh-tools.scheduler')`, not a module-local `Symbol(...)`. Duplicate module copies then resolve the same registered symbol, so the field the `lib` copy writes on `ctx.tools` is the field the `src` copy reads from `dsh-agent-loop`, and tool dispatch works whether or not the launch loaded `@deepseek-ai/dsh-tools` once or twice. The `unique symbol` typing is unchanged (`Symbol.for` yields a `unique symbol` in a `const` context), so the computed-key field and `ctx.tools[TOOL_RUNTIME_SCHEDULER]` stay typed.

The fix touches only the symbol; it does not change how the Loader resolves plugin entries. Entry resolution stays anchored on the profile directory, so a profile that installs a third-party plugin into its own `node_modules` keeps resolving it.

## Alternatives considered

**Anchor plugin-entry resolution inside the repo (pass `boot()` a repo-internal `bareModuleBaseUrl` under source launch).** This makes tsx `paths` apply to plugin entries too, so the whole tree stays on the `src` plane and each workspace package loads once. Rejected — and reverted after shipping briefly — because it breaks resolution for any plugin whose package is NOT a workspace `paths` entry: a third-party plugin installed only into the profile's `node_modules` (observed with `dsh-better-sidebar` under `$DSH_HOME/profiles/web/node_modules/`) no longer resolves against the repo anchor, fails to import, and — being a client shell plugin — hangs the web UI at its loading screen. Profile-local third-party plugins are a supported deployment, so forcing entry resolution into the repo is not acceptable.

**Run built `lib/` for the whole launch (drop the source entry).** Single-plane and correct, but loses the zero-build development loop the source launch exists to provide.

**Add a `src` export condition to every package so Node resolution reaches `src` in development.** Moves plane selection into package `exports` and a launch-set condition across the whole workspace — broad churn, and it leaves two resolution mechanisms (tsx `paths` and the condition) that can diverge.

## Consequences

Source-launch tool dispatch works because the scheduler symbol has one identity across module copies, and the Loader still resolves plugin entries against the profile directory, so profile-local third-party plugins (the web UI's sidebar shell among them) keep importing. `apps/cli/tests/agent-team-headless.e2e.ts` pins the dispatch path: it drives `list_agents`, `workflow`, and other tools through the source bin with a keyless fixture model, fails with the `reading 'prepare'` error without the registry symbol, and passes with it.

The trade-off accepted: the workspace-package double-load under source launch remains — it is a latent inefficiency, not a correctness bug, once identity no longer depends on a single module instance. Any OTHER cross-package value that must keep one identity across the plane boundary (another shared symbol, a sentinel object compared by reference) must likewise be a registry symbol or a by-value comparison; a fresh module-local `Symbol(...)` used as a cross-package key would reintroduce this failure.
