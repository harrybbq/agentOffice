// Dev only. @vitejs/plugin-react normally installs its Fast Refresh preamble with an inline
// <script>, which the page's CSP (script-src 'self', no inline) blocks. Installing it from a module
// keeps the CSP strict. Must be the first import of the entry so it runs before any component module.
if (import.meta.env.DEV) {
  const runtimePath = '/@react-refresh'
  const runtime = (await import(/* @vite-ignore */ runtimePath)) as { injectIntoGlobalHook(w: Window): void }
  runtime.injectIntoGlobalHook(window)
  const w = window as unknown as Record<string, unknown>
  w.$RefreshReg$ = () => undefined
  w.$RefreshSig$ = () => (type: unknown) => type
}

export {}
