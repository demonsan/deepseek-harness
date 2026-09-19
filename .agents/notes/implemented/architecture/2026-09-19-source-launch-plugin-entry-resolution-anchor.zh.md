# Agent Note: Source-launch plugin-entry resolution anchor

Status: implemented

[English](2026-09-19-source-launch-plugin-entry-resolution-anchor.md) | 中文

## Problem

[源码启动](2026-07-29-dsh-source-launch-tsx-esm.zh.md)以 `node --import tsx/esm` 运行 `apps/cli/src/bin.ts`，tsx 通过 tsconfig `paths` 把仓库内的 workspace import 投射到 `src`。但 tsx 只在导入方模块位于仓库 tsconfig 之下时才套用 `paths`；它依据导入方的位置，而非一张全局映射表。

Loader 通过 `internal.import(name, ctx.baseUrl)` 解析插件**入口**，而 `ctx.baseUrl` 是 profile 目录（`$DSH_HOME/profiles/<profile>/`），位于仓库之外。tsx 在那里找不到 tsconfig，于是像 `@deepseek-ai/dsh-agent-loop` 这样的插件入口 specifier 落到 Node 原生解析与包的 `exports`——即构建产物 `lib/`。而一旦该 `lib/` 模块运行起来，它自身位于仓库内的导入（`import … from '@deepseek-ai/dsh-tools'`）**确实**处在仓库 tsconfig 之下，于是被 tsx 重映射到 `src`。

因此一个从两个平面都被触及的包会被加载两次：插件入口从 `lib` 拉一份，兄弟插件的文件内导入从 `src` 拉一份。两个模块实例本可相安无事，直到其中一方携带了对端必须共享的身份。`@deepseek-ai/dsh-tools` 导出 `TOOL_RUNTIME_SCHEDULER = Symbol('@deepseek-ai/dsh-tools.scheduler')`——一个模块级符号，用作 `ToolRuntime` 调度器字段的键。`ToolRuntime` 实例（`ctx.tools`，来自 `lib` 副本）用 `lib` 的符号存该字段；`dsh-agent-loop` 用 `src` 的符号去读 `ctx.tools[TOOL_RUNTIME_SCHEDULER]`，取到 `undefined`，于是每次工具派发都在 `startCall` 抛出 `Cannot read properties of undefined (reading 'prepare')`。纯文本回合从不派发工具，所以只有当某次运行调用任意工具时才会暴露。

这违反了「source plane vs artifact plane, never mixed」规则：构建产物入口（`node apps/cli/lib/bin.js`，全 `lib`）保持单一平面且正常；只有源码启动混用平面并重复加载模块。

## Decision

`runProfile` 在——且仅在——从源码运行时（`import.meta.url` 位于 `apps/cli/src/` 之下）给 `boot()` 传入一个锚定在仓库内的 `bareModuleBaseUrl`。`mountRootInclude` 随后以该仓库内父级解析插件入口，使 tsx `paths` 对入口生效，正如它已经对入口的文件内导入生效一样；整棵树保持在 `src` 平面，每个 workspace 包只加载一次。

构建或安装态启动（`import.meta.url` 位于 `lib/` 之下）传入 `undefined`，沿用默认的 profile 目录锚点：其插件一致地解析到 `lib`，不产生平面混用，行为不变。

## Alternatives considered

**用 `Symbol.for(...)` 让共享符号免于重复。** 全局注册表符号能跨模块副本存活，因而 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 可跨两份副本解析。作为主修复被否决：它掩盖了仓库明令禁止的平面混用而非消除它，会让其他所有（现有或未来的）跨包身份继续暴露于同样的重复问题，且 `Symbol.for` 与计算键字段依赖的 `unique symbol` 类型标注冲突。若未来某种启动方式无法避免平面混用，它仍可作为防御性兜底。

**整个启动都跑构建产物 `lib/`（放弃源码入口）。** 单一平面且正确，但会失去源码启动本就是为提供的零构建开发闭环。

**给每个包加一个 `src` export 条件，让 Node 解析在开发时到达 `src`。** 把平面选择推入整个 workspace 的包 `exports` 与一个启动设置的条件——改动面很大，且仍留下两套可能分叉的解析机制（tsx `paths` 与该条件）。单一锚点让一套机制（tsx `paths`）对源码平面保持权威。

## Consequences

源码启动下工具派发恢复正常，因为 `@deepseek-ai/dsh-tools`——以及每个同时被插件入口与文件内导入触及的 workspace 包——只加载一次，其模块级符号保持单一身份。现有的 `apps/cli/tests/agent-team-headless.e2e.ts` 钉住了这一点：它通过源码 bin 以 keyless fixture 模型驱动 `list_agents`、`workflow` 等工具，无锚点时以 `reading 'prepare'` 错误失败，有锚点时通过。

锚点仅限源码启动，故构建与安装态不受影响。所接受的代价：源码启动下，若某插件的包**不是** workspace `paths` 条目（一个仅装进隔离 profile 的 `node_modules` 的第三方插件），现在会以仓库锚点而非 profile 目录来解析；隔离第三方插件目前不属于源码开发闭环，而拥有该隔离 profile 场景的构建/安装态启动不受影响。
