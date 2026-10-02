// What the user is asked about. Requested by the user in so many words: "auto-approval should say yes
// to everything other than very high risk permissions" and "auto-approve should save the high-risks
// and keep the workers working until the user steps in".
//
//   all        every permission request comes to the user (the agent waits)
//   important  routine work inside the project is allowed automatically; the rest comes to the user
//   auto       everything is allowed automatically EXCEPT dangerous requests. A dangerous request is
//              not left blocking the agent: it is refused for now with a fixed "held for the user"
//              message, saved in the Held list, and the agent carries on with its other work. When
//              the user approves a held request, the agent is told and its retry is let through once.
//
// Rules that hold in every mode:
// - A dangerous request (risk 'danger': deleting folders, force push, discarding work, running
//   downloaded code, admin rights, secrets, agent settings) is NEVER allowed without the user.
// - The decision is made by fixed rules on the request the user would see (shared/permissionText.ts),
//   never by a model, and never from text an agent supplies about itself.
// - Everything allowed automatically is listed for the user ("Handled for you").

import type { PermissionRisk } from './permissionText'
import type { ProviderId } from './sessions'

export type ApprovalMode = 'all' | 'important' | 'auto'
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'auto'

export const isApprovalMode = (v: unknown): v is ApprovalMode => v === 'all' || v === 'important' || v === 'auto'

export type ApprovalVerdict =
  | 'ask' //   a card in the CEO inbox; the agent waits for the answer
  | 'allow' // answered "allow" by the app; listed under "Handled for you"
  | 'hold' //  refused for now, saved for the user; the agent keeps working on other things

export interface ApprovalSubject {
  risk: PermissionRisk
  /** Routine work inside the project (PlainPermission.routine). */
  routine: boolean
}

/** The one place the rule lives. */
export function approvalVerdict(mode: ApprovalMode, subject: ApprovalSubject): ApprovalVerdict {
  if (subject.risk === 'danger') return mode === 'auto' ? 'hold' : 'ask'
  if (mode === 'auto') return 'allow'
  if (mode === 'important') return subject.routine && subject.risk === 'normal' ? 'allow' : 'ask'
  return 'ask'
}

/** A request the app allowed by itself. */
export interface AutoAllowed {
  id: string
  sessionId: string
  agentId: string
  displayName: string
  /** A ProviderId for hosted sessions. */
  provider: string
  question: string
  toolName: string
  at: number
  /** routine ('important'), auto-approve ('auto'), or the retry of a held request the user approved ('held'). */
  mode?: 'important' | 'auto' | 'held'
}

/** A dangerous request that was refused for now and saved for the user (auto mode). */
export interface HeldRequest {
  id: string
  sessionId: string
  agentId: string
  displayName: string
  provider: ProviderId
  toolName: string
  question: string
  risk: PermissionRisk
  riskNote?: string
  summary: string
  detail: string
  heldAt: number
  /** Set once the user approved it: the agent has been told and its retry will be let through. */
  approvedAt?: number
}

/** What the agent reads when its request is held. Fixed text; nothing an agent wrote is in it. */
export const HELD_MESSAGE =
  'Held by Agent Office for the user to review: this action is high-risk, so it was NOT done. ' +
  'Do not retry it and do not find another way to do the same thing. Continue with the rest of your task, ' +
  'and say in your report that this step is waiting for the user. If the user approves it you will be told, and you can do it then.'

/** What the agent is told when the user approves a held request. `action` is the plain action phrase. */
export const heldApprovedMessage = (action: string): string =>
  `[Agent Office] The user approved the action that was held earlier: ${action}. You may do it now, exactly as you asked before.`

export const MAX_AUTO_KEPT = 50
export const MAX_HELD = 50
/** How long an approved held request lets the agent's retry through. */
export const HELD_APPROVAL_TTL_MS = 30 * 60_000
