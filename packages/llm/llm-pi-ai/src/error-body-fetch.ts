/**
 * Fetch wrapper that recovers provider error messages hidden behind gateway
 * wrapper shapes.
 *
 * Gateways in front of OpenAI-compatible endpoints (Azure API Management and
 * kin) often wrap the backend's error body instead of passing it through:
 * the real `{"error":{"message":...}}` lands at `response.error` while the
 * top level carries gateway metadata (`elapsed`, `llmService`, `message`).
 * The OpenAI SDK only reads the standard top-level `error` field, so a
 * wrapped rejection degrades to `"400 status code (no body)"` — the one
 * string that tells the operator nothing, and that the Harness overflow
 * classifier cannot recognize as `CONTEXT_WINDOW_EXCEEDED`, silently
 * disabling compaction recovery for exactly the failures that need it.
 *
 * The wrapper replaces a non-2xx response body with the recovered message as
 * plain text when it can find one inside a known wrapper: `response.error.
 * message` (APIM-style nesting) or a top-level `message` string. Plain text
 * is deliberate: the SDK folds an unparseable body into its error message
 * verbatim, and pi-ai then keeps that message, so the operator reads
 * `OpenAI API error (502): Your input exceeds the context window …` instead
 * of a JSON-embedded fragment. Bodies that already carry the standard shape,
 * carry no usable message, or are not JSON pass through byte-for-byte; only
 * error statuses are touched at all, so streaming and success paths pay no
 * read.
 *
 * @module dsh-llm-pi-ai/error-body-fetch
 */

import type { FetchFunction } from '@earendil-works/pi-ai'

/** Read a standard `{error: {message}}` member, the shape the SDK already parses. */
function standardMessage(record: Record<string, unknown>): string | undefined {
  const error = record.error
  if (typeof error !== 'object' || error === null) return undefined
  const message = (error as Record<string, unknown>).message
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

/**
 * Find a better error message inside a parsed error body, or `undefined` when
 * the body needs no rewrite. The standard shape is deliberately absent from
 * the result: it is the one the SDK consumes unaided, so rewriting it would
 * only risk losing fields.
 */
function extractWrappedMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (standardMessage(record) !== undefined) return undefined
  // APIM-style nesting: the backend's standard error object one level down.
  const nested = record.response
  if (typeof nested === 'object' && nested !== null) {
    const message = standardMessage(nested as Record<string, unknown>)
    if (message !== undefined) return message
  }
  // Gateway-authored top-level message with no structured error anywhere.
  if (typeof record.message === 'string' && record.message.length > 0) {
    return record.message
  }
  // FastAPI-style detail (vLLM and other OpenAI-compatible servers): the
  // whole reason is one string under `detail`.
  if (typeof record.detail === 'string' && record.detail.length > 0) {
    return record.detail
  }
  return undefined
}

/**
 * Rebuild an error response carrying the recovered message as plain text.
 * `content-length` and `content-encoding` describe the original (possibly
 * compressed) payload and must not survive a body swap.
 */
function rewrittenResponse(response: Response, message: string): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.set('content-type', 'text/plain; charset=utf-8')
  return new Response(message, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Rebuild an error response with its original body and refreshed metadata. */
function passthroughResponse(response: Response, body: string | null): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Wrap a fetch implementation so gateway-wrapped error bodies reach the
 * OpenAI SDK as a message it can surface. Unrecognized failures are returned
 * with their original body, so the wrapper never narrows what an endpoint
 * can say.
 * @param underlying - the fetch to wrap; defaults to the global one.
 * @returns a drop-in fetch for pi-ai's `ProviderRequestOptions.fetch`.
 */
export function errorBodyFetch(underlying: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const response = await underlying(input, init)
    if (response.status < 400) return response
    let text: string
    try {
      text = await response.text()
    } catch {
      // An unreadable body stays unreadable; report the bare status exactly as
      // the unwrapped fetch would have.
      return passthroughResponse(response, null)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Non-JSON error bodies (HTML error pages, plain text) keep their bytes.
      return passthroughResponse(response, text)
    }
    const message = extractWrappedMessage(parsed)
    if (message === undefined) return passthroughResponse(response, text)
    return rewrittenResponse(response, message)
  }
}
