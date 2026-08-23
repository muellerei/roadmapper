/** How much of a bundle is done, counted from its items. */
export type Progress = { done: number; total: number; ratio: number }

/**
 * Progress is always derived, never carried. A bundle with no items has no
 * progress, and the caller must say so rather than reporting 0%.
 */
export function progressOf(items: readonly { closed: boolean }[]): Progress | null {
  if (items.length === 0) return null
  const done = items.filter((i) => i.closed).length
  return { done, total: items.length, ratio: done / items.length }
}
