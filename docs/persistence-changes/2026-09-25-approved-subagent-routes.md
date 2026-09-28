---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-25-approved-subagent-routes

English | [中文](2026-09-25-approved-subagent-routes.zh.md)

## Summary

Adds a log-only event that replaces one Session's child-route allowlist after the user explicitly approved the exact new list.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

This is a new root in the same Session format version. A log written before it carries no update record and replays to the policy it always had: the initial `subagent/model-selection-policy` capture, now reported as revision 1. The record names the revision it was computed from, and the fold rejects one whose revision does not match the policy it is applied to, so an update can never be applied on top of a different decision than the one the user saw. The reverse direction is not compatible: a reader that predates this event does not fold it and would keep the pre-update allowlist, so the reader must ship with the writer. The in-memory projection state gained its revision and moved to stateVersion 2, which discards cached checkpoints and rebuilds them from the log rather than reading an old shape.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/tool-subagent packages/experimental/tool-agent-team packages/experimental/agent-team: 282 tests passed. The acceptance case replays a Session whose log holds two captured routes and one approved update in a fresh runtime, and checks that discovery lists the approved route, dispatch reaches the provider for it, and an unapproved route is still refused. Other cases cover a declined or non-exact answer writing nothing, a stale revision refused at write time and by the fold, and a Session with no prior policy gaining the route fields after its first approved update.

<a id="dev-note"></a>
## Dev Note

None.
