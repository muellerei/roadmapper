import { stateOf, verdictOfItem } from './state.js'
import type { Bundle, CoreConfig, Item, Row, SourceResult } from './types.js'

/**
 * The step between the source and the output stage, and the ONLY place
 * `stateOf` is called.
 *
 * That is what keeps the WRITE PATH from deriving: `write.ts` and `body.ts`
 * receive `Row[]` and no `CoreConfig`, so they cannot reach the state table
 * a second time — with a different configuration, in a second place. The
 * type makes it impossible rather than discouraged (section 4b).
 *
 * The select pre-check does see a `CoreConfig`, and that is not a hole in
 * the rule: it compares configured values against the target's options and
 * derives nothing.
 *
 * Rendering is not done here either. A row carries `Date` and a `Progress`
 * pair; turning those into strings or percentages is the output stage's
 * decision (ADR-0008).
 */
export function rowsOf(result: SourceResult, cfg: CoreConfig, options: RowOptions = {}): Row[] {
  const includeClosed = options.includeClosed ?? false
  return result.bundles.flatMap((b) => rowsOfBundle(b, cfg, includeClosed))
}

/** What the OUTPUT needs to know beyond the derivation.
 *
 *  `includeClosed` is a `[gitlab]` reading instruction and therefore not part
 *  of `CoreConfig` — it says nothing about how a state is derived. It reaches
 *  here as a parameter because visibility is decided at this step: the source
 *  can only apply it to the bundles it returns, while child bundles must stay
 *  in `children` regardless, or the derivation breaks (section 4b). */
export type RowOptions = {
  /** Whether a CLOSED bundle gets a row of its own — one rule for every
   *  level, so a closed sub-epic is treated exactly like a closed top-level
   *  one. Defaults to false, matching the configuration default. */
  includeClosed?: boolean
}

/**
 * One bundle's rows: the bundle itself, then its own items, then the rows of
 * its open children.
 *
 * The order is part of the contract — a bundle immediately followed by its
 * items — because the writer relies on it.
 *
 * Closed children are skipped HERE and only here, and by the SAME rule the
 * source applies to the bundles it returns: `include_closed` decides which
 * bundles get a row of their own, at every level, never what goes into the
 * derivation (section 4b). `stateOf` above has already counted them, so an
 * epic whose sub-epics are all finished still reads `closed` via table row 3
 * instead of falling to `default` — visibility is a question of the output,
 * not of the derivation.
 */
function rowsOfBundle(bundle: Bundle, cfg: CoreConfig, includeClosed: boolean): Row[] {
  const items = bundle.items.map((i) => rowOfItem(i, cfg))

  const row: Row = {
    level: 'bundle',
    key: bundle.key,
    number: bundle.number,
    name: bundle.name,
    state: stateOf(bundle, cfg),
    closed: bundle.closed,
    progress: bundle.progress,
    url: bundle.url,
    due: bundle.due,
    activity: bundle.lastActivity,
    health: bundle.health,
    description: bundle.description,
    items,
  }

  const children = bundle.children
    .filter((child) => includeClosed || !child.closed)
    .flatMap((child) => rowsOfBundle(child, cfg, includeClosed))
  return [row, ...items, ...children]
}

/** One item's row. Its state comes from the same verdict the bundle's own
 *  derivation used — closed beats everything, the chosen stage source wins,
 *  and the other is never read as a fallback. */
function rowOfItem(item: Item, cfg: CoreConfig): Row {
  const verdict = verdictOfItem(item, cfg)
  return {
    level: 'item',
    key: item.key,
    number: item.number,
    name: item.title,
    state: verdict.value,
    // Finished, by the same rule the state table uses: a `done` or
    // `cancelled` category counts even while GitLab still calls the item
    // open (section 9), which is what keeps a cancelled ticket from blocking
    // "all children done" forever. Carried as a fact rather than read back
    // off `state`, because under the status stage source the state is the
    // display name ("Verification") and no comparison could recognise it.
    closed: verdict.done,
    // Progress is a statement about a SET, and an item is not one.
    progress: null,
    url: item.url,
    due: null,
    activity: item.updatedAt,
    health: item.health,
    description: item.description,
    items: [],
  }
}
