// CEO orders (speech bar -> a session's inbox socket). Pure validation + gating, shared by the main
// process and tests. Delivery itself lives in electron/sessionInbox.ts.

export const ORDER_MAX_CHARS = 4000

export type OrderTarget = 'all' | string

export interface OrderRequest {
  /** 'all' = the whole office (every live top-level session), else one top-level agentId. */
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
export const REASON_NOT_CONNECTED = 'not connected (install the Claude Code hook — milestone 2)'
export const REASON_NO_SESSIONS = 'no active sessions'

export type OrderPlan = { ok: true; targets: string[]; text: string } | { ok: false; result: OrderResult }

const fail = (agentId: string, reason: string): OrderPlan => ({
  ok: false,
  result: { delivered: [], failed: [{ agentId, reason }] }
})

/**
 * Validates an untrusted order and applies the gate. `known` = live top-level agent ids.
 * Returns the sessions to deliver to, or a ready-made failed result.
 */
export function planOrder(input: unknown, opts: { allowOrders: boolean; known: readonly string[] }): OrderPlan {
  if (!input || typeof input !== 'object') return fail('', 'invalid order')
  const o = input as Record<string, unknown>
  const target = typeof o.target === 'string' ? o.target : ''
  if (typeof o.text !== 'string') return fail(target, 'invalid order: text must be a string')
  const text = o.text.trim()
  if (text.length < 1) return fail(target, 'invalid order: text is empty')
  if (o.text.length > ORDER_MAX_CHARS) return fail(target, `invalid order: text is longer than ${ORDER_MAX_CHARS} characters`)
  if (target.length === 0) return fail('', 'invalid order: no target')
  if (target !== 'all' && !opts.known.includes(target)) return fail(target, 'unknown session')
  if (!opts.allowOrders) return fail(target, REASON_DISABLED)
  const targets = target === 'all' ? [...opts.known] : [target]
  if (targets.length === 0) return fail('all', REASON_NO_SESSIONS)
  return { ok: true, targets, text }
}
