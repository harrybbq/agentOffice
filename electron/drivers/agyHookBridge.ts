// The `/hooks/agy` ingest route: where the hook script of a hosted Antigravity session
// (hook/agy-hook.cjs) posts agy's hook payloads. For `PreToolUse` the request is a QUESTION and the
// response is held open until the session's driver has an answer: at once from the policy
// (agyPolicy.ts), or when the user decided in the CEO inbox. This is the design of the Claude
// PermissionRequest hook with a script in between, because agy only has command hooks.
//
// Security: there is no route that takes a decision. A decision only ever comes out of
// PermissionRegistry.decide(), which only renderer IPC calls. An agent that knows its hook token
// (it is in its environment) can ask more questions, and nothing else. The token only works here
// (ingest/auth.ts), and whatever goes wrong the answer to `PreToolUse` is a deny.
//
// No Electron imports.
import type { EventSink, HttpAdapter, RequestContext } from '../adapters/types'
import { AGY_HOOK_ROUTE } from '../ingest/auth'

/** Hook payloads carry file contents (a whole file for `write_to_file`). */
export const AGY_HOOKS_MAX_BODY = 4 * 1024 * 1024
/** The hook events the app registers, and so the only ones the route passes on. */
export const AGY_HOOK_EVENTS = ['PreToolUse', 'PreInvocation'] as const
export type AgyHookEvent = (typeof AGY_HOOK_EVENTS)[number]

/** A hosted agy session's driver, as far as this route cares. */
export interface AgyHookTarget {
  handleAgyHook(event: AgyHookEvent, payload: Record<string, unknown>, ctx: RequestContext): unknown | Promise<unknown>
}

export interface AgyHookTargets {
  /** The driver of a live hosted Antigravity session, by app session id. */
  agyHookTarget(sessionId: string): AgyHookTarget | undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** agy's hook result for "no": the gate fails closed, the other events are no-ops. */
export function agyHookRefusal(event: unknown, reason: string): Record<string, unknown> {
  return event === 'PreToolUse' ? { decision: 'deny', reason } : {}
}

/** `targets` may be given later (the session manager is built after the adapter in some stacks). */
export function createAgyHooksAdapter(targets: AgyHookTargets | (() => AgyHookTargets | null | undefined)): HttpAdapter {
  const resolve = typeof targets === 'function' ? targets : () => targets
  return {
    route: AGY_HOOK_ROUTE,
    maxBody: AGY_HOOKS_MAX_BODY,
    async handle(raw: unknown, _sink: EventSink, ctx: RequestContext): Promise<unknown> {
      const event = isRecord(raw) ? raw.event : undefined
      // The server already refuses every other token on this route; this is the second lock.
      if (ctx.auth.kind !== 'agy') return agyHookRefusal(event, 'Agent Office did not recognise this session.')
      if (!isRecord(raw) || !isRecord(raw.payload) || !(AGY_HOOK_EVENTS as readonly unknown[]).includes(event)) {
        return agyHookRefusal(event, 'Agent Office could not read this request.')
      }
      const target = resolve()?.agyHookTarget(ctx.auth.sessionId)
      if (!target) return agyHookRefusal(event, 'This Agent Office session has ended.')
      try {
        const answer = await target.handleAgyHook(event as AgyHookEvent, raw.payload, ctx)
        return isRecord(answer) ? answer : agyHookRefusal(event, 'Agent Office had no answer.')
      } catch {
        return agyHookRefusal(event, 'Agent Office failed while checking this action.')
      }
    }
  }
}
