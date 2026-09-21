# Agent Note: Duplication-safe tool scheduler symbol under source launch

Status: implemented

[English](2026-09-19-duplication-safe-tool-scheduler-symbol.md) | 中文

## Problem

[源码启动](2026-07-29-dsh-source-launch-tsx-esm.zh.md)以 `node --import tsx/esm` 运行 `apps/cli/src/bin.ts`，tsx 通过 tsconfig `paths` 把仓库内的 workspace import 投射到 `src`——但只对位于仓库 tsconfig 之下的导入方生效；它依据导入方的位置。

Loader 通过 `internal.import(name, ctx.baseUrl)` 解析插件**入口**，而 `ctx.baseUrl` 是 profile 目录（`$DSH_HOME/profiles/<profile>/`），位于仓库之外。tsx 在那里找不到 tsconfig，于是像 `@deepseek-ai/dsh-agent-loop` 这样的插件入口 specifier 落到 Node 原生解析与包的 `exports`——即构建产物 `lib/`。而一旦该 `lib/` 模块运行起来，它自身位于仓库内的导入（`import … from '@deepseek-ai/dsh-tools'`）**确实**处在仓库 tsconfig 之下，于是被 tsx 重映射到 `src`。

因此一个从两个平面都被触及的 workspace 包会被加载两次：插件入口从 `lib` 拉一份，兄弟插件的文件内导入从 `src` 拉一份。两个模块实例本可相安无事，直到其中一方携带了对端必须共享的身份。`@deepseek-ai/dsh-tools` 暴露 `TOOL_RUNTIME_SCHEDULER`，用作 `ToolRuntime` 调度器字段的键。用模块级 `Symbol(...)` 时，每份副本各生成一个不同的符号：`ToolRuntime` 实例（`ctx.tools`，来自 `lib` 副本）用 `lib` 的符号存该字段；`dsh-agent-loop` 用 `src` 的符号去读 `ctx.tools[TOOL_RUNTIME_SCHEDULER]`，取到 `undefined`，于是每次工具派发都在 `startCall` 抛出 `Cannot read properties of undefined (reading 'prepare')`。纯文本回合从不派发工具，所以只有当某次运行调用任意工具时才会暴露。

## Decision

`TOOL_RUNTIME_SCHEDULER` 改用全局注册表符号——`Symbol.for('@deepseek-ai/dsh-tools.scheduler')`，而非模块级 `Symbol(...)`。重复的模块副本随后解析到同一个已注册符号，因此 `lib` 副本写在 `ctx.tools` 上的字段，正是 `src` 副本从 `dsh-agent-loop` 读到的字段；无论本次启动把 `@deepseek-ai/dsh-tools` 加载了一份还是两份，工具派发都正常。`unique symbol` 类型标注不变（在 `const` 上下文中 `Symbol.for` 同样产出 `unique symbol`），故计算键字段与 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 保持有类型。

此修复只动符号，不改 Loader 解析插件入口的方式。入口解析仍锚定在 profile 目录，因此把第三方插件装进自身 `node_modules` 的 profile 仍能解析到它。

## Alternatives considered

**把插件入口解析锚定到仓库内（源码启动时给 `boot()` 传仓库内的 `bareModuleBaseUrl`）。** 这会让 tsx `paths` 对插件入口也生效，从而整棵树保持在 `src` 平面、每个 workspace 包只加载一次。被否决——且在短暂上线后回退——因为它破坏了任何**非** workspace `paths` 条目的插件解析：仅装进 profile 自身 `node_modules` 的第三方插件（在 `$DSH_HOME/profiles/web/node_modules/` 下的 `dsh-better-sidebar` 已复现）不再能以仓库锚点解析，导致 import 失败；而它是客户端 shell 插件，会让 Web UI 卡在 loading 界面。profile 本地第三方插件是受支持的部署方式，因此强制把入口解析拉进仓库不可接受。

**整个启动都跑构建产物 `lib/`（放弃源码入口）。** 单一平面且正确，但会失去源码启动本就是为提供的零构建开发闭环。

**给每个包加一个 `src` export 条件，让 Node 解析在开发时到达 `src`。** 把平面选择推入整个 workspace 的包 `exports` 与一个启动设置的条件——改动面很大，且仍留下两套可能分叉的解析机制（tsx `paths` 与该条件）。

## Consequences

源码启动下工具派发恢复正常，因为调度器符号跨模块副本只有一个身份；而 Loader 仍以 profile 目录解析插件入口，故 profile 本地第三方插件（包括 Web UI 的侧栏 shell）继续正常导入。`apps/cli/tests/agent-team-headless.e2e.ts` 钉住派发路径：它通过源码 bin 以 keyless fixture 模型驱动 `list_agents`、`workflow` 等工具，无注册表符号时以 `reading 'prepare'` 错误失败，有则通过。

所接受的代价：源码启动下 workspace 包的双份加载仍然存在——一旦身份不再依赖单一模块实例，它就只是潜在的低效，而非正确性缺陷。任何**其他**必须跨平面边界保持单一身份的跨包值（另一个共享符号、一个按引用比较的哨兵对象）都必须同样用注册表符号或改为按值比较；一个用作跨包键的、新的模块级 `Symbol(...)` 会重新引入此故障。
