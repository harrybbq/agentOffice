// One renderer per ChatItem kind (shared/chat.ts). Each is memoised on the item's identity: the
// chat store replaces only the items that changed, so a streaming message re-renders alone.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatItem, ChatItemStatus } from '../../../../shared/chat'
import { countLines, parseAnsi } from '../../chat/ansi'
import type { AnsiSpan } from '../../chat/ansi'
import { clipDiff, parseDiff } from '../../chat/diff'
import { safeHref } from '../../chat/markdown'
import { useApp, useAppState } from '../../controller'
import { duration, shortenPath, stripToolPrefix } from '../../format'
import { cx } from '../../hooks'
import {
  IconAlert,
  IconBan,
  IconCheck,
  IconChecklist,
  IconChevron,
  IconClose,
  IconFile,
  IconFolder,
  IconGlobe,
  IconInfo,
  IconInterrupt,
  IconMegaphone,
  IconPencil,
  IconSearch,
  IconShield,
  IconSpark,
  IconTerminal,
  IconUsers,
  IconWrench
} from '../../icons'
import { CopyButton, ExternalLink, Markdown } from './Markdown'

type Of<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>

const STATUS_LABEL: Record<ChatItemStatus, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  interrupted: 'Interrupted'
}

function StatusMark({ status }: { status: ChatItemStatus }) {
  return (
    <span className={cx('st-mark', `st-${status}`)} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
      {status === 'running' ? (
        <span className="spinner" />
      ) : status === 'done' ? (
        <IconCheck size={13} />
      ) : status === 'failed' ? (
        <IconClose size={13} />
      ) : status === 'declined' ? (
        <IconBan size={13} />
      ) : (
        <IconInterrupt size={13} />
      )}
    </span>
  )
}

/** The shell every tool-like item shares: a one-line head (click to fold) and a body. */
function Card({
  status,
  icon,
  title,
  meta,
  open,
  onToggle,
  tone,
  children
}: {
  status?: ChatItemStatus
  icon: ReactNode
  title: ReactNode
  meta?: ReactNode
  open: boolean
  onToggle?: () => void
  tone?: string
  children?: ReactNode
}) {
  const head = (
    <>
      <span className="cc-icon">{icon}</span>
      <span className="cc-title">{title}</span>
      {meta && <span className="cc-meta">{meta}</span>}
      {status && <StatusMark status={status} />}
      {onToggle && (
        <span className={cx('cc-chevron', open && 'is-open')}>
          <IconChevron size={12} />
        </span>
      )}
    </>
  )
  return (
    <div className={cx('chat-card', status && `is-${status}`, tone, open && children ? 'is-open' : null)}>
      {onToggle ? (
        <button type="button" className="cc-head" onClick={onToggle} aria-expanded={open}>
          {head}
        </button>
      ) : (
        <div className="cc-head">{head}</div>
      )}
      {open && children}
    </div>
  )
}

// ---- user / assistant / reasoning ---------------------------------------------------------------

const ORIGIN: Record<Of<'user'>['origin'], { label: string; title: string } | null> = {
  human: null,
  order: { label: 'CEO order', title: 'Sent from the order bar' },
  steer: { label: 'Added mid-turn', title: 'Sent while the turn was running: the agent reads it after its current step' },
  system: { label: 'System', title: 'Sent by the app or the agent runtime, not typed by you' }
}

export const UserItem = memo(function UserItem({ item }: { item: Of<'user'> }) {
  const origin = ORIGIN[item.origin]
  return (
    <div className={cx('msg-user', `origin-${item.origin}`)}>
      {origin && (
        <span className="msg-origin" title={origin.title}>
          {item.origin === 'order' && <IconMegaphone size={12} />}
          {origin.label}
        </span>
      )}
      <div className="msg-bubble">{item.text}</div>
    </div>
  )
})

export const AssistantItem = memo(function AssistantItem({ item }: { item: Of<'assistant'> }) {
  return (
    <div className={cx('msg-assistant', item.phase === 'commentary' && 'is-commentary')}>
      <Markdown text={item.text} streaming={item.streaming} />
      {!item.streaming && item.phase !== 'commentary' && item.text.length > 0 && <CopyButton text={item.text} label="Copy message" className="msg-copy" />}
    </div>
  )
})

export const ReasoningItem = memo(function ReasoningItem({ item }: { item: Of<'reasoning'> }) {
  const [open, setOpen] = useState(false)
  const parts = item.summary.filter((p) => p.trim())
  const has = parts.length > 0 || !!item.text?.trim()
  // The collapsed line shows what the summary is about (its first bold title or line).
  const peek = parts.length > 0 ? parts[parts.length - 1].replace(/^\*\*(.+?)\*\*[\s\S]*$/, '$1').split('\n')[0] : ''
  return (
    <div className={cx('msg-reasoning', item.streaming && 'is-streaming', open && 'is-open')}>
      <button type="button" className="reason-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!has}>
        <IconSpark size={13} />
        <span className="reason-label">{item.streaming ? 'Thinking…' : 'Thought'}</span>
        {!open && peek && <span className="reason-peek">{peek}</span>}
        {has && (
          <span className={cx('cc-chevron', open && 'is-open')}>
            <IconChevron size={12} />
          </span>
        )}
      </button>
      {open && has && (
        <div className="reason-body">
          {parts.map((p, i) => (
            <Markdown key={i} text={p} streaming={item.streaming && i === parts.length - 1 && !item.text} />
          ))}
          {item.text?.trim() && <pre className="reason-raw">{item.text}</pre>}
        </div>
      )}
    </div>
  )
})

// ---- command ------------------------------------------------------------------------------------

const INTENT = {
  read: { icon: <IconFile size={14} />, label: 'Read' },
  search: { icon: <IconSearch size={14} />, label: 'Search' },
  list: { icon: <IconFolder size={14} />, label: 'List' },
  exec: { icon: <IconTerminal size={14} />, label: 'Run' }
} as const

/** Output longer than this folds away once the command is done. */
const OUTPUT_FOLD_LINES = 12

function AnsiText({ spans }: { spans: readonly AnsiSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.fg === undefined && !s.bold && !s.dim && !s.italic && !s.underline) return s.text
        return (
          <span
            key={i}
            className={cx(typeof s.fg === 'number' && `ansi-${s.fg}`, s.bold && 'ansi-bold', s.dim && 'ansi-dim', s.italic && 'ansi-italic', s.underline && 'ansi-underline')}
            style={typeof s.fg === 'string' ? { color: s.fg } : undefined}
          >
            {s.text}
          </span>
        )
      })}
    </>
  )
}

function Output({ text, running, truncated }: { text: string; running: boolean; truncated: boolean }) {
  const spans = useMemo(() => parseAnsi(text), [text])
  const el = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  // Follow the tail while the command runs, unless the user scrolled up inside the output.
  useLayoutEffect(() => {
    const pre = el.current
    if (pre && follow.current) pre.scrollTop = pre.scrollHeight
  }, [spans])
  return (
    <div className="cmd-output-wrap">
      {truncated && <div className="cmd-truncated">Earlier output was cut: only the end is kept.</div>}
      <pre
        ref={el}
        className={cx('cmd-output', running && 'is-running')}
        tabIndex={0}
        onScroll={(ev) => {
          const pre = ev.currentTarget
          follow.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24
        }}
      >
        <AnsiText spans={spans} />
      </pre>
    </div>
  )
}

export const CommandItem = memo(function CommandItem({ item }: { item: Of<'command'> }) {
  const running = item.status === 'running'
  const lines = useMemo(() => countLines(item.output), [item.output])
  // null = automatic: open while running, folded when it ends with a lot of output.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const auto = running || (lines > 0 && lines <= OUTPUT_FOLD_LINES) || item.status === 'failed'
  const open = userOpen ?? auto
  const intent = INTENT[item.intent] ?? INTENT.exec
  const failed = item.exitCode !== null && item.exitCode !== 0
  const meta = (
    <>
      {!running && item.exitCode !== null && failed && <span className="cmd-exit is-bad">exit {item.exitCode}</span>}
      {!running && item.durationMs !== undefined && <span>{duration(item.durationMs)}</span>}
      {!open && lines > 0 && <span>{lines === 1 ? '1 line' : `${lines} lines`}</span>}
    </>
  )
  return (
    <Card
      status={item.status}
      icon={<span title={intent.label}>{intent.icon}</span>}
      title={<code className={cx('cmd-line', open && 'is-wrapped')}>{item.command}</code>}
      meta={meta}
      open={open}
      onToggle={() => setUserOpen(!open)}
    >
      <div className="cc-body">
        <div className="cmd-info">
          {item.cwd && (
            <span className="cmd-cwd" title={item.cwd}>
              in {shortenPath(item.cwd, 3)}
            </span>
          )}
          <span className="cmd-info-status">
            {running ? 'Running…' : STATUS_LABEL[item.status]}
            {!running && item.exitCode !== null && ` · exit code ${item.exitCode}`}
            {!running && item.durationMs !== undefined && ` · ${duration(item.durationMs)}`}
          </span>
          <CopyButton text={item.command} label="Copy command" />
        </div>
        {item.output ? (
          <Output text={item.output} running={running} truncated={item.outputTruncated} />
        ) : (
          <div className="cmd-empty">{running ? 'No output yet' : 'No output'}</div>
        )}
      </div>
    </Card>
  )
})

// ---- file change --------------------------------------------------------------------------------

const DIFF_FOLD_LINES = 40
const CHANGE_LABEL = { add: 'Added', delete: 'Deleted', update: 'Edited' } as const

function fileName(path: string): { dir: string; name: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

function DiffView({ diff, change }: { diff: string; change: 'add' | 'delete' | 'update' }) {
  const parsed = useMemo(() => parseDiff(diff, change), [diff, change])
  const [all, setAll] = useState(false)
  // A new or a deleted file: every line is on the same side, so one number column is enough, and
  // its single "@@ -0,0 +1,N @@" header says nothing.
  const single = change !== 'update' && !parsed.lines.some((l) => l.kind === 'ctx') && parsed.lines.filter((l) => l.kind === 'hunk').length <= 1
  const rows = useMemo(() => (single ? parsed.lines.filter((l) => l.kind !== 'hunk') : parsed.lines), [parsed, single])
  const view = all ? { lines: rows, hidden: 0 } : clipDiff(rows, DIFF_FOLD_LINES)
  const numbered = rows.some((l) => l.oldNo !== undefined || l.newNo !== undefined)
  if (rows.length === 0) return <div className="diff-none">No diff available</div>
  return (
    <div className="diff">
      <div className="diff-scroll">
        <div className={cx('diff-lines', !numbered && 'no-numbers', single && 'one-number')}>
          {view.lines.map((l, i) =>
            l.kind === 'hunk' ? (
              <div key={i} className="diff-line is-hunk">
                <span className="diff-text">{l.text}</span>
              </div>
            ) : (
              <div key={i} className={cx('diff-line', `is-${l.kind}`)}>
                {numbered && !single && <span className="diff-no">{l.oldNo ?? ''}</span>}
                {numbered && <span className="diff-no">{(single ? (l.newNo ?? l.oldNo) : l.newNo) ?? ''}</span>}
                <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                <span className="diff-text">{l.text || ' '}</span>
              </div>
            )
          )}
        </div>
      </div>
      {(view.hidden > 0 || (all && rows.length > DIFF_FOLD_LINES + 8)) && (
        <button type="button" className="diff-more" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${rows.length} lines (${view.hidden} more)`}
        </button>
      )}
    </div>
  )
}

function ChangeBlock({ change }: { change: Of<'file-change'>['changes'][number] }) {
  const stats = useMemo(() => parseDiff(change.diff, change.change), [change.diff, change.change])
  const [open, setOpen] = useState(true)
  const { dir, name } = fileName(change.path)
  return (
    <div className="change">
      <button type="button" className="change-head" onClick={() => setOpen(!open)} aria-expanded={open} title={change.path}>
        <span className={cx('change-badge', `is-${change.change}`)}>{CHANGE_LABEL[change.change]}</span>
        <span className="change-path">
          <span className="change-dir">{dir}</span>
          <span className="change-name">{name}</span>
          {change.movedTo && <span className="change-moved">→ {change.movedTo}</span>}
        </span>
        <span className="change-stats">
          {stats.added > 0 && <span className="stat-add">+{stats.added}</span>}
          {stats.removed > 0 && <span className="stat-del">−{stats.removed}</span>}
        </span>
        <span className={cx('cc-chevron', open && 'is-open')}>
          <IconChevron size={12} />
        </span>
      </button>
      {open && <DiffView diff={change.diff} change={change.change} />}
    </div>
  )
}

export const FileChangeItem = memo(function FileChangeItem({ item }: { item: Of<'file-change'> }) {
  const [open, setOpen] = useState(true)
  const n = item.changes.length
  const verb = item.status === 'running' ? 'Editing' : item.status === 'declined' ? 'Declined change to' : item.status === 'failed' ? 'Failed to change' : 'Changed'
  const title = n === 1 ? `${verb} ${fileName(item.changes[0].path).name}` : `${verb} ${n} files`
  return (
    <Card status={item.status} icon={<IconPencil size={14} />} title={<span className="cc-text">{title}</span>} open={open && n > 0} onToggle={n > 0 ? () => setOpen(!open) : undefined}>
      <div className="cc-body cc-body-flush">
        {item.changes.map((c, i) => (
          <ChangeBlock key={`${c.path}:${i}`} change={c} />
        ))}
      </div>
    </Card>
  )
})

// ---- web / tool / plan / subagent ---------------------------------------------------------------

const WEB_VERB = { search: ['Searching the web', 'Searched the web'], open: ['Opening', 'Opened'], find: ['Looking in the page', 'Looked in the page'] } as const

export const WebItem = memo(function WebItem({ item }: { item: Of<'web'> }) {
  const running = item.status === 'running'
  const href = item.url ? safeHref(item.url) : null
  const verb = (WEB_VERB[item.action] ?? WEB_VERB.search)[running ? 0 : 1]
  return (
    <Card
      status={item.status}
      icon={<IconGlobe size={14} />}
      open={false}
      title={
        <span className="cc-text">
          {verb}
          {item.query && <span className="web-query">{item.query}</span>}
          {item.url &&
            (href ? (
              <ExternalLink href={href} className="web-url">
                {item.url.replace(/^https?:\/\//, '')}
              </ExternalLink>
            ) : (
              <span className="web-url">{item.url}</span>
            ))}
          {running && !item.query && !item.url && '…'}
        </span>
      }
    />
  )
})

export const ToolItem = memo(function ToolItem({ item }: { item: Of<'tool'> }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const has = !!(item.input || item.result || item.error)
  const show = userOpen ?? (item.status === 'failed' && !!item.error)
  return (
    <Card
      status={item.status}
      icon={<IconWrench size={14} />}
      title={
        <span className="cc-text">
          {item.server && <span className="tool-server">{item.server}</span>}
          <code className="tool-name">{item.tool}</code>
          {item.status === 'running' && item.progress && <span className="tool-progress">{item.progress}</span>}
        </span>
      }
      open={show}
      onToggle={has ? () => setUserOpen(!show) : undefined}
    >
      <div className="cc-body">
        {item.input && (
          <>
            <div className="tool-label">Input</div>
            <pre className="tool-pre">{item.input}</pre>
          </>
        )}
        {item.error ? (
          <>
            <div className="tool-label is-error">Error</div>
            <pre className="tool-pre is-error">{item.error}</pre>
          </>
        ) : (
          item.result && (
            <>
              <div className="tool-label">Result</div>
              <pre className="tool-pre">{item.result}</pre>
            </>
          )
        )}
      </div>
    </Card>
  )
})

export const PlanItem = memo(function PlanItem({ item }: { item: Of<'plan'> }) {
  const done = item.steps.filter((s) => s.status === 'completed').length
  return (
    <div className="chat-card plan">
      <div className="cc-head">
        <span className="cc-icon">
          <IconChecklist size={14} />
        </span>
        <span className="cc-title">
          <span className="cc-text">Plan</span>
        </span>
        <span className="cc-meta">
          {done} of {item.steps.length} done
        </span>
      </div>
      {item.explanation && <p className="plan-why">{item.explanation}</p>}
      <ol className="plan-steps">
        {item.steps.map((s, i) => (
          <li key={i} className={cx('plan-step', `is-${s.status}`)}>
            <span className="plan-box" role="img" aria-label={s.status === 'completed' ? 'Done' : s.status === 'in-progress' ? 'In progress' : 'Pending'}>
              {s.status === 'completed' ? <IconCheck size={11} /> : s.status === 'in-progress' ? <span className="plan-dot" /> : null}
            </span>
            <span className="plan-text">{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
})

const SUB_VERB: Record<Of<'subagent'>['action'], string> = { spawn: 'Started', message: 'Messaged', wait: 'Waiting for', close: 'Closed' }

export const SubagentItem = memo(function SubagentItem({ item }: { item: Of<'subagent'> }) {
  const app = useApp()
  return (
    <button
      type="button"
      className={cx('sub-row', `is-${item.status}`)}
      onClick={() => app.world.focusTeam(item.sessionId)}
      title={`${item.prompt ? `${item.prompt}\n\n` : ''}Show this team in the office`}
    >
      <IconUsers size={14} />
      <span className="sub-verb">{SUB_VERB[item.action] ?? item.action}</span>
      <span className="sub-name">{item.name || 'worker'}</span>
      {item.prompt && <span className="sub-prompt">{item.prompt}</span>}
      <StatusMark status={item.status} />
    </button>
  )
})

// ---- approval -----------------------------------------------------------------------------------

const OUTCOME = {
  allowed: { label: 'Allowed', icon: <IconCheck size={13} /> },
  denied: { label: 'Denied', icon: <IconBan size={13} /> },
  'resolved-elsewhere': { label: 'Answered elsewhere', icon: <IconInfo size={13} /> }
} as const

export const ApprovalItem = memo(function ApprovalItem({ item }: { item: Of<'approval'> }) {
  const app = useApp()
  const busy = useAppState((s) => s.deciding.has(item.requestId))
  const req = useAppState((s) => s.permissions.find((p) => p.id === item.requestId))
  const provider = useAppState((s) => s.sessions.find((x) => x.id === item.sessionId)?.provider ?? 'codex')
  const title = useAppState((s) => s.sessions.find((x) => x.id === item.sessionId)?.title ?? '')
  const [details, setDetails] = useState(false)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const pending = item.outcome === 'pending'
  const outcome = item.outcome === 'pending' ? null : OUTCOME[item.outcome]
  const toolName = req?.toolName ?? (item.summary.includes(':') ? item.summary.slice(0, item.summary.indexOf(':')) : 'Permission')

  useEffect(() => {
    if (!pending) setDenying(false)
  }, [pending])

  const decide = (allow: boolean) => {
    const message = reason.trim()
    setDenying(false)
    void app.decideById(item.requestId, allow ? { behavior: 'allow' } : message ? { behavior: 'deny', message } : { behavior: 'deny' }, {
      sessionId: item.sessionId,
      agentId: item.agentId,
      displayName: req?.displayName ?? title,
      provider,
      toolName,
      summary: item.summary,
      detail: item.detail,
      createdAt: item.ts
    })
  }

  return (
    <div className={cx('approval', `is-${item.outcome}`)} role={pending ? 'group' : undefined} aria-label={pending ? 'Permission request' : undefined}>
      <div className="approval-head">
        <span className="approval-icon">
          <IconShield size={14} />
        </span>
        <span className="approval-title">{pending ? 'Needs your approval' : 'Permission request'}</span>
        {outcome && (
          <span className={cx('approval-outcome', `is-${item.outcome}`)}>
            {outcome.icon}
            {outcome.label}
          </span>
        )}
      </div>
      <div className="card-summary">
        <span className="tool-chip">{toolName}</span>
        <span className="card-summary-text">{stripToolPrefix(item.summary, toolName)}</span>
      </div>
      {item.detail && (
        <button type="button" className={cx('card-toggle', details && 'is-open')} onClick={() => setDetails(!details)} aria-expanded={details}>
          <IconChevron size={12} />
          {details ? 'Hide details' : 'Details'}
        </button>
      )}
      {details && <pre className="card-detail">{item.detail}</pre>}
      {pending &&
        (denying ? (
          <form
            className="card-deny"
            onSubmit={(ev) => {
              ev.preventDefault()
              decide(false)
            }}
          >
            <input
              className="input"
              autoFocus
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Escape') {
                  ev.stopPropagation()
                  setDenying(false)
                }
              }}
              placeholder="Reason (optional), Enter to deny"
              aria-label="Reason for denying"
              maxLength={500}
            />
            <button type="submit" className="btn btn-danger">
              Deny
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setDenying(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="card-actions approval-actions">
            <button type="button" className="btn btn-allow" disabled={busy} onClick={() => decide(true)}>
              <IconCheck />
              Allow
            </button>
            <button
              type="button"
              className="btn btn-deny"
              disabled={busy}
              onClick={() => {
                setReason('')
                setDenying(true)
              }}
            >
              <IconBan />
              Deny
            </button>
          </div>
        ))}
    </div>
  )
})

// ---- notice -------------------------------------------------------------------------------------

export const NoticeItem = memo(function NoticeItem({ item }: { item: Of<'notice'> }) {
  return (
    <div className={cx('notice', `is-${item.level}`)} role={item.level === 'error' ? 'alert' : 'status'}>
      {item.level === 'info' ? <IconInfo size={14} /> : <IconAlert size={14} />}
      <span>{item.text}</span>
    </div>
  )
})

export function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <UserItem item={item} />
    case 'assistant':
      return <AssistantItem item={item} />
    case 'reasoning':
      return <ReasoningItem item={item} />
    case 'command':
      return <CommandItem item={item} />
    case 'file-change':
      return <FileChangeItem item={item} />
    case 'web':
      return <WebItem item={item} />
    case 'tool':
      return <ToolItem item={item} />
    case 'plan':
      return <PlanItem item={item} />
    case 'subagent':
      return <SubagentItem item={item} />
    case 'approval':
      return <ApprovalItem item={item} />
    case 'notice':
      return <NoticeItem item={item} />
    default:
      // A kind this build doesn't know (a newer main process): show nothing rather than crash.
      return null
  }
}
