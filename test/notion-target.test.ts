import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@notionhq/client'
import { readSchema, TargetUnreadable } from '../src/output/notion/schema.js'

/**
 * The stub encodes the ASSUMED response shape. Green tests here are NOT
 * proof of the real API — they prove the writer's own logic. What the shapes
 * below are checked against is the installed SDK's generated types
 * (5.26.0), read directly: DatabaseObjectResponse carries no `properties`,
 * PartialDatabaseObjectResponse carries only `object` and `id`, and
 * DataSourceReferenceResponse carries only `id` and `name`.
 */

type Stub = {
  database?: unknown
  dataSource?: unknown
}

function clientOf(stub: Stub): Client {
  return {
    databases: {
      retrieve: async () => stub.database,
    },
    dataSources: {
      retrieve: async () => stub.dataSource,
    },
  } as unknown as Client
}

const oneSource = {
  object: 'database',
  id: 'db-1',
  data_sources: [{ id: 'ds-1', name: 'Roadmap' }],
}

const fullSchema = {
  object: 'data_source',
  id: 'ds-1',
  properties: {
    'GitLab ID': { id: 'a', name: 'GitLab ID', type: 'rich_text', rich_text: {} },
    Feature: { id: 'b', name: 'Feature', type: 'title', title: {} },
    Status: {
      id: 'c',
      name: 'Status',
      type: 'select',
      select: { options: [{ name: 'Backlog' }, { name: 'In progress' }, { name: 'Released' }] },
    },
    Progress: { id: 'd', name: 'Progress', type: 'number', number: { format: 'percent' } },
    Level: { id: 'e', name: 'Level', type: 'select', select: { options: [{ name: 'Bundle' }, { name: 'Item' }] } },
  },
}

test('the schema comes back with the column types of the data source', async () => {
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: fullSchema }), 'db-1')

  assert.equal(schema.dataSourceId, 'ds-1')
  assert.equal(schema.types.get('Feature'), 'title')
  assert.equal(schema.types.get('Progress'), 'number')
  assert.equal(schema.types.get('Status'), 'select')
})

test('AK14 a column the target does not carry is simply absent from the schema', async () => {
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: fullSchema }), 'db-1')
  assert.equal(schema.types.has('Health'), false)
})

test('AK15 the type column is what decides whether items are written at all', async () => {
  const withType = await readSchema(clientOf({ database: oneSource, dataSource: fullSchema }), 'db-1')
  assert.equal(withType.types.has('Level'), true)

  const properties = { ...fullSchema.properties } as Record<string, unknown>
  delete properties['Level']
  const without = await readSchema(
    clientOf({ database: oneSource, dataSource: { ...fullSchema, properties } }),
    'db-1',
  )
  assert.equal(without.types.has('Level'), false)
})

test('EC6 a progress column of the wrong type is visible as such, not written blindly', async () => {
  const properties = {
    ...fullSchema.properties,
    Progress: { id: 'd', name: 'Progress', type: 'rich_text', rich_text: {} },
  }
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: { ...fullSchema, properties } }), 'db-1')

  // The caller can see it is Text and skip it, naming it in the report —
  // the predecessor's table really does carry Progress as a Text column.
  assert.equal(schema.types.get('Progress'), 'rich_text')

  // ... and it DOES skip it. Without this half the writer sent {number: 0.4}
  // into a text column: Notion answers 400, every row writes that column, so
  // every row fails and the run reports "0 of N written" — an abort halfway
  // through, for a table that is one column short (EC6).
  const named = unusableRoles(schema, { key: 'GitLab ID', name: 'Feature', progress: 'Progress' })
  assert.deepEqual(named, [{ role: 'progress', column: 'Progress', type: 'rich_text', wanted: ['number'] }])
})

test('EC6 the wrong type is left out while every other column is written', async () => {
  const properties = {
    ...fullSchema.properties,
    Progress: { id: 'd', name: 'Progress', type: 'rich_text', rich_text: {} },
  }
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: { ...fullSchema, properties } }), 'db-1')

  const sent: Record<string, unknown>[] = []
  const client = {
    pages: {
      create: async (a: { properties: Record<string, unknown> }) => {
        sent.push(a.properties)
        return { id: 'p1' }
      },
      update: async () => ({ id: 'p1' }),
    },
    blocks: {
      children: { list: async () => ({ results: [], has_more: false }), append: async () => ({}) },
      delete: async () => ({}),
    },
    dataSources: { query: async () => ({ results: [], has_more: false }) },
  } as unknown as Client

  const writer = createNotionWriter(
    client,
    schema,
    { key: 'GitLab ID', name: 'Feature', progress: 'Progress' },
    { run: <T>(request: () => Promise<T>) => request() },
  )
  const result = await writer.write([row({ progress: { done: 12, total: 30, ratio: 0.4 } })])

  // The row was written — the run happened.
  assert.equal(result.created, 1)
  assert.equal(result.failures.length, 0)
  // Without the column that cannot hold it.
  assert.equal('Progress' in sent[0]!, false)
  assert.ok('GitLab ID' in sent[0]! && 'Feature' in sent[0]!)
  // And the report is told, so nobody reads the empty column as a statement.
  assert.deepEqual(result.unusable.map((u) => u.role), ['progress'])
})

test('EC6 a column of a type the role CAN take is written normally', async () => {
  // The counter-check: `key` takes rich_text and url, so a url key column is
  // not "wrong type" — it is the shape key_is = "url" asks for.
  const properties = {
    ...fullSchema.properties,
    'GitLab ID': { id: 'a', name: 'GitLab ID', type: 'url', url: {} },
  }
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: { ...fullSchema, properties } }), 'db-1')

  assert.deepEqual(unusableRoles(schema, { key: 'GitLab ID', name: 'Feature' }), [])
})

test('AK50 the select options are read so the pre-check can compare before writing', async () => {
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: fullSchema }), 'db-1')

  assert.deepEqual(schema.options.get('Status'), ['Backlog', 'In progress', 'Released'])
  assert.deepEqual(schema.options.get('Level'), ['Bundle', 'Item'])
  // A column that is not a select carries no options.
  assert.equal(schema.options.has('Progress'), false)
})

test('a status column offers its options like a select does', async () => {
  const properties = {
    ...fullSchema.properties,
    Status: {
      id: 'c',
      name: 'Status',
      type: 'status',
      status: { options: [{ name: 'Not started' }, { name: 'Done' }] },
    },
  }
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: { ...fullSchema, properties } }), 'db-1')
  assert.deepEqual(schema.options.get('Status'), ['Not started', 'Done'])
})

test('AK54a a partial database response is reported as a permission problem', async () => {
  // The partial form carries only object and id — reaching for data_sources
  // without checking would break at runtime.
  await assert.rejects(
    () => readSchema(clientOf({ database: { object: 'database', id: 'db-1' } }), 'db-1'),
    (e: unknown) => {
      assert.ok(e instanceof TargetUnreadable)
      assert.match(e.message, /permission problem/)
      assert.match(e.message, /Connections/)
      assert.ok(!/no data source found/i.test(e.message), 'must not send the user looking for the wrong thing')
      return true
    },
  )
})

test('AK54 one data source is used without asking', async () => {
  const schema = await readSchema(clientOf({ database: oneSource, dataSource: fullSchema }), 'db-1')
  assert.equal(schema.dataSourceId, 'ds-1')
})

test('AK54 several data sources abort the run and are named', async () => {
  const many = {
    object: 'database',
    id: 'db-1',
    data_sources: [
      { id: 'ds-1', name: 'Roadmap' },
      { id: 'ds-2', name: 'Archive' },
    ],
  }
  await assert.rejects(
    () => readSchema(clientOf({ database: many, dataSource: fullSchema }), 'db-1'),
    (e: unknown) => {
      assert.ok(e instanceof TargetUnreadable)
      assert.match(e.message, /more than one data source/)
      assert.match(e.message, /Roadmap \(ds-1\)/)
      assert.match(e.message, /Archive \(ds-2\)/)
      return true
    },
  )
})

test('a database without any data source is reported plainly', async () => {
  await assert.rejects(
    () => readSchema(clientOf({ database: { object: 'database', id: 'db-1', data_sources: [] } }), 'db-1'),
    TargetUnreadable,
  )
})

// --- Stage3-2: the pre-check before the first write ----------------------

import { precheckTarget, precheckKeyForm, TargetMismatch } from '../src/output/notion/precheck.js'
import type { CoreConfig } from '../src/core/types.js'

const byLabel: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([
    ['Flow::Doing', 'In progress'],
    ['Flow::Blocked', 'Blocked'],
  ]),
  active: ['In progress'],
  blocked: ['Blocked'],
  closed: 'Released',
  default: 'Backlog',
}

const COLUMNS = { key: 'GitLab ID', name: 'Feature', state: 'Status', type: 'Level', health: 'Health' }
const COLUMNS_WITHOUT_HEALTH = { key: 'GitLab ID', name: 'Feature', state: 'Status', type: 'Level' }

function schemaWith(options: Record<string, string[]>, types: Record<string, string> = {}) {
  return {
    dataSourceId: 'ds-1',
    types: new Map<string, string>([
      ...Object.keys(options).map((name) => [name, 'select'] as [string, string],),
      ...Object.entries(types),
    ]),
    options: new Map<string, readonly string[]>(Object.entries(options)),
  }
}

test('AK50 a state column that offers every value passes', () => {
  const schema = schemaWith({ Status: ['In progress', 'Blocked', 'Released', 'Backlog'] })
  precheckTarget(schema, byLabel, { state: 'Status' })
})

test('AK34 under "label" a missing state value aborts before the first write', () => {
  const schema = schemaWith({ Status: ['In Progress', 'Blocked', 'Released', 'Backlog'] })
  assert.throws(
    () => precheckTarget(schema, byLabel, { state: 'Status' }),
    (e: unknown) => {
      assert.ok(e instanceof TargetMismatch)
      // Names what is missing AND what the column offers (AK35).
      assert.match(e.message, /does not offer: "In progress"/)
      assert.match(e.message, /It offers: .*"In Progress"/)
      return true
    },
  )
})

test('AK34 under "status" it is checked against the status names the source delivers', () => {
  const byStatus: CoreConfig = { ...byLabel, stageSource: 'status', active: [], blocked: ['Blocked'] }
  const schema = schemaWith({ Lifecycle: ['In progress', 'Released', 'Backlog'] })

  assert.throws(
    () => precheckTarget(schema, byStatus, { state: 'Lifecycle' }, ['In review', 'To do', 'In progress']),
    (e: unknown) => {
      assert.ok(e instanceof TargetMismatch)
      assert.match(e.message, /does not offer: "In review", "To do"/)
      assert.match(e.message, /GitLab statuses found: In review, To do, In progress/)
      assert.match(e.message, /switch to stage_source = "label"/)
      return true
    },
  )
})

test('AK50 a type column offering Epic/Issue instead of Bundle/Item aborts', () => {
  const schema = schemaWith({ Status: ['In progress', 'Blocked', 'Released', 'Backlog'], Level: ['Epic', 'Issue'] })
  assert.throws(
    () => precheckTarget(schema, byLabel, COLUMNS_WITHOUT_HEALTH),
    (e: unknown) => {
      assert.ok(e instanceof TargetMismatch)
      assert.match(e.message, /"Level".*does not offer: "Bundle", "Item"/s)
      assert.match(e.message, /It offers: "Epic", "Issue"/)
      return true
    },
  )
})

test('the health column is checked against the three core values', () => {
  const schema = schemaWith({
    Status: ['In progress', 'Blocked', 'Released', 'Backlog'],
    Level: ['Bundle', 'Item'],
    Health: ['ok', 'risk'],
  })
  assert.throws(
    () => precheckTarget(schema, byLabel, COLUMNS),
    (e: unknown) => {
      assert.ok(e instanceof TargetMismatch)
      assert.match(e.message, /"Health".*does not offer: "attention"/s)
      assert.match(e.message, /drop health from \[columns\]/)
      return true
    },
  )
})

test('a column the config does not map is not checked', () => {
  const schema = schemaWith({ Status: ['In progress', 'Blocked', 'Released', 'Backlog'] })
  // No type and no health column configured — nothing to complain about.
  precheckTarget(schema, byLabel, { state: 'Status' })
})

test('a state column that is not a select is left to the schema check, not this one', () => {
  const schema = {
    dataSourceId: 'ds-1',
    types: new Map([['Status', 'rich_text']]),
    options: new Map<string, readonly string[]>(),
  }
  precheckTarget(schema, byLabel, { state: 'Status' })
})

test('R29 existing rows in the other key form abort with both ways out', () => {
  assert.throws(
    () => precheckKeyForm(['https://gitlab.example.invalid/groups/acme/-/epics/7'], byLabel),
    (e: unknown) => {
      assert.ok(e instanceof TargetMismatch)
      assert.match(e.message, /key_is = "id"/)
      assert.match(e.message, /second\s*\n?row beside every existing one/)
      assert.match(e.message, /set key_is back, or clear the key column/)
      return true
    },
  )
})

test('R29 the same check the other way round, for key_is = url', () => {
  assert.throws(() => precheckKeyForm(['acme/product&7'], { ...byLabel, keyIs: 'url' }), TargetMismatch)
})

test('R29 rows in the configured form pass, and an empty target has nothing to contradict', () => {
  precheckKeyForm(['acme/product&7', 'acme/product/app#42'], byLabel)
  precheckKeyForm([], byLabel)
  precheckKeyForm(['https://gitlab.example.invalid/groups/acme/-/epics/7'], { ...byLabel, keyIs: 'url' })
})

// --- Stage3-3: the upsert -----------------------------------------------

import { createNotionWriter, unusableRoles } from '../src/output/notion/write.js'
import { createRetrier } from '../src/output/notion/throttle.js'
import type { Row } from '../src/core/types.js'

type Call = { kind: 'create' | 'update'; id?: string; properties: Record<string, any> }

/** A stub that records what the writer sends and answers queries from a
 *  table of key -> page ids. It REJECTS a property addressed by id, the way
 *  Notion does (R17). */
function writerStub(existing: Record<string, string[]> = {}, blocks: string[] = []) {
  const calls: Call[] = []
  const queried: string[] = []
  const knownColumns = new Set<string>()
  const deleted: string[] = []
  const appended: unknown[][] = []

  const client = {
    pages: {
      create: async (args: any) => {
        reject(args.properties)
        calls.push({ kind: 'create', properties: args.properties })
        return { id: 'new-page' }
      },
      update: async (args: any) => {
        reject(args.properties)
        calls.push({ kind: 'update', id: args.page_id, properties: args.properties })
        return { id: args.page_id }
      },
    },
    dataSources: {
      query: async (args: any) => {
        queried.push(args.filter === undefined ? 'all' : 'byKey')
        const key = args.filter?.rich_text?.equals ?? args.filter?.url?.equals
        if (key !== undefined) return { results: (existing[key] ?? []).map((id) => ({ id })) }

        // The unfiltered read-ahead: every row of the target, in Notion's own
        // shape (the key sits in a property, not beside the id), one page at
        // a time.
        const all = Object.entries(existing).flatMap(([value, ids]) =>
          ids.map((id) => ({ id, properties: { 'GitLab ID': { rich_text: [{ plain_text: value }] } } })),
        )
        const from = args.start_cursor === undefined ? 0 : Number(args.start_cursor)
        const page = all.slice(from, from + (args.page_size ?? 100))
        const next = from + page.length
        return { results: page, has_more: next < all.length, next_cursor: next < all.length ? String(next) : null }
      },
    },
    blocks: {
      children: {
        list: async () => ({ results: blocks.map((id) => ({ id })) }),
        append: async (args: any) => {
          appended.push(args.children)
          return { results: [] }
        },
      },
      delete: async (args: any) => {
        deleted.push(args.block_id)
        return { id: args.block_id }
      },
    },
  } as unknown as Client

  /** Notion rejects a property addressed by its id although the same id is
   *  handed over when reading the schema (measured). */
  function reject(properties: Record<string, unknown>) {
    for (const name of Object.keys(properties)) {
      if (!knownColumns.has(name)) throw new Error(`Property "${name}" not found in the data source.`)
    }
  }

  return { client, calls, queried, knownColumns, deleted, appended }
}

const WRITE_SCHEMA = {
  dataSourceId: 'ds-1',
  types: new Map<string, string>([
    ['GitLab ID', 'rich_text'],
    ['Feature', 'title'],
    ['Status', 'select'],
    ['Progress', 'number'],
    ['GitLab URL', 'url'],
    ['Due', 'date'],
    ['Level', 'select'],
    ['Last activity', 'date'],
    ['Health', 'select'],
  ]),
  options: new Map<string, readonly string[]>(),
}

const WRITE_COLUMNS = {
  key: 'GitLab ID',
  name: 'Feature',
  state: 'Status',
  progress: 'Progress',
  url: 'GitLab URL',
  due: 'Due',
  type: 'Level',
  activity: 'Last activity',
  health: 'Health',
}

function row(over: Partial<Row> = {}): Row {
  return {
    level: 'bundle',
    key: 'acme/product&7',
    number: 7,
    name: 'The bundle',
    state: 'In progress',
    closed: false,
    progress: { done: 12, total: 30, ratio: 0.4 },
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
    due: new Date('2026-10-15T00:00:00Z'),
    activity: new Date('2026-08-24T00:00:00Z'),
    health: null,
    description: '',
    items: [],
    ...over,
  }
}

function writerOn(stub: ReturnType<typeof writerStub>, columns = WRITE_COLUMNS) {
  for (const name of Object.values(columns)) stub.knownColumns.add(name)
  return createNotionWriter(stub.client, WRITE_SCHEMA, columns)
}

test('AK18 a second run against the same data creates no second row', async () => {
  const first = writerStub()
  const created = await writerOn(first).write([row()])
  assert.equal(created.created, 1)
  assert.equal(created.updated, 0)

  const second = writerStub({ 'acme/product&7': ['page-1'] })
  const updated = await writerOn(second).write([row()])
  assert.equal(updated.created, 0)
  assert.equal(updated.updated, 1)
  assert.equal(second.calls[0]!.id, 'page-1')
})

test('AK32 the writer addresses columns by NAME — the stub rejects an id', async () => {
  const stub = writerStub()
  // Only the configured NAMES are known to the stub. If the writer sent a
  // property id instead, this write would be rejected the way Notion does.
  const result = await writerOn(stub).write([row()])

  assert.deepEqual(result.failures, [])
  assert.ok(Object.keys(stub.calls[0]!.properties).includes('Status'))
})

test('AK33 a date goes out under the date key, never as a bare string', async () => {
  const stub = writerStub()
  await writerOn(stub).write([row()])
  const properties = stub.calls[0]!.properties

  assert.deepEqual(properties['Due'], { date: { start: '2026-10-15' } })
  assert.deepEqual(properties['Last activity'], { date: { start: '2026-08-24' } })
  assert.notEqual(typeof properties['Due'], 'string')
})

test('EC6a progress is written as the FRACTION, not the whole number', async () => {
  const stub = writerStub()
  await writerOn(stub).write([row()])
  // 12/30 -> 0.4, which renders as 40 %. Sending 40 would render as 4000 %,
  // and the API accepts both without complaint.
  assert.deepEqual(stub.calls[0]!.properties['Progress'], { number: 0.4 })
})

test('progress null leaves the column empty, never 0', async () => {
  const stub = writerStub()
  await writerOn(stub).write([row({ progress: null })])
  assert.deepEqual(stub.calls[0]!.properties['Progress'], { number: null })
})

test('EC8 a bundle without a date sends no date, and the column is not dropped', async () => {
  const stub = writerStub()
  await writerOn(stub).write([row({ due: null })])
  assert.deepEqual(stub.calls[0]!.properties['Due'], { date: null })
})

test('R16 only columns the target carries are sent', async () => {
  const stub = writerStub()
  // health is configured but absent from the schema — it must fall out.
  const columns = { ...WRITE_COLUMNS, health: 'Nowhere' }
  for (const name of Object.values(columns)) stub.knownColumns.add(name)
  stub.knownColumns.delete('Nowhere')

  const result = await createNotionWriter(stub.client, WRITE_SCHEMA, columns).write([row()])

  assert.deepEqual(result.failures, [])
  assert.equal(Object.keys(stub.calls[0]!.properties).includes('Nowhere'), false)
})

test('the level goes out as Bundle or Item', async () => {
  const stub = writerStub()
  await writerOn(stub).write([row(), row({ level: 'item', key: 'acme/product/app#42', progress: null })])

  assert.deepEqual(stub.calls[0]!.properties['Level'], { select: { name: 'Bundle' } })
  assert.deepEqual(stub.calls[1]!.properties['Level'], { select: { name: 'Item' } })
})

test('EC4 two rows with the same key update the FIRST and report the duplicate', async () => {
  const stub = writerStub({ 'acme/product&7': ['page-1', 'page-2'] })
  const result = await writerOn(stub).write([row()])

  assert.deepEqual(result.duplicates, ['acme/product&7'])
  assert.equal(result.updated, 1)
  assert.equal(stub.calls[0]!.id, 'page-1')
  // Nothing is deleted, ever (R21).
  assert.equal(stub.calls.length, 1)
})

test('R21 a row that fails is reported, and the run carries on', async () => {
  const stub = writerStub()
  // 'Status' stays unknown to the stub, so every write is rejected.
  const columns = { ...WRITE_COLUMNS }
  for (const name of Object.values(columns)) stub.knownColumns.add(name)
  stub.knownColumns.delete('Status')

  const result = await createNotionWriter(stub.client, WRITE_SCHEMA, columns).write([row(), row({ key: 'acme/product&8' })])

  assert.equal(result.failures.length, 2)
  assert.match(result.failures[0]!.reason, /Property "Status" not found/)
  assert.equal(result.created, 0)
})

test('the key column is written in the shape its schema type names', async () => {
  const urlSchema = { ...WRITE_SCHEMA, types: new Map(WRITE_SCHEMA.types).set('GitLab ID', 'url') }
  const stub = writerStub()
  for (const name of Object.values(WRITE_COLUMNS)) stub.knownColumns.add(name)

  await createNotionWriter(stub.client, urlSchema, WRITE_COLUMNS).write([
    row({ key: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7' }),
  ])

  assert.deepEqual(stub.calls[0]!.properties['GitLab ID'], {
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
  })
})

test('a page is created under the data source, not the database', async () => {
  const stub = writerStub()
  const client = stub.client as any
  let parent: unknown
  client.pages.create = async (args: any) => {
    parent = args.parent
    return { id: 'new-page' }
  }
  for (const name of Object.values(WRITE_COLUMNS)) stub.knownColumns.add(name)

  await createNotionWriter(stub.client, WRITE_SCHEMA, WRITE_COLUMNS).write([row()])
  assert.deepEqual(parent, { type: 'data_source_id', data_source_id: 'ds-1' })
})

test('R19 the body is replaced on a second run, never appended', async () => {
  const stub = writerStub({ 'acme/product&7': ['page-1'] }, ['old-block-1', 'old-block-2'])
  await writerOn(stub).write([row()])

  // Every existing block goes, then the new body is written once.
  assert.deepEqual(stub.deleted, ['old-block-1', 'old-block-2'])
  assert.equal(stub.appended.length, 1)
  assert.ok(stub.appended[0]!.length > 0)
})

test('R19 a new page carries its body straight away, with nothing to replace', async () => {
  const stub = writerStub()
  const client = stub.client as any
  let children: unknown
  client.pages.create = async (args: any) => {
    children = args.children
    return { id: 'new-page' }
  }
  for (const name of Object.values(WRITE_COLUMNS)) stub.knownColumns.add(name)

  await createNotionWriter(stub.client, WRITE_SCHEMA, WRITE_COLUMNS).write([row()])

  assert.ok(Array.isArray(children) && children.length > 0)
  assert.deepEqual(stub.deleted, [])
})

test('AK38 a row Notion keeps refusing is skipped and named, and the rest are written', async () => {
  const stub = writerStub()
  for (const name of Object.values(WRITE_COLUMNS)) stub.knownColumns.add(name)

  const client = stub.client as any
  const create = client.pages.create
  client.pages.create = async (args: any) => {
    // Only the first row is refused, always.
    const key = args.properties['GitLab ID']?.rich_text?.[0]?.text?.content
    if (key === 'acme/product&7') {
      const error = new Error('429') as Error & { status: number; headers: Record<string, string> }
      error.status = 429
      error.headers = {}
      throw error
    }
    return create(args)
  }

  const waited: number[] = []
  const retrier = createRetrier(async (ms) => void waited.push(ms), () => 0.5)
  // The retry waits are the growing ones; anything at or below the minimum
  // gap between requests is pacing, not backoff.
  const backoffs = () => waited.filter((ms) => ms > 334)
  const writer = createNotionWriter(stub.client, WRITE_SCHEMA, WRITE_COLUMNS, retrier)

  const result = await writer.write([row(), row({ key: 'acme/product&8', name: 'Another bundle' })])

  // The refused row is named, not silently dropped.
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]!.key, 'acme/product&7')
  assert.match(result.failures[0]!.reason, /too fast/)
  // The run carries on and writes the rest — no abort (section 12, exit 0).
  assert.equal(result.created, 1)
  assert.equal(backoffs().length, 5, 'five backoff waits before giving up')
})

test('R20a a page body of more than 100 blocks is fully replaced, not partly', async () => {
  // Notion lists at most 100 blocks per call. A body of 3 + one bullet per
  // item passes 100 at roughly 97 items, which a rolled-up epic reaches —
  // and stopping at the first page would leave the rest standing, against
  // ADR-0009.
  const stub = writerStub({ 'acme/product&7': ['page-1'] })
  for (const name of Object.values(WRITE_COLUMNS)) stub.knownColumns.add(name)

  const client = stub.client as any
  const old = Array.from({ length: 250 }, (_, i) => ({ id: `old-${i}` }))
  let listed = 0
  client.blocks.children.list = async (args: any) => {
    const at = args.start_cursor === undefined ? 0 : Number(args.start_cursor)
    listed += 1
    const slice = old.slice(at, at + 100)
    const next = at + 100
    return { results: slice, has_more: next < old.length, next_cursor: next < old.length ? String(next) : null }
  }
  const deleted: string[] = []
  client.blocks.delete = async (args: any) => {
    deleted.push(args.block_id)
    return {}
  }

  // Pass-through retrier: this case is about replacing 250 blocks, not about
  // pacing. With the real one each delete waits 333 ms, and this single test
  // costs 85 of the suite's 103 seconds — for a property it does not test.
  await createNotionWriter(stub.client, WRITE_SCHEMA, WRITE_COLUMNS, {
    run: <T>(request: () => Promise<T>) => request(),
  }).write([row()])

  assert.equal(listed, 3, 'the listing was followed to its end')
  assert.equal(deleted.length, 250, 'every old block was removed')
})

test('R20a a body longer than 100 blocks is appended in batches', async () => {
  const stub = writerStub({ 'acme/product&7': ['page-1'] })
  for (const name of Object.values(WRITE_COLUMNS)) stub.knownColumns.add(name)

  const client = stub.client as any
  client.blocks.children.list = async () => ({ results: [], has_more: false, next_cursor: null })
  const batches: number[] = []
  client.blocks.children.append = async (args: any) => {
    batches.push(args.children.length)
    return { results: [] }
  }

  const items = Array.from({ length: 120 }, (_, i) =>
    row({ level: 'item', key: `acme/product/app#${i}`, number: i, progress: null, items: [] }),
  )
  await createNotionWriter(stub.client, WRITE_SCHEMA, WRITE_COLUMNS).write([row({ items })])

  // 120 bullets plus the fixed blocks of section 7 — split so that no call
  // carries more than Notion's 100.
  assert.equal(batches.length, 2)
  assert.equal(batches[0], 100)
  assert.ok(batches[1]! <= 100, `second batch was ${batches[1]}`)
  assert.equal(batches[0]! + batches[1]!, 124)
})

test('a small target is read ahead: one query for the whole run, not one per row', async () => {
  // Four rows against a target of four — reading ahead costs one query, the
  // per-row path would cost four.
  const stub = writerStub({
    'acme/product&1': ['p1'],
    'acme/product&2': ['p2'],
    'acme/product&3': ['p3'],
    'acme/product&4': ['p4'],
  })
  const rows = [1, 2, 3, 4].map((n) => row({ key: `acme/product&${n}` }))
  const result = await writerOn(stub).write(rows)

  assert.deepEqual(stub.queried, ['all'])
  assert.equal(result.updated, 4)
})

test('a big target is looked up per row: reading it ahead would cost more', async () => {
  // 250 rows in the target (three pages) against a single row to write. R21
  // never deletes and include_closed keeps finished bundles out, so this is
  // what an old board looks like — reading ahead must NOT win here.
  const existing: Record<string, string[]> = {}
  for (let n = 0; n < 250; n += 1) existing[`acme/product&${n}`] = [`p${n}`]

  const stub = writerStub(existing)
  const result = await writerOn(stub).write([row({ key: 'acme/product&7' })])

  // It starts reading ahead — that first page is what reveals the size —
  // then falls back rather than paging on.
  assert.equal(stub.queried.at(-1), 'byKey')
  assert.equal(result.updated, 1)
})

test('read ahead sees BOTH pages of a hand-made duplicate (EC4)', async () => {
  const stub = writerStub({ 'acme/product&7': ['page-1', 'page-2'] })
  const result = await writerOn(stub).write([row()])

  assert.deepEqual(stub.queried, ['all'])
  assert.deepEqual(result.duplicates, ['acme/product&7'])
  assert.equal(stub.calls[0]!.id, 'page-1')
  // Nothing is deleted, ever (R21).
  assert.equal(stub.calls.length, 1)
})

/**
 * AK16 / AK33 — the shape a date goes out in.
 *
 * Under the COLUMN NAME, carrying `{ date: { start } }`. Not under a
 * composite key `date:<field>:start`: that is how Notion ANSWERS, and an
 * earlier reading of R17a mistook the read form for a write form. The
 * installed SDK settles it — the write type is
 * `Record<columnName, { date: { start } } | …>` and has no composite key.
 *
 * Ungetested until now, which is how the misreading survived six review
 * rounds: the spec said one thing, the code did another, and nothing
 * compared them.
 */
test('AK16 a date goes out under the column name, as date.start', async () => {
  const stub = writerStub()
  await writerOn(stub).write([row({ due: new Date('2026-10-15T00:00:00Z') })])

  const properties = stub.calls[0]!.properties
  assert.deepEqual(properties['Due'], { date: { start: '2026-10-15' } })
  // No composite key anywhere in what was sent.
  assert.equal(
    Object.keys(properties).some((k) => k.includes(':')),
    false,
    `no property key may be composite: ${Object.keys(properties).join(', ')}`,
  )
})

test('AK16 the calendar day only — no time, no zone', async () => {
  // A date is a day on a roadmap. Sending an instant would make the cell
  // depend on the reader's timezone.
  const stub = writerStub()
  await writerOn(stub).write([row({ due: new Date('2026-10-15T22:30:00Z') })])

  assert.deepEqual(stub.calls[0]!.properties['Due'], { date: { start: '2026-10-15' } })
})

test('AK16 a bundle without a date sends null, never a guessed one', async () => {
  // EC8/ADR-0006: the column is emptied, never filled from the config.
  const stub = writerStub()
  await writerOn(stub).write([row({ due: null })])

  assert.deepEqual(stub.calls[0]!.properties['Due'], { date: null })
})
