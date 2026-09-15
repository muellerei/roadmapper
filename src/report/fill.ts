import { quote } from '../messages.js'
import { prefixOf } from '../core/label.js'
import type { CoreConfig, Row } from '../core/types.js'
import type { UnusableColumn } from '../output/notion/write.js'

/**
 * The fill rate per column — section 12 calls it the most important message
 * of the tool, and that is not cosmetic reporting.
 *
 * Every single decision of this spec is right on its own: progress empty
 * instead of 0 %, due empty instead of guessed, stage null instead of
 * guessed, health empty when unmaintained. THEIR SUM IS AN EMPTY BOARD, and
 * no error path fires — the run reports success. Measured, not feared: in
 * gitlab-org no epic carries such a label at all, so the example
 * configuration would leave `state` on the default for every row while the
 * run looked healthy.
 */
export type FillReport = {
  bundles: number
  items: number
  columns: ColumnFill[]
  /** What to look at when the state column says nothing. */
  hints: string[]
}

export type ColumnFill = {
  column: string
  filled: number
  total: number
  /** Named for `state`: which source it came from, and how the values are
   *  distributed. */
  note: string | null
}

/**
 * Build the report.
 *
 * `prefixes` are the scoped-label prefixes the source actually found (R7a).
 * The report consumes them, it does not re-derive them.
 *
 * `unusable` are the columns EC6 left out for their type. They are passed in
 * rather than re-derived for the same reason: the writer already decided it,
 * and a second derivation here could disagree with the message the writer
 * prints eight lines further up.
 */
export function fillOf(
  rows: readonly Row[],
  cfg: CoreConfig,
  columns: Readonly<Record<string, string>>,
  carried: ReadonlySet<string>,
  prefixes: readonly string[],
  unusable: readonly UnusableColumn[] = [],
): FillReport {
  const bundles = rows.filter((r) => r.level === 'bundle')
  const items = rows.filter((r) => r.level === 'item')
  const hints: string[] = []

  // `carried` says the column EXISTS; this says it was WRITTEN. For every
  // other column the two coincide, which is why the difference stayed
  // invisible until EC6 split them apart.
  const skipped = new Map(unusable.map((u) => [u.column, u]))

  const columnsOut: ColumnFill[] = []
  for (const [role, name] of Object.entries(columns)) {
    if (!carried.has(name)) continue

    // AK23 counts the rate for every WRITTEN column, and a column left out
    // for its type is not one. Its rows do carry values — counting them
    // would state the SOURCE data while the reader takes it for the target,
    // and the board would silently have no data at all. The line stays at 0
    // rather than vanishing: a column dropping out of the report is itself a
    // silence, and this one is worth naming.
    const skip = skipped.get(name)
    if (skip !== undefined) {
      columnsOut.push({ column: name, filled: 0, total: rows.length, note: skipNote(skip) })
      continue
    }

    const filled = rows.filter((row) => isFilled(row, role, cfg)).length
    columnsOut.push({ column: name, filled, total: rows.length, note: noteFor(role, rows, cfg) })
  }

  // The state column is where an empty board hides, so it gets the extra
  // diagnosis rather than a bare rate.
  const onDefault = rows.filter((row) => row.state === cfg.default).length
  if (rows.length > 0 && onDefault > rows.length / 2) {
    hints.push(stateHint(cfg, prefixes, onDefault, rows.length))
  }

  return { bundles: bundles.length, items: items.length, columns: columnsOut, hints }
}

/** Why a skipped column reads zero: the target's own type, named, so the
 *  rate and the EC6 message above it tell the same story. */
function skipNote(skip: UnusableColumn): string {
  return `left out: the column is ${skip.type}, needs ${skip.wanted.join(' or ')}`
}

/** Why a column is empty, told rather than left to guess. */
function noteFor(role: string, rows: readonly Row[], cfg: CoreConfig): string | null {
  if (role === 'state') {
    // ALWAYS name the source. Without it the reader does not know where to
    // look when the column is meaningless: at the labels or at the status
    // field. The source is in the config, but the report gets read and the
    // config does not.
    const from = cfg.stageSource === 'label' ? 'from labels' : "from GitLab's status field"
    const spread = distributionOf(rows.map((r) => r.state))
    return spread === '' ? from : `${from}; ${spread}`
  }

  const filled = rows.filter((row) => isFilled(row, role, cfg)).length
  if (filled > 0 || rows.length === 0) return null

  // A column filled to zero per cent says what caused it.
  if (role === 'health') return 'field not maintained in GitLab'
  if (role === 'due') return 'no bundle carries a date in GitLab'
  if (role === 'progress') return 'GitLab returned no counts'
  return null
}

/**
 * The DISTRIBUTION of values, counted descending — a rate alone deceives
 * here. Under `stage_source = "status"` the column is practically always
 * 100 % filled, because GitLab assigns a category even when nobody made a
 * decision: `state 30/30` would look healthy while 28 rows sit on the
 * default and the column says nothing.
 *
 * No threshold and no judgement: the report shows the numbers and the reader
 * sees for themselves. A threshold in the tool would be a claim about
 * foreign projects — the same reasoning with which section 8 refuses a
 * standstill threshold.
 */
function distributionOf(values: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => `${count}x ${value}`)
    .join(', ')
}

/**
 * What to enter, not merely that something is missing.
 *
 * Includes a CASE counter-check: the lookup is codepoint-exact (R7), and so
 * are GitLab's label filters — measured, one prefix and the same prefix
 * with a different first letter are two different labels there, both in
 * use side by side — one returned nothing, the other more than the query
 * could carry. Two spellings of one word look identical in a report. The LOOKUP does not become fuzzy,
 * only the diagnosis.
 */
function stateHint(cfg: CoreConfig, prefixes: readonly string[], onDefault: number, total: number): string {
  const wanted = [...new Set([...cfg.statusMap.keys()].map(prefixOf))].filter((p) => p !== '')

  if (cfg.stageSource === 'status') {
    return `${onDefault} of ${total} rows fell to ${quote(cfg.default)}. The state comes from GitLab's status field — check that it is maintained, or set stage_source = "label".`
  }

  const found = prefixes.length === 0 ? '(none)' : prefixes.join(', ')
  const caseOnly = wanted.filter((want) =>
    prefixes.some((found) => found !== want && found.toLowerCase() === want.toLowerCase()),
  )

  if (caseOnly.length > 0) {
    const spotted = caseOnly
      .map((want) => `${quote(want)} vs ${quote(prefixes.find((p) => p.toLowerCase() === want.toLowerCase())!)}`)
      .join(', ')
    return `${onDefault} of ${total} rows fell to ${quote(cfg.default)}. Your [status] table and the source differ only in CASE: ${spotted}. Labels are case-sensitive.`
  }

  return `${onDefault} of ${total} rows fell to ${quote(cfg.default)}. Your [status] table maps ${wanted.map(quote).join(', ') || '(nothing scoped)'}. Found in source: ${found}. Adjust [status], or drop the state column.`
}

/**
 * Whether this row says something in this column.
 *
 * `state` is the one role where non-empty is not the same as filled: a row
 * that fell to `default` carries a value, and it is precisely the value that
 * means "nothing was found here". AK23 spells the consequence out — 30 bundles
 * with `state` set twice read `state 2/30`, not `30/30`. Counting the default
 * as filled would make the one column the report exists for the one column it
 * cannot say anything about: under `stage_source = "status"` GitLab assigns a
 * category to everything, so the rate would sit at 100 % on a board where
 * nobody ever made a decision.
 *
 * The DISTRIBUTION in `noteFor` stays as it is and still counts every value —
 * the two answer different questions, and seeing `28x Backlog` beside `2/30`
 * is what makes the rate readable.
 */
function isFilled(row: Row, role: string, cfg: CoreConfig): boolean {
  switch (role) {
    case 'key':
      return row.key !== ''
    case 'name':
      return row.name !== ''
    case 'state':
      return row.state !== '' && row.state !== cfg.default
    case 'progress':
      return row.progress !== null
    case 'url':
      return row.url !== ''
    case 'due':
      return row.due !== null
    case 'activity':
      return true
    case 'health':
      return row.health !== null
    case 'type':
      return true
    default:
      return false
  }
}

/** The report as text. Program output, therefore English — the VALUES in it
 *  are data and are quoted verbatim in whatever language the board uses. */
export function renderFill(report: FillReport): string {
  const lines = [`${report.bundles} bundles, ${report.items} items written.`]

  for (const column of report.columns) {
    const rate = `${column.filled}/${column.total}`.padEnd(9)
    lines.push(`  ${column.column.padEnd(16)}${rate}${column.note === null ? '' : `(${column.note})`}`)
  }

  for (const hint of report.hints) lines.push('', hint)
  return `${lines.join('\n')}\n`
}
