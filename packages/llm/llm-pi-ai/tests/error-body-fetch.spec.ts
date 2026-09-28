import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { errorBodyFetch } from '../src/error-body-fetch.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const OVERFLOW_MESSAGE = 'Your input exceeds the context window of this model. Please adjust your input and try again.'

/** The AMD gateway's APIM wrapper around a backend OpenAI error body. */
const APIM_WRAPPER = JSON.stringify({
  elapsed: '00:00:07.2886583',
  llmService: 'AzureOpenAI',
  deploymentInfo: { id: 'pdue-aoai-009-gpt-6-astra', version: '2025-04-01-preview' },
  statusCode: 'BadRequest',
  response: {
    error: {
      message: OVERFLOW_MESSAGE,
      type: 'invalid_request_error',
      param: 'input',
      code: 'context_length_exceeded',
    },
  },
  message: 'Generate one or more predicted responses by AzureOpenAI returned BadRequest.',
})

/** The gateway's streaming-failure shape: nested error null, top-level message. */
const STREAM_WRAPPER = JSON.stringify({
  elapsed: '00:00:16.4314289',
  llmService: 'AzureOpenAI',
  statusCode: 'BadGateway',
  response: null,
  message: OVERFLOW_MESSAGE,
})

/** One scripted fetch response. */
function responseOf(status: number, body: string | null): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(body?.length ?? 0) },
  })
}

describe('errorBodyFetch', () => {
  it('passes success responses through without reading the body', async () => {
    const underlying = vi.fn(() => Promise.resolve(responseOf(200, '{"ok":true}')))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('leaves a standard OpenAI error shape byte-for-byte', async () => {
    const standard = JSON.stringify({ error: { message: 'standard failure', type: 'invalid_request_error' } })
    const underlying = vi.fn(() => Promise.resolve(responseOf(400, standard)))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(standard)
  })

  it('recovers the message from an APIM-wrapped error as plain text', async () => {
    const underlying = vi.fn(() => Promise.resolve(responseOf(400, APIM_WRAPPER)))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(OVERFLOW_MESSAGE)
  })

  it('recovers a gateway-authored top-level message as plain text', async () => {
    const underlying = vi.fn(() => Promise.resolve(responseOf(502, STREAM_WRAPPER)))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(response.status).toBe(502)
    expect(await response.text()).toBe(OVERFLOW_MESSAGE)
  })

  it('recovers a FastAPI-style detail string as plain text', async () => {
    const detail = "This model's maximum context length is 1048576 tokens. However, you requested 16 output tokens and your prompt contains at least 1048669 input tokens."
    const underlying = vi.fn(() => Promise.resolve(responseOf(400, JSON.stringify({ detail }))))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(detail)
  })

  it('keeps an empty error body empty', async () => {
    const underlying = vi.fn(() => Promise.resolve(responseOf(400, null)))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('')
  })

  it('keeps a non-JSON error body byte-for-byte', async () => {
    const underlying = vi.fn(() => Promise.resolve(responseOf(400, '<html>APIM error page</html>')))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(await response.text()).toBe('<html>APIM error page</html>')
  })

  it('keeps a JSON error body with no usable message byte-for-byte', async () => {
    const body = JSON.stringify({ statusCode: 'BadRequest' })
    const underlying = vi.fn(() => Promise.resolve(responseOf(400, body)))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(await response.text()).toBe(body)
  })

  it('reports the bare status when the body cannot be read', async () => {
    const unreadable = new Response(null, { status: 400 })
    Object.defineProperty(unreadable, 'text', { value: () => Promise.reject(new Error('socket dropped')) })
    const underlying = vi.fn(() => Promise.resolve(unreadable))
    const response = await errorBodyFetch(underlying)('https://gateway.example/v1')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('')
  })
})

describe('errorBodyFetch through the adapter', () => {
  it('surfaces an APIM-wrapped overflow message as CONTEXT_WINDOW_EXCEEDED', async () => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
    const server = await mockServer([{ status: 400, body: APIM_WRAPPER }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } },
    })

    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      })],
    })

    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    })
    expect(result.finish.kind === 'error' && result.finish.failure.message)
      .toContain('exceeds the context window')
  })
})
