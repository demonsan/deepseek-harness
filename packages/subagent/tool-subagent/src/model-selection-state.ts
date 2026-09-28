/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { assertAllowedModelRoutes, modelRouteKey, type AllowedModelRoute } from './model-selection.ts'

/** How a user approved a Session route-policy update. */
export interface ModelSelectionApproval {
  /** The interaction channel that carried the decision. */
  readonly via: 'user-question'
  /** The option label the user selected. */
  readonly answer: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this session's delegation tool exposes child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
    }
    /**
     * Replaces this Session's route policy after the user explicitly approved
     * the exact new list. `expectedRevision` is the policy revision the
     * request was shown against (0 when the Session had no policy); the fold
     * rejects a record whose revision does not match, so a stale request can
     * never overwrite a newer decision. Log-only, like the initial capture.
     */
    'subagent/model-selection-policy-update': {
      /** Revision the approved change was computed from; 0 for none. */
      expectedRevision: number
      /** The complete approved route list that replaces the current one. */
      allowedModels: AllowedModelRoute[]
      /** The explicit user decision that authorized this record. */
      approval: ModelSelectionApproval
    }
  }
}

/** Durable route policy with its update revision. */
export interface ModelSelectionPolicyState {
  /** Exact routes authorized for child LLM selection. */
  readonly routes: AllowedModelRoute[]
  /** 1 for the initial capture, incremented by each approved update. */
  readonly revision: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Exact routes authorized for child LLM selection with their revision, or null when disabled. */
    subagentModelSelectionPolicy: ModelSelectionPolicyState | null
  }
}

const routeSchema = zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()

const modelSelectionPolicySchema: zod.ZodType<ModelSelectionPolicyState | null> = zod.object({
  routes: zod.array(routeSchema).min(1),
  revision: zod.number().int().min(1),
}).strict().nullable()

/** Validate one durable route list: well-formed, unique, and non-empty. */
function validRoutes(allowedModels: unknown, eventType: string): AllowedModelRoute[] {
  assertAllowedModelRoutes(allowedModels)
  if (allowedModels.length === 0) {
    throw new Error(`${eventType} requires at least one route`)
  }
  return allowedModels.map(route => ({ provider: route.provider, model: route.model }))
}

/** Host-only projection of the durable model-selection policy. */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  // 2: state gained its revision and folds approved updates.
  stateVersion: 2,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (event.type === 'subagent/model-selection-policy') {
      // The initial capture is once-only; a later duplicate is inert.
      if (policy !== null) return policy
      return { routes: validRoutes(event.data.allowedModels, event.type), revision: 1 }
    }
    if (event.type === 'subagent/model-selection-policy-update') {
      const current = policy?.revision ?? 0
      if (event.data.expectedRevision !== current) {
        throw new Error(
          `subagent/model-selection-policy-update expected revision ${String(event.data.expectedRevision)}, but the policy is at ${String(current)}`,
        )
      }
      return { routes: validRoutes(event.data.allowedModels, event.type), revision: current + 1 }
    }
    return policy
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', ModelSelectionPolicyState | null>

/**
 * Read the exact route list currently authorized for a model-selectable definition.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose durable decision is read.
 * @returns a detached route list, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return projections.stateOf(session, 'subagentModelSelectionPolicy')?.routes.map(route => ({ ...route }))
}

/**
 * Read the current policy revision.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose durable decision is read.
 * @returns the revision, or 0 when the Session has no policy.
 */
export function subagentModelSelectionRevision(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): number {
  return projections.stateOf(session, 'subagentModelSelectionPolicy')?.revision ?? 0
}

/** Structural view of the Host setting read for Sessions without a recorded decision. */
export interface ModelSelectionSettingsReader {
  current(): { enabled: boolean; allowedModels: readonly AllowedModelRoute[] }
}

/**
 * Resolve the routes a Session is authorized to select, without recording anything.
 *
 * One definition shared by every consumer — delegation discovery, delegation
 * dispatch, and teammate routes — so no two of them can disagree:
 * the Session's own durable decision; else its parent's; else, for a fresh
 * top-level Session or a child whose parent never decided, the current Host
 * setting. A resumed top-level Session without a decision stays fixed-route:
 * its schema must not change underneath its history without an approval.
 * @param projections - registry that owns the policy projection.
 * @param sessions - live Session lookup for the parent, when available.
 * @param settings - Host setting, when available.
 * @param target - Session whose authority is resolved.
 * @returns exact routes, or undefined when the Session is fixed-route.
 */
export function resolveModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  sessions: { get(id: SessionId): Session | undefined } | undefined,
  settings: ModelSelectionSettingsReader | undefined,
  target: Session,
): AllowedModelRoute[] | undefined {
  const own = subagentModelSelectionPolicy(projections, target)
  if (own !== undefined) return own
  const freshSession = target.firstLiveSeq === 0
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    && target.eventAt(SessionSeq(0))?.type !== 'session/end-seed'
  const parentId = target.header.origin === 'subagent' ? target.header.parentSession : undefined
  if (parentId !== undefined) {
    if (sessions === undefined) {
      throw new Error('tool-subagent: child model-selection inheritance requires the Session registry')
    }
    const parent = sessions.get(parentId)
    const inherited = parent === undefined ? undefined : subagentModelSelectionPolicy(projections, parent)
    if (inherited !== undefined) return inherited
  }
  // A child whose parent never captured a decision (the parent predates the
  // opt-in, or was resumed without the policy event) would otherwise be
  // permanently fixed-route, which also pins every Agent-Team teammate to the
  // Lead route. Sample the current Host setting for it, as for a fresh
  // top-level Session.
  if (parentId !== undefined || freshSession) {
    const current = settings?.current()
    return current?.enabled === true ? current.allowedModels.map(route => ({ ...route })) : undefined
  }
  return undefined
}

/**
 * Append the route policy once, before its definition can reach a model request.
 * @param projections - registry that owns the policy projection.
 * @param session - session receiving the model-selectable definition.
 * @param allowedModels - exact routes the definition may select explicitly.
 */
export function recordSubagentModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  allowedModels: readonly AllowedModelRoute[],
): void {
  if (subagentModelSelectionPolicy(projections, session) !== undefined) return
  session.append('subagent/model-selection-policy', {
    allowedModels: allowedModels.map(route => ({ ...route })),
  })
}

/** A proposed change, computed against one policy revision. */
export interface ModelSelectionChange {
  /** Revision the change was computed from; 0 when the Session had no policy. */
  readonly expectedRevision: number
  /** Routes before the change. */
  readonly before: AllowedModelRoute[]
  /** The complete route list that would replace them. */
  readonly after: AllowedModelRoute[]
  /** Routes in `after` but not `before`. */
  readonly added: AllowedModelRoute[]
  /** Routes in `before` but not `after`. */
  readonly removed: AllowedModelRoute[]
}

/**
 * Compute a route-policy change against the current durable revision.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose policy would change.
 * @param add - routes to authorize.
 * @param remove - routes to withdraw.
 * @returns the proposed change; `added` and `removed` are empty when nothing would change.
 */
export function proposeModelSelectionChange(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  add: readonly AllowedModelRoute[],
  remove: readonly AllowedModelRoute[],
): ModelSelectionChange {
  assertAllowedModelRoutes(add)
  assertAllowedModelRoutes(remove)
  const before = subagentModelSelectionPolicy(projections, session) ?? []
  const removing = new Set(remove.map(modelRouteKey))
  const kept = before.filter(route => !removing.has(modelRouteKey(route)))
  const present = new Set(kept.map(modelRouteKey))
  const after = [...kept, ...add.filter(route => !present.has(modelRouteKey(route))).map(route => ({ ...route }))]
  const beforeKeys = new Set(before.map(modelRouteKey))
  const afterKeys = new Set(after.map(modelRouteKey))
  return {
    expectedRevision: subagentModelSelectionRevision(projections, session),
    before,
    after,
    added: after.filter(route => !beforeKeys.has(modelRouteKey(route))),
    removed: before.filter(route => !afterKeys.has(modelRouteKey(route))),
  }
}

/**
 * Append an approved policy update, re-checking the revision at write time.
 *
 * The caller obtained `approval` from the user for exactly `change.after`
 * at `change.expectedRevision`. If the policy moved while the user was
 * deciding, the decision was about a list that no longer exists, so the write
 * is refused rather than applied to a different base.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose policy changes.
 * @param change - the proposal the user approved.
 * @param approval - the explicit user decision.
 * @returns the new revision.
 */
export function applyApprovedModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  change: ModelSelectionChange,
  approval: ModelSelectionApproval,
): number {
  const current = subagentModelSelectionRevision(projections, session)
  if (current !== change.expectedRevision) {
    throw new Error(
      `the route policy changed while awaiting approval (revision ${String(change.expectedRevision)} → ${String(current)}); request the change again`,
    )
  }
  if (change.after.length === 0) {
    throw new Error('a model-selection policy must keep at least one route')
  }
  session.append('subagent/model-selection-policy-update', {
    expectedRevision: change.expectedRevision,
    allowedModels: change.after.map(route => ({ ...route })),
    approval: { ...approval },
  })
  return subagentModelSelectionRevision(projections, session)
}
