// Renders the Markdown AST (ui/chat/markdown.ts) as React elements. Model text only ever ends up
// in text nodes and in `href` values that passed safeHref: nothing here sets inner HTML.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { parseMarkdown } from '../../chat/markdown'
import type { Block, Inline } from '../../chat/markdown'
import { cx } from '../../hooks'
import { IconCheck, IconCopy } from '../../icons'

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={cx('copy-btn', copied && 'is-copied', className)}
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      onClick={(ev) => {
        ev.stopPropagation()
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopied(false), 1400)
          })
          .catch((err: unknown) => console.warn('[agent-office] copy failed', err))
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  )
}

/**
 * A link to an http(s) URL (the caller passes one that went through safeHref). A click asks for a
 * new window: the main process decides what that does (open the system browser, or refuse). When
 * it is refused, the URL is copied instead so the link is never a dead end.
 */
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <a
      className={cx('md-link', copied && 'is-copied', className)}
      href={href}
      title={copied ? 'Opened in your browser · link copied' : href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        let opened: Window | null = null
        try {
          opened = window.open(href, '_blank')
          if (opened) opened.opener = null
        } catch {
          opened = null
        }
        if (opened) return
        void navigator.clipboard
          ?.writeText(href)
          .then(() => {
            setCopied(true)
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopied(false), 1600)
          })
          .catch(() => undefined)
      }}
    >
      {children}
      {copied && <span className="md-link-note">Opened in your browser · link copied</span>}
    </a>
  )
}

function inline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.text
      case 'code':
        return (
          <code key={i} className="md-code">
            {n.text}
          </code>
        )
      case 'strong':
        return <strong key={i}>{inline(n.children)}</strong>
      case 'em':
        return <em key={i}>{inline(n.children)}</em>
      case 'del':
        return <del key={i}>{inline(n.children)}</del>
      case 'br':
        return <br key={i} />
      case 'link':
        return (
          <ExternalLink key={i} href={n.href}>
            {inline(n.children)}
          </ExternalLink>
        )
    }
  })
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span className="md-pre-lang">{lang || 'text'}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={key}>{inline(b.children)}</p>
    case 'heading': {
      // Headings inside a chat message are small: h1/h2 would shout.
      const Tag = `h${Math.min(6, b.level + 2)}` as 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag key={key} className={`md-h md-h${b.level}`}>
          {inline(b.children)}
        </Tag>
      )
    }
    case 'code':
      return <CodeBlock key={key} lang={b.lang} text={b.text} />
    case 'hr':
      return <hr key={key} className="md-hr" />
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {b.blocks.map(renderBlock)}
        </blockquote>
      )
    case 'list': {
      const items = b.items.map((it, i) => {
        // A one-paragraph item renders tight (no <p> margins).
        const [head, ...rest] = it.blocks
        const body = head?.t === 'p' ? [<span key="h">{inline(head.children)}</span>, ...rest.map((x, k) => renderBlock(x, k))] : it.blocks.map((x, k) => renderBlock(x, k))
        return (
          <li key={i} className={cx(it.checked !== null && 'md-task', it.checked && 'is-checked')}>
            {it.checked !== null && (
              <span className="md-check" role="img" aria-label={it.checked ? 'Done' : 'To do'}>
                {it.checked && <IconCheck size={11} />}
              </span>
            )}
            {body}
          </li>
        )
      })
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      )
    }
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, i) => (
                    <td key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** Re-rendered only when its source changed: while a message streams, that is the last block. */
const MdBlock = memo(
  function MdBlock({ block }: { block: Block }) {
    return <>{renderBlock(block, 0)}</>
  },
  (a, b) => a.block.t === b.block.t && a.block.src === b.block.src
)

export const Markdown = memo(function Markdown({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className={cx('md', streaming && 'is-streaming', className)}>
      {blocks.map((b, i) => (
        <MdBlock key={i} block={b} />
      ))}
    </div>
  )
})
