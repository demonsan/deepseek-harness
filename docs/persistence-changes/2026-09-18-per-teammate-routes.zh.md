---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-per-teammate-routes

[English](2026-09-18-per-teammate-routes.md) | 中文

## 概述

为 Agent Teams 的 member 记录新增两个可选的 per-teammate 字段：teammate 创建时所用的模型，以及取代它的成员的身份。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-per-teammate-routes
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "c0e8a744c1c5dbe369197d24840d7ba2bf2725257d2c3a75de9ac1354e174d94"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个字段都是在同一 Session 格式版本内对 `event:team/member` 的可选新增。在 per-teammate route 之前写入的记录两者皆无，且仍可正常回放：没有 `model` 的成员会报告它实际继承的 Lead route，没有 `supersededBy` 的成员就是从未被替换过的成员。反方向并不兼容——member schema 是 strict 的：早于这两个字段的读取方会拒绝携带任一字段的记录，因此 schema 变更必须与写入方一同发布。supersession 刻意没有做成 `phase` 取值，从而保持既有的 `provisioning` -> `active` | `failed` 枚举，以及所有依据它写入的记录继续有效。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team：94 个测试通过，覆盖了两个字段皆无的 member 记录回放、teammate 专属模型在其 Activation 消失后依然保留，以及一次 supersession 释放名字与 roster 槽位、而被取代的行保留自身结果。

<a id="dev-note"></a>
## 开发备注

无。
