// A tiny external store for React (useSyncExternalStore). State is replaced immutably, so
// selectors that return an existing slice are stable between unrelated updates.
import { useSyncExternalStore } from 'react'

export class Store<T extends object> {
  private listeners = new Set<() => void>()

  constructor(private state: T) {}

  get = (): T => this.state

  set(patch: Partial<T> | ((s: T) => Partial<T>)): void {
    const p = typeof patch === 'function' ? patch(this.state) : patch
    let changed = false
    for (const k in p) {
      if (!Object.is(p[k], this.state[k])) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.state = { ...this.state, ...p }
    for (const l of [...this.listeners]) l()
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

/** Selects one slice. The selector must return a stored value (no fresh objects). */
export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}
