import type { Client } from '@notionhq/client'
import type { CoreConfig, Row } from '../../core/types.js'
import { precheckKeyForm, precheckTarget } from './precheck.js'
import { readSchema, type TargetSchema } from './schema.js'
import { createRetrier, realSleep, type Retrier } from './throttle.js'
import { createNotionWriter, keyValueOf, type WriteResult } from './write.js'

/**
 * The Notion output stage as one unit: read the schema, check it, write.
 *
 * A factory taking its dependencies as parameters (ADR-0010, R14) — `sleep`
 * and `random` are here so a test can drive the retry paths on a clock it
 * advances instead of waiting real seconds.
 */
export function createNotionTarget(
  client: Client,
  columns: Readonly<Record<string, string>>,
  sleep: (ms: number) => Promise<void> = realSleep,
  random: () => number = Math.random,
) {
  const retrier = createRetrier(sleep, random)

  return {
    /**
     * One run. The order is the point: the schema is known before anything
     * is checked, and everything is checked before the first row is written
     * — a 400 halfway through would leave a half-written table.
     *
     * `sourceStates` carries the status names the source delivered, needed
     * only under `stageSource = 'status'` for the select pre-check.
     */
     async write(
      databaseId: string,
      rows: readonly Row[],
      cfg: CoreConfig,
      sourceStates: readonly string[] = [],
    ): Promise<WriteResult & { schema: TargetSchema; skippedItems: number }> {
      const schema = await readSchema(client, databaseId, retrier)
      precheckTarget(schema, cfg, columns, sourceStates)

      // R29's last check, and it needs the TARGET rather than the file: a key
      // column holding the other form means key_is was changed after those
      // rows were written. Writing on would add a second row beside every
      // existing one, so the run stops instead — before the first write.
      precheckKeyForm(await sampleKeys(client, schema, columns, retrier), cfg)

      // EC5 — a target that does not carry the `type` column gets BUNDLES
      // ONLY. A table that cannot tell the levels apart in its rows carries
      // one kind, and on roadmap altitude that is the bundle level. This
      // follows from the SCHEMA, never from a setting (ADR-0006).
      const typeColumn = columns['type']
      const carriesLevels = typeColumn !== undefined && schema.types.has(typeColumn)
      const wanted = carriesLevels ? rows : rows.filter((row) => row.level === 'bundle')

      const writer = createNotionWriter(client, schema, columns, retrier)
      const result = await writer.write(wanted)

      return { ...result, schema, skippedItems: rows.length - wanted.length }
    },
  }
}

export type NotionTarget = ReturnType<typeof createNotionTarget>

/**
 * A sample of what the key column already holds.
 *
 * One page is enough: the question is which FORM the existing rows use, and
 * a target does not mix the two by itself. An empty target has nothing to
 * contradict, and a target the query cannot read is not this check's problem
 * — the schema read above already established access.
 */
async function sampleKeys(
  client: Client,
  schema: TargetSchema,
  columns: Readonly<Record<string, string>>,
  /** The same retrier the writer uses. Every request to Notion goes through
   *  one, including this one: it is the FIRST query of a run, so meeting a
   *  429 here would abort before a single row was written — and the pacing it
   *  keeps is per-target, which only holds if every call shares it. */
  retrier: Retrier,
): Promise<string[]> {
  const column = columns['key']
  if (column === undefined || !schema.types.has(column)) return []

  const response = await retrier.run(() =>
    client.dataSources.query({
      data_source_id: schema.dataSourceId,
      page_size: 20,
    }),
  )

  return response.results
    .map((page) => keyValueOf(page, column))
    .filter((value): value is string => value !== null && value !== '')
}

