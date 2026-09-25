/**
 * User-approved updates to one Session's child-route allowlist.
 *
 * The model may propose a change, but the durable record is written only
 * after the user answers an explicit approval question naming the exact
 * resulting list and the revision it replaces. The Host setting is not
 * copied into the Session: every route the Session gains, the user approved
 * for that Session.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AllowedModelRoute } from './model-selection.ts'
import {
  applyApprovedModelSelection,
  proposeModelSelectionChange,
  type ModelSelectionChange,
} from './model-selection-state.ts'

/** The one answer that authorizes the write. */
export const APPROVE_LABEL = 'Approve'
/** The explicit refusal offered beside it. */
export const DECLINE_LABEL = 'Decline'

/** Structural view of the user-question service; absence fails closed. */
interface UserQuestionsView {
  ask(request: {
    questions: {
      id: string
      question: string
      header?: string
      options?: { label: string; description?: string }[]
    }[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: readonly { id: string; selected: readonly string[]; custom?: string }[] }>
}

/** Structural view of the LLM runtime used to reject unknown routes before asking. */
interface ModelInfoView {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
}

/**
 * Parse `provider/model` route strings. The model part may itself contain
 * slashes (`local-kimi-k3/moonshotai/Kimi-K3`), so only the first slash splits.
 * @param values - model-supplied route strings.
 * @param field - argument name for diagnostics.
 * @returns exact routes.
 */
export function parseRoutes(values: readonly string[] | undefined, field: string): AllowedModelRoute[] {
  return (values ?? []).map((value) => {
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) {
      throw new Error(`${field}: "${value}" must be written as provider/model`)
    }
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
  })
}

const routeText = (route: AllowedModelRoute): string => `${route.provider} / ${route.model}`

/** The approval question: the exact resulting list, what changes, and the revision replaced. */
function approvalQuestion(change: ModelSelectionChange, reason: string | undefined): string {
  const lines = [
    `Update the child model allowlist for this session (revision ${String(change.expectedRevision)} → ${String(change.expectedRevision + 1)})?`,
    ...reason === undefined ? [] : ['', `Reason: ${reason}`],
    '',
    ...change.added.map(route => `+ ${routeText(route)}`),
    ...change.removed.map(route => `- ${routeText(route)}`),
    '',
    'Resulting allowlist:',
    ...change.after.map(route => `  ${routeText(route)}`),
    '',
    'This affects this session only. It does not change the Host setting or other sessions.',
  ]
  return lines.join('\n')
}

/**
 * Register the approval tool in one Session's tool scope.
 * @param runtimeCtx - scope that owns the tool registration.
 * @param session - the Session whose policy the tool changes.
 * @param onApproved - called after an approved update is durable, with the revision it replaced.
 */
export function registerModelRouteApproval(
  runtimeCtx: Context,
  session: Session,
  onApproved: (previousRevision: number) => void,
): void {
  runtimeCtx.tools.register(defineTool({
    name: 'request_subagent_model_routes',
    description: 'Ask the user to change which child LLM routes this session may select for subagents and teammates. '
      + 'The user sees the exact resulting allowlist and must approve it; nothing changes otherwise. '
      + 'Write routes as provider/model, the way list_subagent_models reports them. '
      + 'Use only when the user wants a route that is not currently allowed.',
    parameters: {
      add: {
        type: 'array',
        description: 'Routes to allow, each as provider/model.',
        items: { type: 'string' },
      },
      remove: {
        type: 'array',
        description: 'Routes to stop allowing, each as provider/model.',
        items: { type: 'string' },
      },
      reason: {
        type: 'string',
        description: 'One sentence shown to the user explaining why the change is needed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['approved', 'declined', 'unchanged'] },
          revision: { type: 'number', required: true },
          allowedModels: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const add = parseRoutes(args.add, 'add')
      const remove = parseRoutes(args.remove, 'remove')
      if (add.length === 0 && remove.length === 0) {
        throw new Error('request_subagent_model_routes: name at least one route to add or remove')
      }
      const projections = runtimeCtx.get('sessionProjections')
      if (projections === undefined) {
        throw new Error('request_subagent_model_routes: the session projection registry is unavailable')
      }
      // Reject a route the runtime cannot resolve before asking the user to approve it.
      const llm = runtimeCtx.get('llm') as ModelInfoView | undefined
      if (llm === undefined) {
        throw new Error('request_subagent_model_routes: cannot validate routes because the `llm` service is unavailable')
      }
      for (const route of add) {
        try {
          await llm.resolveModelInfo(route.provider, route.model, exec.signal)
        } catch (error: unknown) {
          throw new Error(`request_subagent_model_routes: route "${route.provider}/${route.model}" cannot be resolved: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
      const change = proposeModelSelectionChange(projections, session, add, remove)
      const listed = (routes: readonly AllowedModelRoute[]) => routes.map(route => `${route.provider}/${route.model}`)
      if (change.added.length === 0 && change.removed.length === 0) {
        return { status: 'unchanged' as const, revision: change.expectedRevision, allowedModels: listed(change.before) }
      }
      if (change.after.length === 0) {
        throw new Error('request_subagent_model_routes: the allowlist must keep at least one route')
      }
      // Fail closed: without a human answerer there is no approval.
      const questions = runtimeCtx.get('userQuestions') as UserQuestionsView | undefined
      if (questions === undefined) {
        throw new Error('request_subagent_model_routes: no user can be asked in this session, so the allowlist cannot change')
      }
      const answer = await questions.ask({
        questions: [{
          id: 'subagent-model-routes',
          header: 'Model allowlist',
          question: approvalQuestion(change, args.reason),
          options: [
            { label: APPROVE_LABEL, description: 'Allow exactly the resulting list for this session.' },
            { label: DECLINE_LABEL, description: 'Keep the current allowlist.' },
          ],
        }],
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        signal: exec.signal,
      })
      const selected = answer.answers.find(item => item.id === 'subagent-model-routes')?.selected ?? []
      // Only the exact approval label authorizes the write; free text or any
      // other selection is a refusal.
      if (selected.length !== 1 || selected[0] !== APPROVE_LABEL) {
        return { status: 'declined' as const, revision: change.expectedRevision, allowedModels: listed(change.before) }
      }
      const revision = applyApprovedModelSelection(projections, session, change, {
        via: 'user-question',
        answer: APPROVE_LABEL,
      })
      onApproved(change.expectedRevision)
      return { status: 'approved' as const, revision, allowedModels: listed(change.after) }
    },
  }))
}
