import type { Health, HealthCount } from './types.js'

/** Worst first. The column exists to point at problems, so one risk among
 *  twenty ok is exactly the information that must not drown — the worst
 *  wins, never the most frequent. */
const bySeverity: readonly Health[] = ['risk', 'attention', 'ok']

/**
 * The health of a bundle, in the order of section 8:
 *
 *   1. the bundle carries one itself   -> that one
 *   2. otherwise the worst beneath it  -> provided its count is > 0
 *   3. otherwise null                  -> and the column stays empty
 *
 * The pairs arrive already mapped onto core values (R3b); the source
 * translates GitLab's own words at the edge.
 *
 * There is deliberately no fallback to lastActivity when this returns null:
 * the two answer different questions, and "moved three days ago" is no
 * statement about whether something is stuck (spec section 2).
 */
export function healthOf(own: Health | null, rolled: readonly HealthCount[]): Health | null {
  if (own !== null) return own
  return bySeverity.find((h) => rolled.some((r) => r.health === h && r.count > 0)) ?? null
}
