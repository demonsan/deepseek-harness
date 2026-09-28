/**
 * User-approved updates to a Session's child-route allowlist: the durable
 * record, what discovery and dispatch see after it, and that it survives a
 * restart while unapproved routes stay rejected.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import { APPROVE_LABEL, DECLINE_LABEL, parseRoutes } from '../src/model-selection-approval.ts'
import {
  applyApprovedModelSelection,
  proposeModelSelectionChange,
  subagentModelSelectionPolicy,
  subagentModelSelectionRevision,
} from '../src/model-selection-state.ts'
import { testToolSignal, text } from './harness.ts'

/** Catalog adapter: every model resolves, so only authority decides. */
class CatalogAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['fast', 'plain', 'slow'].map(id => ({ provider, id, name: id })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

type Answer = { selected: string[]; custom?: string }

/** Test answerer standing in for the user. */
class ScriptedQuestions extends Service {
  answers: Answer[] = []
  asked: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
  }

  ask(request: { questions: { id: string; question: string }[] }) {
    const question = request.questions[0]!
    this.asked.push(question.question)
    const answer = this.answers.shift() ?? { selected: [DECLINE_LABEL] }
    return Promise.resolve({ answers: [{ id: question.id, ...answer }] })
  }
}

const HOST_ROUTES = [
  { provider: 'alpha', model: 'fast' },
  { provider: 'beta', model: 'fast' },
]

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function boot(host = HOST_ROUTES) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: host })
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['alpha', 'beta', 'gamma'], new CatalogAdapter())
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ScriptedQuestions)
  const preset = createScope(ctx, { preset: 'approval-test' })
  await preset.ctx.plugin(tool, { provider: 'spawn', modelSelectionSettings: true, backgroundMode: 'continuable' })
  const questions = ctx.get('userQuestions') as ScriptedQuestions
  const createAgent = async (id: string, seed?: readonly SessionEvent[]) => (await ctx.agents.create({
    sessionId: SessionId(id),
    ...seed === undefined ? {} : { seed },
    setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
  })).agent
  return { ctx, questions, createAgent }
}

type TestAgent = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['createAgent']>>

let calls = 0
function call(ctx: Context, agent: TestAgent, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`call-${++calls}`), name, arguments: args, agent })
}

const has = (ctx: Context, agent: TestAgent, name: string) => ctx.tools.schemas(agent).some(schema => schema.name === name)

/** Stop at the provider boundary: reaching it proves authority and route preflight passed. */
function stopAtDispatch() {
  return vi.spyOn(SubagentRuntime.prototype, 'startContinuable').mockRejectedValue(new Error('dispatch reached'))
}

describe('user-approved child-route allowlist updates', () => {
  it('two routes → user approves a third → discovery and dispatch see it → restart keeps it', async () => {
    const { ctx, questions, createAgent } = await boot()
    const lead = await createAgent('approval-lead')
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, lead.session)).toEqual(HOST_ROUTES)
    expect(subagentModelSelectionRevision(ctx.sessionProjections, lead.session)).toBe(1)
    expect(has(ctx, lead, 'request_subagent_model_routes')).toBe(true)

    // Before approval: not discoverable, and dispatch refuses it.
    expect(text(await call(ctx, lead, 'list_subagent_models', { provider: 'gamma' }))).toMatch(/not|no /i)
    const dispatch = stopAtDispatch()
    const early = await call(ctx, lead, 'subagent', { description: 'd', prompt: 'p', provider: 'gamma', model: 'slow' })
    expect(text(early)).toContain('is not allowed for this Session')
    expect(dispatch).not.toHaveBeenCalled()

    questions.answers.push({ selected: [APPROVE_LABEL] })
    const approved = await call(ctx, lead, 'request_subagent_model_routes', { add: ['gamma/slow'], reason: 'needs a slow model' })
    expect(approved.isError).toBe(false)
    expect(JSON.parse(text(approved))).toEqual({
      status: 'approved', revision: 2, allowedModels: ['alpha/fast', 'beta/fast', 'gamma/slow'],
    })
    expect(questions.asked[0]).toContain('+ gamma / slow')
    expect(questions.asked[0]).toContain('revision 1 → 2')

    // After approval: discovery lists it and dispatch passes the authority and route preflight.
    expect(text(await call(ctx, lead, 'list_subagent_models', { provider: 'gamma' }))).toContain('gamma/slow')
    const late = await call(ctx, lead, 'subagent', { description: 'd', prompt: 'p', provider: 'gamma', model: 'slow' })
    expect(text(late)).toContain('dispatch reached')
    expect(dispatch).toHaveBeenCalledTimes(1)

    // A route nobody approved is still refused, before dispatch.
    const unapproved = await call(ctx, lead, 'subagent', { description: 'd', prompt: 'p', provider: 'gamma', model: 'plain' })
    expect(text(unapproved)).toContain('"gamma/plain" is not allowed for this Session')
    expect(dispatch).toHaveBeenCalledTimes(1)

    // The Host setting was neither read into nor written by the update.
    expect(ctx.subagentModelSelection.current().allowedModels).toEqual(HOST_ROUTES)

    // Restart: a new runtime rebuilt from the durable log alone.
    const log = lead.session.snapshotEvents()
    expect(log.filter(event => event.type === 'subagent/model-selection-policy-update')).toHaveLength(1)
    const restarted = await boot()
    const resumed = await restarted.createAgent('approval-lead-resumed', log)
    expect(subagentModelSelectionPolicy(restarted.ctx.sessionProjections, resumed.session))
      .toEqual([...HOST_ROUTES, { provider: 'gamma', model: 'slow' }])
    expect(subagentModelSelectionRevision(restarted.ctx.sessionProjections, resumed.session)).toBe(2)
    expect(text(await call(restarted.ctx, resumed, 'list_subagent_models', { provider: 'gamma' }))).toContain('gamma/slow')
    const afterRestart = await call(restarted.ctx, resumed, 'subagent', { description: 'd', prompt: 'p', provider: 'gamma', model: 'slow' })
    expect(text(afterRestart)).toContain('dispatch reached')
    const stillRefused = await call(restarted.ctx, resumed, 'subagent', { description: 'd', prompt: 'p', provider: 'gamma', model: 'plain' })
    expect(text(stillRefused)).toContain('is not allowed for this Session')
  })

  it('changes nothing unless the user selects exactly the approval option', async () => {
    const { ctx, questions, createAgent } = await boot()
    const lead = await createAgent('declining-lead')
    for (const answer of [
      { selected: [DECLINE_LABEL] },
      { selected: [], custom: 'Approve' },
      { selected: ['approve'] },
      { selected: [APPROVE_LABEL, DECLINE_LABEL] },
    ]) {
      questions.answers.push(answer)
      const result = await call(ctx, lead, 'request_subagent_model_routes', { add: ['gamma/slow'] })
      expect(JSON.parse(text(result))).toMatchObject({ status: 'declined', revision: 1 })
    }
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, lead.session)).toEqual(HOST_ROUTES)
    expect(lead.session.snapshotEvents().some(event => event.type === 'subagent/model-selection-policy-update')).toBe(false)
  })

  it('refuses a change without a user to ask, and an unresolvable route before asking', async () => {
    const { ctx, questions, createAgent } = await boot()
    const lead = await createAgent('guarded-lead')
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockRejectedValueOnce(new Error('unknown model'))
    const unknown = await call(ctx, lead, 'request_subagent_model_routes', { add: ['gamma/nope'] })
    expect(text(unknown)).toContain('cannot be resolved')
    expect(questions.asked).toEqual([])
    expect(text(await call(ctx, lead, 'request_subagent_model_routes', {}))).toContain('name at least one route')
    expect(() => parseRoutes(['no-slash'], 'add')).toThrow('provider/model')
    expect(parseRoutes(['local-kimi-k3/moonshotai/Kimi-K3'], 'add'))
      .toEqual([{ provider: 'local-kimi-k3', model: 'moonshotai/Kimi-K3' }])
  })

  it('rejects an approval computed against a revision that has since moved', async () => {
    const { ctx, createAgent } = await boot()
    const lead = await createAgent('stale-lead')
    const stale = proposeModelSelectionChange(ctx.sessionProjections, lead.session, [{ provider: 'gamma', model: 'slow' }], [])
    applyApprovedModelSelection(ctx.sessionProjections, lead.session,
      proposeModelSelectionChange(ctx.sessionProjections, lead.session, [{ provider: 'gamma', model: 'plain' }], []),
      { via: 'user-question', answer: APPROVE_LABEL })
    expect(() => applyApprovedModelSelection(ctx.sessionProjections, lead.session, stale, { via: 'user-question', answer: APPROVE_LABEL }))
      .toThrow('changed while awaiting approval')
    expect(subagentModelSelectionRevision(ctx.sessionProjections, lead.session)).toBe(2)

    // A stale record that reached the log anyway is rejected by the fold itself.
    const forged = Session.create(SessionId('forged'))
    forged.append('subagent/model-selection-policy', { allowedModels: HOST_ROUTES })
    forged.append('subagent/model-selection-policy-update', {
      expectedRevision: 5, allowedModels: HOST_ROUTES, approval: { via: 'user-question', answer: APPROVE_LABEL },
    })
    expect(() => subagentModelSelectionPolicy(ctx.sessionProjections, forged)).toThrow('expected revision 5, but the policy is at 1')
  })

  it('gives a Session that never had a policy the route fields once the user approves one', async () => {
    const { ctx, questions, createAgent } = await boot()
    // A resumed top-level Session without a decision is fixed-route: the Host
    // setting is not silently applied to it.
    const legacy = await createAgent('legacy-lead', [])
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, legacy.session)).toBeUndefined()
    expect(has(ctx, legacy, 'list_subagent_models')).toBe(false)
    expect(has(ctx, legacy, 'request_subagent_model_routes')).toBe(true)

    questions.answers.push({ selected: [APPROVE_LABEL] })
    const approved = await call(ctx, legacy, 'request_subagent_model_routes', { add: ['alpha/fast', 'gamma/slow'] })
    expect(JSON.parse(text(approved))).toMatchObject({ status: 'approved', revision: 1 })
    expect(questions.asked[0]).toContain('revision 0 → 1')

    await vi.waitFor(() => { expect(has(ctx, legacy, 'list_subagent_models')).toBe(true) })
    const schema = ctx.tools.schemas(legacy).find(candidate => candidate.name === 'subagent')
    expect((schema?.parameters as { properties?: Record<string, unknown> }).properties).toHaveProperty('provider')
    expect(text(await call(ctx, legacy, 'list_subagent_models', { provider: 'gamma' }))).toContain('gamma/slow')
    // Only the approved routes, not the Host list.
    const dispatch = stopAtDispatch()
    expect(text(await call(ctx, legacy, 'subagent', { description: 'd', prompt: 'p', provider: 'beta', model: 'fast' })))
      .toContain('is not allowed for this Session')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('resolves teammate authority from the Session, not the Host setting', async () => {
    const { ctx, questions, createAgent } = await boot()
    const lead = await createAgent('teammate-authority-lead')
    questions.answers.push({ selected: [APPROVE_LABEL] })
    await call(ctx, lead, 'request_subagent_model_routes', { add: ['gamma/slow'], remove: ['beta/fast'] })
    expect(ctx.subagentModelSelection.allowedModelsFor(lead.session))
      .toEqual([{ provider: 'alpha', model: 'fast' }, { provider: 'gamma', model: 'slow' }])
    expect(ctx.subagentModelSelection.current().allowedModels).toEqual(HOST_ROUTES)
    expect(ctx.subagentModelSelection.allowedModelsFor(Session.create(SessionId('never-composed'), [])))
      .toBeUndefined()
  })
})
