// Pure action-queue rules, shared by Character and tests.

export const MAX_QUEUE = 6
export const MIN_DWELL_MS = 1200

export interface QueueItem {
  /** spawn / done / waiting / handoff / leave: never dropped. */
  lifecycle: boolean
  /** Activity name for collapsing runs; undefined never collapses. */
  activity?: string
}

/**
 * Keeps a queue bounded when events arrive faster than characters can walk:
 * 1. collapse consecutive same-activity non-lifecycle items (keep the newest of each run),
 * 2. drop the oldest non-lifecycle items until at most `max` remain.
 * Lifecycle items always survive, so the result may exceed `max` if they alone do.
 */
export function compactQueue<T extends QueueItem>(queue: T[], max = MAX_QUEUE): T[] {
  if (queue.length <= max) return queue
  const collapsed: T[] = []
  for (const item of queue) {
    const prev = collapsed[collapsed.length - 1]
    if (
      prev &&
      !prev.lifecycle &&
      !item.lifecycle &&
      prev.activity !== undefined &&
      prev.activity === item.activity
    ) {
      collapsed[collapsed.length - 1] = item
    } else {
      collapsed.push(item)
    }
  }
  let excess = collapsed.length - max
  if (excess <= 0) return collapsed
  const out: T[] = []
  for (const item of collapsed) {
    if (excess > 0 && !item.lifecycle) {
      excess--
      continue
    }
    out.push(item)
  }
  return out
}
