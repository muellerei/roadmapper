import type { Client } from '@notionhq/client'

/**
 * The Notion type each role needs (section 6). Only these are ever created —
 * `init` adds what is missing and NEVER changes a column that exists.
 *
 * That restraint is the point: the target is usually somebody else's table,
 * and a tool that silently retypes a column people work in would be the
 * opposite of safe to run repeatedly (CONTEXT.md, owned column).
 */
const SHAPES: Readonly<Record<string, Record<string, unknown>>> = {
  key: { rich_text: {} },
  name: { title: {} },
  // The percent format matters: the column takes the fraction 0…1, and as a
  // plain number the reader sees 0.63 where they expect 63 % (EC6a).
  progress: { number: { format: 'percent' } },
  url: { url: {} },
  due: { date: {} },
  activity: { date: {} },
  // A select WITHOUT options — the values are the board's own and come from
  // [status], so they are filled in by the caller (see stateOptions below).
  state: { select: {} },
  type: { select: { options: [{ name: 'Bundle' }, { name: 'Item' }] } },
  health: { select: { options: [{ name: 'ok' }, { name: 'attention' }, { name: 'risk' }] } },
}

export type ColumnPlan = {
  /** Roles whose column is already there. */
  present: string[]
  /** Roles whose column init can add. */
  missing: { role: string; name: string }[]
  /** Configured roles this tool does not know how to create. */
  unknown: string[]
}

/**
 * The values a `state` column has to offer: every target value from
 * `[status]`, plus `closed` and `default`.
 *
 * Without them `init` creates an empty select, and the very next run stops at
 * its own pre-check — telling the user to add options the tool already knows.
 * Measured against a real database on 2026-08-25, which is the only place
 * this shows: a stub accepts an optionless select without complaint.
 */
export function stateOptions(cfg: {
  statusMap: ReadonlyMap<string, string>
  closed: string
  default: string
}): { name: string }[] {
  return [...new Set([...cfg.statusMap.values(), cfg.closed, cfg.default])].map((name) => ({ name }))
}

/** What is there and what is not — decided before anything is written. */
export function planColumns(
  columns: Readonly<Record<string, string>>,
  carried: ReadonlySet<string>,
): ColumnPlan {
  const plan: ColumnPlan = { present: [], missing: [], unknown: [] }

  for (const [role, name] of Object.entries(columns)) {
    if (carried.has(name)) plan.present.push(role)
    else if (SHAPES[role] === undefined) plan.unknown.push(role)
    else plan.missing.push({ role, name })
  }

  return plan
}

/**
 * Add the missing columns. Only ADDS: an existing column is never retyped,
 * renamed or removed, whatever its current type.
 *
 * Returns the names it created, so `init` can report them rather than
 * changing the target quietly.
 */
export async function createColumns(
  client: Client,
  dataSourceId: string,
  missing: readonly { role: string; name: string }[],
  /** The board's own state values, for the one column whose options are not
   *  a fixed set. */
  states: readonly { name: string }[] = [],
): Promise<string[]> {
  if (missing.length === 0) return []

  const properties: Record<string, unknown> = {}
  for (const { role, name } of missing) {
    properties[name] = role === 'state' && states.length > 0 ? { select: { options: [...states] } } : SHAPES[role]
  }

  await client.dataSources.update({ data_source_id: dataSourceId, properties: properties as never })
  return missing.map((m) => m.name)
}
