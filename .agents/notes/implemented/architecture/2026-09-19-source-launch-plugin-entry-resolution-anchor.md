# Agent Note: Source-launch plugin-entry resolution anchor

Status: implemented

English | [中文](2026-09-19-source-launch-plugin-entry-resolution-anchor.zh.md)

## Problem

The [source launch](2026-07-29-dsh-source-launch-tsx-esm.md) runs `apps/cli/src/bin.ts` under `node --import tsx/esm`, and tsx projects in-repo workspace imports onto `src` through tsconfig `paths`. But tsx applies `paths` only when the importing module sits under the repo tsconfig; it consults the importer's location, not a global map.

The Loader resolves plugin ENTRIES through `internal.import(name, ctx.baseUrl)`, and `ctx.baseUrl` is the profile directory (`$DSH_HOME/profiles/<profile>/`), outside the repository. tsx finds no tsconfig there, so a plugin-entry specifier like `@deepseek-ai/dsh-agent-loop` falls through to Node resolution and the package's `exports` — the built `lib/`. Once that `lib/` module runs, its own in-repo imports (`import … from '@deepseek-ai/dsh-tools'`) DO sit under the repo tsconfig, so tsx remaps them to `src`.

A package reached from both planes therefore loads twice: the plugin entry pulls it from `lib`, and a sibling plugin's in-file import pulls it from `src`. Two module instances tolerate each other until one carries identity a peer must share. `@deepseek-ai/dsh-tools` exports `TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')` — a module-level symbol keying `ToolRuntime`'s scheduler field. The `ToolRuntime` instance (`ctx.tools`, from the `lib` copy) stores the field under the `lib` symbol; `dsh-agent-loop` reads `ctx.tools[TOOL_RUNTIME_SCHEDULER]` with the `src` symbol, gets `undefined`, and every tool dispatch throws `Cannot read properties of undefined (reading 'prepare')` at `startCall`. Text-only turns never dispatch a tool, so the failure appears only once a run calls any tool.

This violates the "source plane vs artifact plane, never mixed" rule: the built-bin launch (`node apps/cli/lib/bin.js`, all `lib`) stays single-plane and works; only the source launch mixes planes and duplicates the module.

## Decision

`runProfile` passes `boot()` a `bareModuleBaseUrl` anchored inside the repository when — and only when — it is running from source (`import.meta.url` under `apps/cli/src/`). `mountRootInclude` then resolves plugin entries against that repo-internal parent, so tsx `paths` apply to entries exactly as they already apply to the entries' in-file imports; the whole tree stays on the `src` plane and each workspace package loads once.

A built or installed launch (`import.meta.url` under `lib/`) passes `undefined` and keeps the default profile-directory anchor: its plugins resolve to `lib` consistently, so no plane mix arises and its behavior is unchanged.

## Alternatives considered

**Make the shared symbol duplication-proof with `Symbol.for(...)`.** A global-registry symbol survives module duplication, so `ctx.tools[TOOL_RUNTIME_SCHEDULER]` would resolve across the two copies. Rejected as the primary fix: it papers over the plane mix the repo forbids rather than removing it, leaves every OTHER cross-package identity (present or future) exposed to the same duplication, and `Symbol.for` conflicts with the `unique symbol` typing the computed-key field relies on. It remains a viable defensive backstop if a future launch cannot avoid mixing planes.

**Run built `lib/` for the whole launch (drop the source entry).** Single-plane and correct, but loses the zero-build development loop that the source launch exists to provide.

**Add a `src` export condition to every package so Node resolution reaches `src` in development.** Moves plane selection into package `exports` and a launch-set condition across the whole workspace — broad churn, and it still leaves two resolution mechanisms (tsx `paths` and the condition) that can diverge. The single anchor keeps one mechanism (tsx `paths`) authoritative for the source plane.

## Consequences

Source-launch tool dispatch works because `@deepseek-ai/dsh-tools` — and every other workspace package reached from both a plugin entry and an in-file import — loads once, so its module-level symbols keep one identity. The existing `apps/cli/tests/agent-team-headless.e2e.ts` pins this: it drives `list_agents`, `workflow`, and other tools through the source bin with a keyless fixture model, fails with the `reading 'prepare'` error without the anchor, and passes with it.

The anchor is scoped to the source launch, so built and installed launches are untouched. The cost accepted: under source launch a plugin whose package is NOT a workspace `paths` entry (a third-party plugin installed only into an isolated profile's `node_modules`) now resolves against the repo anchor rather than the profile directory; isolated third-party plugins are not part of the source development loop today, and the built/installed launch — which owns that isolated-profile case — is unaffected.
