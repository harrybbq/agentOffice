// CEO orders (speech bar -> a session's inbox socket). Pure validation + gating, shared by the main
// process and tests. Delivery itself lives in electron/sessionInbox.ts.

export const ORDER_MAX_CHARS = 4000

/** 'all' | 'provider:<ProviderId or event provider>' | one top-level agentId (session id). */
export type OrderTarget = 'all' | string
export const PROVIDER_TARGET_PREFIX = 'provider:'

export interface OrderRequest {
  /** 'all' = the whole office (every live top-level session); 'provider:claude-code' = only that
   *  provider's sessions; else one top-level agentId. */
  target: OrderTarget
  text: string
}

export interface OrderFailure {
  agentId: string
  reason: string
}

export interface OrderResult {
  delivered: string[]
  failed: OrderFailure[]
}

export const REASON_DISABLED = 'CEO orders are disabled (tray → Allow CEO orders)'
export const REASON_NOT_CONNECTED = 'not hosted by Agent Office (start the session from the app to send it orders)'
export const REASON_NO_SESSIONS = 'no active sessions'

/** A live top-level session. A bare string is a session id whose provider is unknown. */
export type KnownSession = string | { id: string; provider: string }

export type OrderPlan = { ok: true; targets: string[]; text: string } | { ok: false; result: OrderResult }

const fail = (agentId: string, reason: string): OrderPlan => ({
  ok: false,
  result: { delivered: [], failed: [{ agentId, reason }] }
})

/**
 * Validates an untrusted order and applies the gate. `known` = live top-level sessions.
 * Targets: 'all', 'provider:<id>' (every live session of that provider) or one session id.
 * Returns the sessions to deliver to, or a ready-made failed result.
 */
export function planOrder(input: unknown, opts: { allowOrders: boolean; known: readonly KnownSession[] }): OrderPlan {
  if (!input || typeof input !== 'object') return fail('', 'invalid order')
  const o = input as Record<string, unknown>
  const target = typeof o.target === 'string' ? o.target.slice(0, 200) : ''
  if (typeof o.text !== 'string') return fail(target, 'invalid order: text must be a string')
  const text = o.text.trim()
  if (text.length < 1) return fail(target, 'invalid order: text is empty')
  if (o.text.length > ORDER_MAX_CHARS) return fail(target, `invalid order: text is longer than ${ORDER_MAX_CHARS} characters`)
  if (target.length === 0) return fail('', 'invalid order: no target')
  const known = opts.known.map((k) => (typeof k === 'string' ? { id: k, provider: '' } : k))
  const ids = known.map((k) => k.id)
  let targets: string[]
  // A session id wins over the prefix, in case a session is ever called "provider:…".
  if (target === 'all') targets = ids
  else if (ids.includes(target)) targets = [target]
  else if (target.startsWith(PROVIDER_TARGET_PREFIX)) {
    const provider = target.slice(PROVIDER_TARGET_PREFIX.length)
    if (provider.length === 0) return fail(target, 'invalid order: no provider')
    targets = known.filter((k) => k.provider === provider).map((k) => k.id)
  } else return fail(target, 'unknown session')
  if (!opts.allowOrders) return fail(target, REASON_DISABLED)
  if (targets.length === 0) return fail(target, REASON_NO_SESSIONS)
  return { ok: true, targets: [...targets], text }
}
