import { useEffect, useRef, useState } from 'react'
import { evaluate, format } from '../../../calculator/evaluate'
import type { AngleMode } from '../../../calculator/evaluate'

export function Calculator({ onClose }: { onClose: () => void }) {
  const [expression, setExpression] = useState('')
  const [justEvaluated, setJustEvaluated] = useState(false)
  const [message, setMessage] = useState('')
  const [angleMode, setAngleMode] = useState<AngleMode>('degrees')
  const firstButton = useRef<HTMLButtonElement>(null)
  const priorFocus = useRef<HTMLElement | null>(null)
  const preview = (() => {
    try { return expression ? format(evaluate(expression, { angle: angleMode })) : '0' }
    catch (error) { return error instanceof Error && error.message !== 'Enter a number' ? error.message : '—' }
  })()

  useEffect(() => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    firstButton.current?.focus()
    return () => priorFocus.current?.focus()
  }, [])

  const press = (key: string) => {
    setMessage('')
    if (key === 'AC') { setExpression(''); setJustEvaluated(false); return }
    if (key === '⌫') { setExpression((value) => value.slice(0, -1)); setJustEvaluated(false); return }
    if (key === '=') {
      try { setExpression(format(evaluate(expression, { angle: angleMode }))); setJustEvaluated(true) }
      catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid calculation') }
      return
    }
    if (key === '%') {
      setExpression((value) => value.replace(/(\d+(?:\.\d*)?|\.\d+)$/, (n) => format(Number(n) / 100)))
      setJustEvaluated(false)
      return
    }
    setExpression((value) => {
      const fresh = justEvaluated && /[\d.(]/.test(key) ? '' : value
      if (/^[+−×÷]$/.test(key)) {
        if (!fresh) return key === '−' ? '−' : fresh
        return /[+−×÷]$/.test(fresh) ? fresh.slice(0, -1) + key : fresh + key
      }
      if (key === '.') {
        const current = fresh.split(/[+−×÷()]/).at(-1) ?? ''
        if (current.includes('.')) return fresh
        return fresh + (current ? '.' : '0.')
      }
      return fresh + key
    })
    setJustEvaluated(false)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); press(event.key) }
      else if (event.key === '.') { event.preventDefault(); press('.') }
      else if (event.key === '+') { event.preventDefault(); press('+') }
      else if (event.key === '-') { event.preventDefault(); press('−') }
      else if (event.key === '*') { event.preventDefault(); press('×') }
      else if (event.key === '/') { event.preventDefault(); press('÷') }
      else if (event.key === '(' || event.key === ')' || event.key === '^' || event.key === '!') { event.preventDefault(); press(event.key) }
      else if (event.key === '%') { event.preventDefault(); press('%') }
      else if (event.key === 'Enter' || event.key === '=') { event.preventDefault(); press('=') }
      else if (event.key === 'Backspace') { event.preventDefault(); press('⌫') }
      else if (event.key === 'Delete') { event.preventDefault(); press('AC') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const keys: { label: string; value: string; kind?: string }[] = [
    { label: 'sin', value: 'sin(', kind: 'science' }, { label: 'cos', value: 'cos(', kind: 'science' }, { label: 'tan', value: 'tan(', kind: 'science' }, { label: '(', value: '(', kind: 'science' }, { label: ')', value: ')', kind: 'science' },
    { label: 'xʸ', value: '^', kind: 'science' }, { label: '√x', value: 'sqrt(', kind: 'science' }, { label: 'x!', value: '!', kind: 'science' }, { label: 'π', value: 'π', kind: 'science' }, { label: 'e', value: 'e', kind: 'science' },
    { label: 'asin', value: 'asin(', kind: 'science' }, { label: 'acos', value: 'acos(', kind: 'science' }, { label: 'atan', value: 'atan(', kind: 'science' }, { label: 'cbrt', value: 'cbrt(', kind: 'science' }, { label: 'exp', value: 'exp(', kind: 'science' },
    { label: 'AC', value: 'AC', kind: 'utility' }, { label: '⌫', value: '⌫', kind: 'utility' }, { label: '%', value: '%', kind: 'utility' }, { label: '÷', value: '÷', kind: 'operator' }, { label: 'ln', value: 'ln(', kind: 'science' },
    { label: '7', value: '7' }, { label: '8', value: '8' }, { label: '9', value: '9' }, { label: '×', value: '×', kind: 'operator' }, { label: 'log', value: 'log(', kind: 'science' },
    { label: '4', value: '4' }, { label: '5', value: '5' }, { label: '6', value: '6' }, { label: '−', value: '−', kind: 'operator' }, { label: 'abs', value: 'abs(', kind: 'science' },
    { label: '1', value: '1' }, { label: '2', value: '2' }, { label: '3', value: '3' }, { label: '+', value: '+', kind: 'operator' }, { label: '±', value: 'sign', kind: 'utility' },
    { label: '0', value: '0' }, { label: '.', value: '.' }, { label: '=', value: '=', kind: 'equals' }, { label: 'sinh', value: 'sinh(', kind: 'science' }, { label: 'cosh', value: 'cosh(', kind: 'science' },
    { label: 'tanh', value: 'tanh(', kind: 'science' }, { label: '', value: '', kind: 'spacer' }, { label: '', value: '', kind: 'spacer' }, { label: '', value: '', kind: 'spacer' }, { label: '', value: '', kind: 'spacer' },
  ]

  return (
    <div className="calculator-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="calculator" role="dialog" aria-modal="true" aria-labelledby="calculator-title">
        <header className="calculator-head">
          <div><h2 id="calculator-title">Scientific calculator</h2><p>Quick arithmetic and functions</p></div>
          <button type="button" className="calculator-angle" onClick={() => setAngleMode((mode) => mode === 'degrees' ? 'radians' : 'degrees')} aria-label={`Angle mode: ${angleMode}. Switch to ${angleMode === 'degrees' ? 'radians' : 'degrees'}`} title="Switch angle mode">
            {angleMode === 'degrees' ? 'DEG' : 'RAD'}
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close calculator" title="Close">×</button>
        </header>
        <div className="calculator-display">
          <div className="calculator-expression" aria-label="Expression">{expression || '0'}</div>
          <output className="calculator-result" aria-live="polite">{preview}</output>
          {message && <div className="calculator-error" role="status">{message}</div>}
        </div>
        <div className="calculator-keys">
          {keys.map((key, index) => (
            <button
              key={`${key.value}-${index}`}
              ref={index === 0 ? firstButton : undefined}
              type="button"
              className={`calculator-key ${key.kind ? `is-${key.kind}` : ''}`}
              aria-label={key.value === '⌫' ? 'Delete last digit' : key.value === 'sign' ? 'Change sign' : key.value === 'AC' ? 'Clear all' : key.label || undefined}
              disabled={key.value === ''}
              onClick={() => key.value === 'sign'
                ? setExpression((value) => value.startsWith('−') ? value.slice(1) : value ? `−(${value})` : '−')
                : press(key.value)}
            >{key.label}</button>
          ))}
        </div>
        <footer className="calculator-foot">Keyboard: numbers, operators, Enter, Backspace, Esc</footer>
      </section>
    </div>
  )
}
