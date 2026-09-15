import type { Bundle, CoreConfig, Item } from './types.js'

/** What one child contributes to its bundle's state. One shape for items AND
 *  child bundles, so the recursion can treat both alike.
 *
 *  Why a Verdict rather than a string: a child bundle carries no stage but a
 *  derived target value. If the helpers returned only the string, the
 *  recursion would have to reconstruct the meaning a second time — and under
 *  `stageSource = 'status'` that would be impossible, because the string has
 *  lost the category. */
export type Verdict = {
  /** What goes into the target column. */
  value: string
  done: boolean
  active: boolean
  blocked: boolean
}

/**
 * The state of a bundle, by the table of section 9 — first matching row wins:
 *
 *   1  bundle closed                                   -> cfg.closed
 *   2  no children (BOTH lists empty)                  -> cfg.default
 *   3  ALL children done                               -> cfg.closed
 *   4  ALL OPEN children blocked                       -> the blocked value
 *   5  at least one child active, OR at least one done -> the active value
 *   6  otherwise                                       -> cfg.default
 *
 * The state reads the DIRECT children while progress counts the whole tree.
 * That is the division of labour, not a defect: progress must count deep or
 * the quantity is wrong, and "is it moving" is not a sum. The one-level
 * bound, and what the run says about it, is ADR-0024.
 */
export function stateOf(bundle: Bundle, cfg: CoreConfig): string {
  return verdictOfBundle(bundle, cfg).value
}

/**
 * The table of section 9, deciding a bundle's state AND what that state
 * means. Both at once, because they are one decision: the row that fires
 * determines the value and the meaning together.
 *
 * That is what the spec means by "the recursion needs no path of its own"
 * (section 9, referring to an `isActive` that R10's written-out body then
 * lost). A child bundle carries no stage, so its meaning cannot be read back
 * off its value: under `stageSource = 'status'` the configuration's `active`
 * list is not even set — the category carries the meaning, and a bundle has
 * no category. Deriving the flags a second time from the returned string is
 * therefore not merely duplication, it is impossible. So the flags travel
 * out of the row that produced them, and `verdictOfBundle` is the ONLY place
 * a bundle's meaning is decided.
 *
 * Two scars in the row order, and both compile cleanly when smoothed out:
 *
 * Row 4 stands BEFORE row 5. The other way round row 4 would be nearly
 * unreachable — one finished ticket triggers "at least one done", and an
 * epic with nine done and one blocked would report "in progress" while
 * nothing moves.
 *
 * Row 5 reads `children`, NOT `open`. "At least one done" is the proof that
 * work HAPPENED here, and done children are not in the open list.
 */
function verdictOfBundle(bundle: Bundle, cfg: CoreConfig): Verdict {
  // Row 1 — closed beats everything, one level up as well.
  if (bundle.closed) return { value: cfg.closed, done: true, active: false, blocked: false }

  // One verdict per child, computed ONCE: the rows below query the same list
  // several times and the recursion descends — computing twice would mean
  // descending twice.
  const children: Verdict[] = [
    ...bundle.items.map((i) => verdictOfItem(i, cfg)),
    ...bundle.children.map((c) => verdictOfBundle(c, cfg)),
  ]

  // Row 2 — "no children" means BOTH lists empty. Nothing known: neither
  // done nor active nor blocked.
  if (children.length === 0) return { value: cfg.default, done: false, active: false, blocked: false }

  const open = children.filter((k) => !k.done)

  // Row 3
  if (open.length === 0) return { value: cfg.closed, done: true, active: false, blocked: false }
  // Row 4 — before row 5. `every` cannot fire on an empty set here: row 3
  // caught that case one line earlier, so the ORDER carries a condition.
  // pick() runs over the TRIGGERING children, not over all.
  if (open.every((k) => k.blocked)) {
    return { value: pick(open, cfg.blocked, cfg), done: false, active: false, blocked: true }
  }
  // Row 5 — reads `children`, NOT `open`.
  if (children.some((k) => k.active || k.done)) {
    const triggering = children.filter((k) => k.active)
    return { value: pick(triggering, cfg.active, cfg), done: false, active: true, blocked: false }
  }
  // Row 6 — nothing known, same as row 2.
  return { value: cfg.default, done: false, active: false, blocked: false }
}

/**
 * Which string when the triggering children carry different ones: the same
 * one if they all agree — otherwise the one listed FIRST in the
 * configuration. Not the first child delivered: GitLab guarantees no order,
 * and the cell would flicker between runs.
 */
function pick(triggering: readonly Verdict[], list: readonly string[], cfg: CoreConfig): string {
  const values = [...new Set(triggering.map((k) => k.value))]

  // Normal case: the configuration knows the values.
  const matches = list.filter((v) => values.includes(v))
  if (matches.length > 0) {
    // `matches` is already in CONFIGURATION order, so its first entry is the
    // right answer either way — when the triggering children agree there is
    // only one value in it. `carried` is R10's written-out form of the same
    // thing, kept because the spec states it that way; it is not a second
    // condition, and both branches were checked to agree.
    const carried = [...new Set(triggering.filter((k) => list.includes(k.value)).map((k) => k.value))]
    return carried.length === 1 ? carried[0]! : matches[0]!
  }

  // No triggering child carries a value from the list. NOT an edge case:
  // with stageSource = 'status', `active` is not set at all — the category
  // carries the meaning itself, and the display name appears in no list.
  // Then the triggering children's own value applies, SORTED, so two runs
  // produce the same cell. cfg.default here would put EVERY bundle with
  // running children on the default value while the fill rate read 30/30.
  if (values.length > 0) return [...values].sort()[0]!

  // The triggering set is EMPTY. That is row 5's `done` trigger: "at least
  // one done" proves work HAPPENED but carries no value of its own — done
  // children hold cfg.closed, which does not belong in `active`. Then the
  // value the configuration names FIRST applies. cfg.default here would
  // invert the situation (AK27a).
  return list.length === 0 ? cfg.default : list[0]!
}

/**
 * What one item contributes — the ONLY place an item's meaning is decided.
 *
 * Closed beats everything: a closed item carries cfg.closed regardless of
 * which label or category it wore when it was closed. Without that rule a
 * closed ticket with an in-progress label keeps reading "In progress".
 *
 * Only the CHOSEN source is read. The other is never looked up as a
 * fallback, even when it is filled (EC7a).
 */
export function verdictOfItem(item: Item, cfg: CoreConfig): Verdict {
  if (item.closed) return { value: cfg.closed, done: true, active: false, blocked: false }

  if (cfg.stageSource === 'label') {
    // A key access, not a search: stage.label carries the FULL scoped label
    // (R7) and statusMap is keyed by it. No suffix comparison, no
    // normalisation.
    const value = (item.stage.label !== null ? cfg.statusMap.get(item.stage.label) : undefined) ?? cfg.default
    return {
      value,
      done: false,
      active: cfg.active.includes(value),
      blocked: cfg.blocked.includes(value),
    }
  }

  // cfg.stageSource === 'status'. The value written is the DISPLAY NAME, not
  // the category: the category carries the meaning, the display name carries
  // the nuance a board chose for itself.
  const value = item.stage.categoryName ?? cfg.default
  return {
    value,
    // 'done' and 'cancelled' both count as done even when closed is false —
    // otherwise a cancelled ticket would block row 3 forever.
    done: item.stage.category === 'done' || item.stage.category === 'cancelled',
    // The category carries "active" ...
    active: item.stage.category === 'active',
    // ... but NOT "blocked". Measured: GitLab's categories have no 'blocked'
    // — the status literally named "Blocked" has category in_progress.
    // Trusting the category there would report a bundle of blocked tickets
    // as "in progress", the inversion of the situation.
    blocked: cfg.blocked.includes(value),
  }
}

/** What one child bundle contributes. Its flags come from the row of the
 *  table that produced its state, never re-derived from the string. */
export function verdictOfChild(child: Bundle, cfg: CoreConfig): Verdict {
  return verdictOfBundle(child, cfg)
}
