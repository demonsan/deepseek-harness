---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-per-teammate-routes

English | [中文](2026-09-18-per-teammate-routes.zh.md)

## Summary

Adds two optional per-teammate fields to the Agent Teams member record: the model a teammate was created on, and the identity of the member that replaced it.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both fields are optional additions to `event:team/member` in the same Session format version. A record written before per-teammate routes carries neither and still replays: a member without `model` reports the Lead route it actually inherited, and a member without `supersededBy` is simply one that was never replaced. The reverse direction is not compatible, because the member schema is strict: a reader that predates these fields refuses a record carrying either, so the schema change must ship together with the writer. Supersession is deliberately not a `phase` value, which keeps the existing `provisioning` -> `active` | `failed` enum and every record written against it valid.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team: 94 tests passed, covering replay of a member record without either field, a teammate-specific model surviving the loss of its Activation, and a supersession that releases its name and roster slot while the superseded row keeps its own outcome.

<a id="dev-note"></a>
## Dev Note

None.
