// Renderer entry: pick the bridge (real, or the dev stub in a plain browser), boot the app
// controller, render the React shell. The Phaser world is mounted by <WorldView>.
import './dev/reactPreamble'
import { createRoot } from 'react-dom/client'
import type { AgentOfficeBridge } from '../shared/ipc'
import { App } from './ui/App'
import { AppContext, AppController } from './ui/controller'
import type { AppState } from './ui/controller'
import './ui/styles/tokens.css'
import './ui/styles/app.css'
import './ui/styles/chat.css'
import './ui/styles/board.css'

const UNSUPPORTED = "This build's main process can't host sessions yet"

/** An older preload without sessions / terminal / permissions: the app still watches the office. */
function watchOnly(real: Partial<AgentOfficeBridge>): AgentOfficeBridge {
  const none = () => () => undefined
  return {
    ...(real as AgentOfficeBridge),
    sessions: {
      providers: async () => [],
      onProvidersChanged: none,
      login: async () => Promise.reject(new Error(UNSUPPORTED)),
      list: async () => [],
      start: async () => Promise.reject(new Error(UNSUPPORTED)),
      stop: async () => undefined,
      interrupt: async () => undefined,
      pickFolder: async () => null,
      history: async () => [],
      onChanged: none
    },
    terminal: {
      attach: async () => Promise.reject(new Error(UNSUPPORTED)),
      detach: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      ack: () => undefined,
      onData: none
    },
    chat: CHAT_UNSUPPORTED,
    permissions: { list: async () => [], decide: async () => 'unknown-request', onChanged: none }
  }
}

const CHAT_UNSUPPORTED: AgentOfficeBridge['chat'] = {
  attach: async () => Promise.reject(new Error("This build's main process has no chat sessions yet")),
  detach: () => undefined,
  send: async () => Promise.reject(new Error("This build's main process has no chat sessions yet")),
  onEvent: () => () => undefined
}

/**
 * A preload from before chat sessions and provider logins: fill in what is missing, so the shell
 * (which subscribes to both at boot) runs against it unchanged.
 */
function withPhaseB(real: AgentOfficeBridge): AgentOfficeBridge {
  const sessions = real.sessions as Partial<AgentOfficeBridge['sessions']>
  if (real.chat && sessions.onProvidersChanged && sessions.login) return real
  return {
    ...real,
    chat: real.chat ?? CHAT_UNSUPPORTED,
    sessions: {
      ...real.sessions,
      onProvidersChanged: sessions.onProvidersChanged ?? (() => () => undefined),
      login: sessions.login ?? (async () => Promise.reject(new Error(UNSUPPORTED)))
    }
  }
}

async function pickBridge(): Promise<{ bridge: AgentOfficeBridge; connection: AppState['connection'] }> {
  const real = (window as { agentOffice?: Partial<AgentOfficeBridge> }).agentOffice
  if (!real) {
    // Plain browser (Vite dev URL or a static build): everything is fake. Code-split on purpose.
    const { createStubBridge } = await import('./dev/stubBridge')
    return { bridge: createStubBridge(), connection: 'stub' }
  }
  if (real.sessions && real.terminal && real.permissions) return { bridge: withPhaseB(real as AgentOfficeBridge), connection: 'connected' }
  return { bridge: watchOnly(real), connection: 'limited' }
}

async function boot(): Promise<void> {
  const { bridge, connection } = await pickBridge()
  const app = new AppController(bridge, connection)

  if (import.meta.env.DEV || connection === 'stub') {
    // Devtools handles: __agentOfficeDev.officeWide(true) lets workers roam without a real order.
    ;(window as unknown as Record<string, unknown>).__agentOfficeDev = {
      officeWide: (on: boolean, timeoutMs?: number) => app.world.devOfficeWide(on, timeoutMs),
      scene: () => app.world.devScene(),
      app
    }
  }

  createRoot(document.getElementById('root')!).render(
    <AppContext.Provider value={app}>
      <App />
    </AppContext.Provider>
  )
  await app.boot()
}

void boot()
