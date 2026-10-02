// Terminal modes that the xterm serialize addon leaves out of a snapshot. Without them a terminal
// that attaches late (renderer reload, window shown again) reports the mouse in the wrong encoding
// to a TUI that asked for SGR reports, and shows a cursor the TUI had hidden.
//
// Fed from parser hooks on the pty host's screen mirror; `serialize()` is appended to the snapshot.

/** Params of a CSI sequence as xterm's parser hands them over (sub-params come as arrays). */
export type CsiParams = readonly (number | number[])[]

/** DECSET numbers of the mouse report encodings: UTF-8, SGR, urxvt, SGR pixels. */
const MOUSE_ENCODINGS: readonly number[] = [1005, 1006, 1015, 1016]

export class ExtraModes {
  private cursorHidden = false
  /** The DECSET number of the active mouse encoding, or 0 for the default (X10) one. */
  private mouseEncoding = 0

  /** `CSI ? Pm h` (set) or `CSI ? Pm l` (reset). */
  decPrivate(params: CsiParams, set: boolean): void {
    for (const p of params) {
      const n = Array.isArray(p) ? p[0] : p
      if (n === 25) this.cursorHidden = !set
      // Like xterm: resetting any encoding goes back to the default one.
      else if (MOUSE_ENCODINGS.includes(n)) this.mouseEncoding = set ? n : 0
    }
  }

  /** Full reset (`ESC c`). */
  reset(): void {
    this.cursorHidden = false
    this.mouseEncoding = 0
  }

  /** Sequences that restore these modes in a fresh terminal. */
  serialize(): string {
    return (this.mouseEncoding ? `\x1b[?${this.mouseEncoding}h` : '') + (this.cursorHidden ? '\x1b[?25l' : '')
  }
}
