---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-25-approved-subagent-routes

[English](2026-09-25-approved-subagent-routes.md) | 中文

## 概述

新增一个仅写入日志的事件：在用户明确批准确切的新列表后，替换单个 Session 的子代理路由允许列表。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-approved-subagent-routes
baseline: false
changes:
  - root: "event:subagent/model-selection-policy-update"
    previous: null
    after: "d56c14caff376741c36eec3aadd015c2b8911335123d06bfbda7d287b7fd32e1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是同一 Session 格式版本中的新根类型。在它之前写入的日志不含更新记录，重放后得到的仍是原有策略：最初的 `subagent/model-selection-policy` 捕获，现在报告为 revision 1。记录写明了它基于哪个 revision 计算，折叠时若 revision 与当前策略不符就拒绝，因此更新永远不会叠加到用户所见决定之外的另一个决定上。反向不兼容：早于此事件的读取方不会折叠它，会保留更新前的允许列表，所以读取方必须与写入方一同发布。内存中的 projection 状态增加了 revision，stateVersion 升为 2，这会丢弃缓存的检查点并从日志重建，而不是读取旧结构。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/tool-subagent packages/experimental/tool-agent-team packages/experimental/agent-team：282 个测试通过。验收用例在全新运行时中重放一个日志含两条捕获路由和一次已批准更新的 Session，检查发现结果列出已批准的路由、针对它的派发能到达 provider，未批准的路由仍被拒绝。其他用例覆盖：拒绝或非精确的回答不写入任何内容；过期 revision 在写入时和折叠时都被拒绝；原本没有策略的 Session 在首次批准更新后获得路由字段。

<a id="dev-note"></a>
## 开发备注

无。
