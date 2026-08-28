import type { Client } from '@notionhq/client'
import type { Row } from '../../core/types.js'
import { bodyOf, day } from './body.js'
import type { TargetSchema } from './schema.js'
import { createRetrier, realSleep, type Retrier } from './throttle.js'

/** Notion returns at most 100 rows per query — the same limit the block
 *  listing carries, and it is Notion's, not a choice made here. */
const PAGE_SIZE = 100

/**
 * Which Notion types a role can actually be written into.
 *
 * Several roles take more than one, and that is not laxity: `key` is written
 * as a link when the column is a URL and as text otherwise, and the three
 * select-like roles take Notion's `status` type under its own key. The writer
 * below branches on exactly these, so the list is what it can handle rather
 * than what `init` would create — `columns.ts` names the one type it creates,
 * which is a different question.
 *
 * A column of any OTHER type is left out (EC6, ADR-0021). Notion would answer
 * 400, and every row writes the same columns: the run would fail per row,
 * `outcome.ts` would see zero successes and report "the run did not happen" —
 * for a table that is merely one column short. Leaving it out costs that
 * column and writes the rest, which is what the spec asks for: an abort
 * halfway through is worse than an omission at the start.
 */
const ACCEPTS: Readonly<Record<string, readonly string[]>> = {
  // NOT `title`: the lookup reads the key back out of the target and knows
  // only these two shapes (`keyOf` below). A key in the title column would be
  // written and then never found again, so every run would create the rows
  // afresh — the failure the key exists to prevent.
  key: ['rich_text', 'url'],
  name: ['title'],
  state: ['select', 'status'],
  progress: ['number'],
  url: ['url'],
  due: ['date'],
  type: ['select', 'status'],
  activity: ['date'],
  health: ['select', 'status'],
}

/** One role the target cannot hold, for the closing report (EC6). */
export type UnusableColumn = { role: string; column: string; type: string; wanted: readonly string[] }

/**
 * The roles whose column exists but has a type they cannot be written into.
 *
 * Decided from the SCHEMA, before the first row — the whole point of EC6 is
 * that this is knowable at the start, while a 400 only arrives once part of
 * the table is already written.
 */
export function unusableRoles(
  schema: TargetSchema,
  columns: Readonly<Record<string, string>>,
): UnusableColumn[] {
  const out: UnusableColumn[] = []

  for (const [role, column] of Object.entries(columns)) {
    const type = schema.types.get(column)
    const wanted = ACCEPTS[role]
    // An unknown role and a column the target does not carry are both somebody
    // else's finding — `planColumns` names the first, R16 drops the second.
    if (type === undefined || wanted === undefined) continue
    if (!wanted.includes(type)) out.push({ role, column, type, wanted })
  }

  return out
}

/** One row that could not be written, for the closing report. Never a reason
 *  to abort the run (section 12). */
export type WriteFailure = { key: string; reason: string }

/** What one pass over the rows did, as the report needs it. */
export type WriteResult = {
  created: number
  updated: number
  /** Keys the target holds more than once. Hand-made — the tool cannot
   *  produce them (EC4). The first row is updated, the rest are reported,
   *  and nothing is ever deleted (R21). */
  duplicates: string[]
  failures: WriteFailure[]
  /** Roles left out because the target's column has the wrong type (EC6).
   *  A gap in the board, not a failure of the run: the other columns were
   *  written, and the report names this one so nobody reads the empty column
   *  as a statement. */
  unusable: UnusableColumn[]
}

/**
 * Write the rows, one page per row: find by key, then create or update.
 * Notion has no native upsert (R18).
 *
 * Nothing is ever deleted, not even for a bundle that disappeared from
 * GitLab (R21): a delete path would have turned the first wrong key into
 * data loss, and the key is the place with the most assumption in it.
 */
export function createNotionWriter(
  client: Client,
  schema: TargetSchema,
  columns: Readonly<Record<string, string>>,
  /** Every request goes through here, so throttling is wrapped ONCE at the
   *  request layer rather than at each call site. */
  retrier: Retrier = createRetrier(realSleep),
) {
  const send = <T>(request: () => Promise<T>) => retrier.run(request)

  /** Roles left out because the target's column has a type they cannot be
   *  written into (EC6). Collected once, reported once — the report names
   *  them rather than leaving the reader to infer them from a 400. */
  const unusable = unusableRoles(schema, columns)

  /** Only columns that are in [columns], that the target carries (R16), AND
   *  whose type can hold this role (EC6). Everything else falls out cleanly —
   *  that is what makes `health` usable: a team not maintaining it leaves the
   *  column out and loses nothing. */
  const column = (role: string): string | null => {
    const name = columns[role]
    if (name === undefined || !schema.types.has(name)) return null
    return unusable.some((u) => u.role === role) ? null : name
  }

  /** Columns are addressed by NAME, never by property id. Not out of
   *  convenience — the interface allows nothing else: a write with the id
   *  (YndJYA instead of "Lifecycle") is rejected with
   *  `Property "YndJYA" not found`, although that same id is handed over
   *  when reading the schema (measured 2026-08-24). */
  function propertiesOf(row: Row): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    const key = column('key')
    if (key !== null) {
      // The key column may be a URL type when key_is = "url" points it at the
      // same column as the link — write it in the shape the schema names.
      out[key] = schema.types.get(key) === 'url' ? { url: row.key } : text(row.key)
    }

    const name = column('name')
    if (name !== null) out[name] = { title: [{ text: { content: row.name } }] }

    const state = column('state')
    if (state !== null && row.state !== '') out[state] = selectOf(schema, state, row.state)

    const progress = column('progress')
    if (progress !== null) {
      // The FRACTION, not the whole number. A Number column with percent
      // formatting expects 0..1 — measured: 0.4 shows as 40 %, 1 as 100 %,
      // and 40 as 4000 %. The API accepted all three without error or
      // warning; only the rendered cell reveals the difference. Do not
      // "correct" this to 40.
      // null stays null: the column is left EMPTY, never written as 0 %,
      // because a bundle nobody has filled reads as "nothing known", not as
      // "nothing done" (ADR-0015, EC1).
      // Rounded to whole percent: 1 of 7 is 0.14285714285714285, and Notion's
      // percent column renders every digit it is given. The exact counts stay
      // in the page body ("1 of 7 done", section 7), so nothing is lost —
      // the cell is for sorting and filtering, not for precision.
      out[progress] = {
        number: row.progress === null ? null : Math.round(row.progress.ratio * 100) / 100,
      }
    }

    const url = column('url')
    if (url !== null) out[url] = { url: row.url === '' ? null : row.url }

    const due = column('due')
    // Empty when there is no date, and NEVER filled from the config
    // (ADR-0006, EC8): a due date is project content, and the configuration
    // says how to read the source, never what is in it.
    if (due !== null) out[due] = dateOf(row.due)

    const type = column('type')
    if (type !== null) out[type] = selectOf(schema, type, row.level === 'bundle' ? 'Bundle' : 'Item')

    const activity = column('activity')
    if (activity !== null) out[activity] = dateOf(row.activity)

    const health = column('health')
    if (health !== null) out[health] = row.health === null ? selectEmpty(schema, health) : selectOf(schema, health, row.health)

    return out
  }

  return {
    /** One pass over the rows. A row that keeps failing is skipped and
     *  named in the report — the run does not abort (section 12). */
    async write(rows: readonly Row[]): Promise<WriteResult> {
      const result: WriteResult = { created: 0, updated: 0, duplicates: [], failures: [], unusable }
      const lookUp = await lookupFor(rows.length)

      for (const row of rows) {
        try {
          const found = await lookUp(row.key)
          if (found.length > 1) result.duplicates.push(row.key)

          const properties = propertiesOf(row)
          const body = bodyOf(row, column('activity') !== null)
          const first = found[0]
          if (first === undefined) {
            // parent is data_source_id, not database_id: the interface takes
            // both, but only this one is unambiguous when a database holds
            // several data sources (section 4b).
            // A new page carries its body straight away — no second call,
            // and nothing to replace yet.
            await send(() =>
              client.pages.create({
                parent: { type: 'data_source_id', data_source_id: schema.dataSourceId },
                properties: properties as never,
                children: body as never,
              }),
            )
            result.created += 1
          } else {
            await send(() => client.pages.update({ page_id: first, properties: properties as never }))
            await replaceBody(first, body)
            result.updated += 1
          }
        } catch (cause) {
          result.failures.push({ key: row.key, reason: cause instanceof Error ? cause.message : String(cause) })
        }
      }

      return result
    },
  }

  /**
   * The body is REPLACED on every run, at every level, without a switch
   * (ADR-0009, R19): the table is a view, so what a human writes into the
   * page does not survive. A Notion comment does, and those are never
   * touched — deleting blocks does not touch comments.
   *
   * Replaced, not appended: appending would grow the page on every run.
   */
  async function replaceBody(pageId: string, body: readonly unknown[]): Promise<void> {
    // Notion returns at most 100 blocks per page, so the listing is followed
    // to its end: a body of 3 + one bullet per item passes 100 at roughly 97
    // items, which a rolled-up epic reaches. Stopping at the first page would
    // leave the rest standing, and ADR-0009 says the body is replaced on
    // every run — not mostly replaced.
    let cursor: string | undefined
    do {
      const page = await send(() =>
        client.blocks.children.list(cursor === undefined ? { block_id: pageId } : { block_id: pageId, start_cursor: cursor }),
      )
      for (const block of page.results) {
        await send(() => client.blocks.delete({ block_id: block.id }))
      }
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
    } while (cursor !== undefined)

    if (body.length > 0) {
      // The same limit applies when writing: at most 100 children per call.
      for (let at = 0; at < body.length; at += 100) {
        const slice = body.slice(at, at + 100)
        await send(() => client.blocks.children.append({ block_id: pageId, children: slice as never }))
      }
    }
  }

  /**
   * How the keys already in the target are looked up — the SAME answer
   * either way, at different cost.
   *
   * Per row it is one query each; read ahead it is one query per 100 rows of
   * the target, whatever the run writes. Which is cheaper depends on both
   * sizes, and both are known here: reading ahead wins as soon as the target
   * needs fewer pages than the run has rows.
   *
   * That the two are unrelated is not a detail. Nothing is ever deleted
   * (R21) while `include_closed = false` keeps finished bundles out of the
   * rows, so an old board grows while its runs shrink — reading a
   * five-thousand-row target ahead to write three rows would be the slower
   * path, and it is the normal state of a board that has run for a year.
   *
   * Duplicates survive the choice: they can only come from hand-editing
   * (EC4), so they are in the target before the run starts, and reading
   * ahead sees ALL of a key's pages rather than one query's answer.
   * A key cannot appear twice among the rows themselves — it carries the
   * namespace, the number and the kind (R12a).
   */
  async function lookupFor(rows: number): Promise<(key: string) => Promise<string[]>> {
    const name = column('key')
    if (name === null) return async () => []

    const index = await indexOfTarget(name, rows)
    if (index === null) return findByKey
    return async (key: string) => index.get(key) ?? []
  }

  /** Every key in the target, or null when reading it would cost more than
   *  looking each row up. The first page also ANSWERS that question: Notion
   *  reports `has_more`, so one query decides it without guessing. */
  async function indexOfTarget(name: string, rows: number): Promise<Map<string, string[]> | null> {
    const index = new Map<string, string[]>()
    let cursor: string | undefined
    let pages = 0

    do {
      const response = await send(() =>
        client.dataSources.query(
          cursor === undefined
            ? { data_source_id: schema.dataSourceId, page_size: PAGE_SIZE }
            : { data_source_id: schema.dataSourceId, page_size: PAGE_SIZE, start_cursor: cursor },
        ),
      )
      pages += 1

      for (const page of response.results) {
        const key = keyValueOf(page, name)
        if (key === null) continue
        const seen = index.get(key)
        if (seen === undefined) index.set(key, [page.id])
        else seen.push(page.id)
      }

      // One page already tells us the target is small enough. Beyond that,
      // stop as soon as reading on would cost more than the per-row lookups
      // it saves — the pages read so far are not wasted, they just do not
      // pay for themselves, and the per-row path answers from the target
      // rather than from a half-filled map.
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
      if (cursor !== undefined && pages >= rows) return null
    } while (cursor !== undefined)

    return index
  }

  /** The page ids carrying this key, in the order the target returns them.
   *  More than one can only come from hand-editing (EC4). */
  async function findByKey(key: string): Promise<string[]> {
    const name = column('key')
    if (name === null) return []

    const property = schema.types.get(name)
    const filter =
      property === 'url'
        ? { property: name, url: { equals: key } }
        : { property: name, rich_text: { equals: key } }

    const response = await send(() =>
      client.dataSources.query({ data_source_id: schema.dataSourceId, filter: filter as never }),
    )
    return response.results.map((page) => page.id)
  }
}

export type NotionWriter = ReturnType<typeof createNotionWriter>

/**
 * The key column's value on one page, whichever shape it carries.
 *
 * Two callers need exactly this: the writer, to find the page belonging to a
 * row, and the key-form pre-check, to see which form the existing rows use.
 * They must read the SAME value — a second copy that drifts would let the
 * pre-check pass on a form the writer then fails to find, which is the
 * duplicate-row failure the check exists to prevent. `prefixOf` in
 * `src/core/label.ts` records the same class of defect from a real one.
 *
 * Only `url` and `rich_text`: those are the two shapes a key column may have
 * (see ACCEPTS above), so there is no third case to handle.
 */
export function keyValueOf(page: unknown, column: string): string | null {
  const properties = (page as { properties?: Record<string, unknown> }).properties
  const cell = properties?.[column] as { url?: string | null; rich_text?: { plain_text?: string }[] } | undefined
  if (cell === undefined) return null
  if (typeof cell.url === 'string') return cell.url
  return cell.rich_text?.[0]?.plain_text ?? null
}

function text(value: string): Record<string, unknown> {
  return { rich_text: [{ text: { content: value } }] }
}

/** A select column takes a name, a status column takes the same shape under
 *  its own key — both were read in the schema, so the type decides. */
function selectOf(schema: TargetSchema, column: string, value: string): Record<string, unknown> {
  return schema.types.get(column) === 'status' ? { status: { name: value } } : { select: { name: value } }
}

function selectEmpty(schema: TargetSchema, column: string): Record<string, unknown> {
  return schema.types.get(column) === 'status' ? { status: null } : { select: null }
}

/** Dates go out under the explicit API name. The bare column name works too
 *  (measured 2026-08-24), but the explicit form is documented, unambiguous,
 *  and survives a change in that leniency. */
function dateOf(value: Date | null): Record<string, unknown> {
  return { date: value === null ? null : { start: day(value) } }
}
