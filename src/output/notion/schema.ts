import type { Client } from '@notionhq/client'
import type { Retrier } from './throttle.js'

/**
 * What the target actually carries, read before the first write.
 *
 * The pre-check stays even though Notion rejects loudly — measured: an
 * unknown column and an unknown select value both come back as 400 naming
 * the allowed values. Two things the measurement does not settle keep it:
 *
 *  1. a 400 mid-run means part of the rows are already written. The check
 *     moves the error to the start, where it leaves nothing half-finished.
 *  2. only the pre-check can establish whether the target carries the `type`
 *     column, which decides whether items are written at all (EC5).
 */
export type TargetSchema = {
  dataSourceId: string
  /** Column name -> its Notion type, for every column the target carries. */
  types: ReadonlyMap<string, string>
  /** Column name -> its options, for select and status columns. A foreign
   *  table whose level column offers other names would otherwise break on
   *  the first write (AK50). */
  options: ReadonlyMap<string, readonly string[]>
}

/** The database id names a database, but the schema hangs off a DATA SOURCE
 *  — the two were separated by Notion's 2025-09-03 change. Verified against
 *  the installed SDK 5.26.0: DatabaseObjectResponse carries no `properties`
 *  at all, only DataSourceObjectResponse does. */
export class TargetUnreadable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetUnreadable'
  }
}

/**
 * Resolve the configured database to its data source and read the schema.
 *
 * The user configures only `[notion].database` — the id from the address
 * bar. Getting from there to a schema is necessarily two-step, and each step
 * has a trap read off the SDK's own types rather than off the prose docs.
 */
export async function readSchema(
  client: Client,
  databaseId: string,
  /** The run passes the target's retrier, so these two requests share the
   *  pacing with every other one (R20). `init` calls this on its own, where
   *  two requests cannot outrun a rate limit — hence the default rather than
   *  a required parameter. */
  retrier: Pick<Retrier, 'run'> = { run: (request) => request() },
): Promise<TargetSchema> {
  const database = await retrier.run(() => client.databases.retrieve({ database_id: databaseId }))

  // Trap 1: the response can be PARTIAL. GetDatabaseResponse is a union, and
  // the partial form carries only `object` and `id` — reaching for
  // data_sources without checking breaks at runtime. A partial answer is a
  // permission problem, and it is reported as one: "no data source found"
  // would send the user looking for the wrong thing.
  if (!('data_sources' in database)) {
    throw new TargetUnreadable(
      `The Notion database ${databaseId} came back without its data sources.\n` +
        `That is a permission problem, not a missing database: the integration can see\n` +
        `the id but not the content. In Notion open the database, then\n` +
        `··· → Connections → add your integration.`,
    )
  }

  const sources = database.data_sources
  if (sources.length === 0) {
    throw new TargetUnreadable(`The Notion database ${databaseId} carries no data source to write to.`)
  }
  // Trap 2: several data sources have no primary one. The reference type
  // carries `id` and `name` and nothing else — a documented negative finding,
  // so there is nothing to pick by. Guessing here would be the same class of
  // error as a silent default for the key.
  if (sources.length > 1) {
    const named = sources.map((s) => `  ${s.name} (${s.id})`).join('\n')
    throw new TargetUnreadable(
      `The Notion database ${databaseId} holds more than one data source, and none of\n` +
        `them is the primary one. Name the one to write to:\n${named}`,
    )
  }

  const dataSourceId = sources[0]!.id
  const dataSource = await retrier.run(() => client.dataSources.retrieve({ data_source_id: dataSourceId }))

  if (!('properties' in dataSource)) {
    throw new TargetUnreadable(
      `The Notion data source ${dataSourceId} came back without its schema.\n` +
        `Check that the integration has access to it.`,
    )
  }

  const types = new Map<string, string>()
  const options = new Map<string, readonly string[]>()
  for (const [name, config] of Object.entries(dataSource.properties)) {
    types.set(name, config.type)
    const listed = optionsOf(config)
    if (listed !== null) options.set(name, listed)
  }

  return { dataSourceId, types, options }
}

/** The choices a select or status column offers, or null when the column is
 *  neither. Read so the pre-check can compare before writing rather than
 *  learning it from a 400 halfway through. */
function optionsOf(config: { type: string } & Record<string, unknown>): readonly string[] | null {
  const holder = config[config.type]
  if (typeof holder !== 'object' || holder === null) return null
  const list = (holder as { options?: unknown }).options
  if (!Array.isArray(list)) return null
  return list.filter((o): o is { name: string } => typeof o?.name === 'string').map((o) => o.name)
}
