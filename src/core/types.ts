/** How much of a bundle is done. Derived, never carried (ADR-0007).
 *  `ratio` is a fraction in 0…1, not a percentage — Notion's percent
 *  column expects the fraction (measured, EC6a). */
export type Progress = { done: number; total: number; ratio: number }

/** How a bundle or item is doing, as a human judged it.
 *  Core's own words, not GitLab's: the source maps its API values
 *  onto these (R3b). */
export type Health = 'ok' | 'attention' | 'risk'

/** One (health, count) pair, counted over the descendants. */
export type HealthCount = { health: Health; count: number }

/** Which kind of work step this is, independent of what a team calls it.
 *  Core's own words again: GitLab's status field carries an equivalent
 *  set, and the source maps onto these (R3b). */
export type StatusCategory =
  | 'triage' | 'todo' | 'active' | 'done' | 'cancelled'

/** Which work step an item is in. The source fills whatever it finds;
 *  which field is read is decided by `stageSource` in core
 *  (section 9). Both fields may be filled — neither wins by itself. */
export type Stage = {
  /** From GitLab's own status field, when the instance provides it.
   *  Needs no configuration: the category carries the meaning. */
  category: StatusCategory | null
  /** The status's display name, e.g. "In review". Written to the target
   *  when the category is what decides (section 9). */
  categoryName: string | null
  /** The complete scoped label, e.g. "Flow::Doing" — not just the part
   *  after `::`. That is what the `[status]` table is keyed by, so core
   *  looks it up directly (R7). */
  label: string | null
}

/** One issue inside a bundle (CONTEXT.md "Item"). */
export type Item = {
  key: string           // stable across runs, see section 5
  /** The number GitLab counts per project. Used for display ("#12"),
   *  never for identity — the key carries that. */
  number: number
  title: string
  /** Empty string when the source has none, never null (EC11). */
  description: string
  closed: boolean
  stage: Stage
  url: string
  /** Key of the bundle this item belongs to. A field, not a hierarchy. */
  bundle: string
  /** A Date, not an ISO string: an ISO string is a rendering decision, and
   *  that belongs to the output stage — the same reasoning as for progress
   *  being a number pair (ADR-0008). */
  updatedAt: Date
  health: Health | null
}

/** A named group of issues (CONTEXT.md "Bundle").
 *
 *  Why `items` hangs off the bundle instead of standing flat beside it:
 *  progress is the property the tool exists for, and it is a statement
 *  ABOUT the set. A flat list with a `bundle` field could carry an item
 *  without a bundle, and the type would permit it. */
export type Bundle = {
  key: string
  number: number
  name: string
  description: string
  closed: boolean
  /** null when GitLab supplies no date. Never filled from config (ADR-0006). */
  due: Date | null
  url: string
  /** null when the count could not be obtained — never 0/0 (ADR-0015). */
  progress: Progress | null
  /** The newest updatedAt among the bundle, its items and its children. */
  lastActivity: Date
  /** Rolled up from descendants; null when nobody maintains it. */
  health: Health | null
  items: Item[]
  /** Direct child bundles. Empty for milestones, and for epics without
   *  sub-epics. Needed for the special case in section 9 / AK7.
   *  Only ever one level deep — see R3c. */
  children: Bundle[]
}

/** The configuration as core sees it. Flat, camelCase, already validated:
 *  reading the TOML and checking it happens before this (R29), so no
 *  function in `src/core/` ever meets a raw config file. */
export type CoreConfig = {
  /** Needed to build the URL form of the key (section 5). */
  host: string
  keyIs: 'id' | 'url'
  stageSource: 'label' | 'status'
  /** Full scoped label -> the value written to the target. */
  statusMap: ReadonlyMap<string, string>
  /** Values from statusMap that mean "someone is working on it".
   *  Order is significant: when children disagree, the first entry
   *  wins (section 9). Keep the order the config file gives. */
  active: readonly string[]
  /** Values that mean "it is stuck". Order is significant, as above. */
  blocked: readonly string[]
  /** Value for a closed bundle. */
  closed: string
  /** Value when nothing else matches. */
  default: string
}

/** What a source returns. Bundles plus what the report needs to explain
 *  an empty column — neither belongs on the narrow `Bundle` type. */
export type SourceResult = {
  bundles: Bundle[]
  /** Scoped-label prefixes found in the source, the part before the LAST
   *  `::` (R7a). The report names them when `state` stayed empty. */
  prefixes: string[]
  /** Keys of bundles whose tree reaches deeper than the state could
   *  follow — the deepest queried level still reporting children (R3c).
   *  Keys, not bundles: the report names them, it does not read them. */
  truncated: string[]
}

/** One row on its way to the target. Everything derived is decided here;
 *  the output stage renders and never computes.
 *  `bundle` and `item` are the two levels of section 6 — a target without
 *  the `type` column only ever sees 'bundle' (EC5). */
export type Row = {
  level: 'bundle' | 'item'
  key: string
  /** The number GitLab counts per project, for DISPLAY ("#12"). It travels
   *  as its own field because identity is the key's job and display is this
   *  one's (CONTEXT.md "Number") — reading it back out of the key inverts
   *  that, and under `keyIs = 'url'` there is no number in the key to read. */
  number: number
  name: string
  /** From `stateOf` for a bundle, from the item's verdict for an item.
   *  Already the value the board speaks — never a core word. */
  state: string
  /** Whether this counts as finished — by the same rule the state table
   *  applies, so a `done` or `cancelled` category counts even while GitLab
   *  still calls the item open (section 9).
   *
   *  It travels as its own field because it CANNOT be read back off
   *  `state`: under `stageSource = 'status'` a finished item carries its
   *  display name ("Verification"), not the closed value. The page body
   *  needs it for the ✓/○ mark and for listing finished items first
   *  (section 7), and the output stage has no CoreConfig to compare
   *  against — by design (section 4b). */
  closed: boolean
  /** null stays null: the column is left empty, never written as 0
   *  (ADR-0015). Always null for an item. */
  progress: Progress | null
  url: string
  due: Date | null
  activity: Date
  health: Health | null
  /** What goes into the page body (section 7). */
  description: string
  /** Bundle rows carry their items so the body can list them; an item row
   *  carries none of its own. */
  items: readonly Row[]
}
