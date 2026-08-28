import type { Progress } from './types.js'

/**
 * Progress is always derived, never carried (ADR-0007). It takes the count
 * pair GitLab rolls up for a whole subtree rather than an item list:
 * counting items would mean fetching every descendant issue and would still
 * undercount, because nested bundles count through (ADR-0015).
 *
 * A bundle with no items has no progress, and the caller must say so rather
 * than reporting 0 % — null, never NaN (EC2).
 */
export function progressOf(all: number, closed: number): Progress | null {
  if (all === 0) return null
  return { done: closed, total: all, ratio: closed / all }
}
