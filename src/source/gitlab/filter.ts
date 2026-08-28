import type { Bundle } from '../../core/types.js'

/** The two filters from `[gitlab]`, applied AFTER translation so they work
 *  on the domain words rather than on GitLab's. */
export type Filters = {
  /** Titles that never belong on a roadmap — bots file the same ticket in
   *  every repository. */
  excludeTitles: readonly string[]
  /** Whether closed bundles get a row of their own. */
  includeClosed: boolean
}

/**
 * Filter the bundles a source returns.
 *
 * Both filters decide VISIBILITY, never the derivation. That distinction is
 * the whole point of EC3 and of section 4b:
 *
 *  - progress always counts closed ITEMS, whatever `include_closed` says. A
 *    denominator counting only the remaining work would make progress FALL
 *    while people are working.
 *  - child bundles are NOT filtered here. An epic with two finished
 *    sub-epics must still reach table row 3 and read `closed`; filtering
 *    them away would drop it to `default` — "nothing known" for something
 *    that is done.
 */
export function filterBundles(bundles: readonly Bundle[], filters: Filters): Bundle[] {
  const excluded = new Set(filters.excludeTitles)

  return bundles.filter((bundle) => {
    // Compared on EQUALITY, not as a substring: otherwise "Dependency
    // Dashboard" would also remove a ticket called "Rework Dependency
    // Dashboard UX" that somebody keeps on purpose. Whoever wants a variant
    // gone adds it as a line of its own. Case-sensitive for the same reason
    // — a filter that guesses is worse than one that is written out.
    if (excluded.has(bundle.name)) return false
    if (!filters.includeClosed && bundle.closed) return false
    return true
  })
}
