import type { Bundle } from './types.js'

/**
 * The newest date anywhere in the bundle: its own, its items', and its
 * children's — recursively.
 *
 * Children must be included. An epic whose children are only sub-epics
 * would otherwise carry just its own date and look still while work goes on
 * beneath it (AK11) — the same mistake as with the state (AK7).
 *
 * A date, never a judgement. When standstill becomes a problem is known only
 * to the team, so the tool writes no "still for 6 weeks"; Notion filters on
 * "older than X" itself.
 */
export function lastActivityOf(bundle: Bundle): Date {
  const newest = Math.max(
    bundle.lastActivity.getTime(),
    ...bundle.items.map((i) => i.updatedAt.getTime()),
    ...bundle.children.map((c) => lastActivityOf(c).getTime()),
  )
  return new Date(newest)
}
