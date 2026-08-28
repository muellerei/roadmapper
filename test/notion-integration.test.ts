import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@notionhq/client'
import { createNotionTarget } from '../src/output/notion/target.js'
import { rowsOf } from '../src/core/rows.js'
import type { Bundle, CoreConfig, Item, SourceResult, Stage } from '../src/core/types.js'

/**
 * The group integration gate for stage 3. Each piece passed its own stub
 * tests; this proves they form ONE writer — that the order holds (schema,
 * then check, then write) and that a bundle from the core survives the whole
 * path into stub calls.
 */

const cfg: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([['Flow::Doing', 'In progress']]),
  active: ['In progress'],
  blocked: [],
  closed: 'Released',
  default: 'Backlog',
}

const COLUMNS = {
  key: 'GitLab ID',
  name: 'Feature',
  state: 'Status',
  progress: 'Progress',
  url: 'GitLab URL',
  type: 'Level',
}

const PROPERTIES = {
  'GitLab ID': { id: 'a', name: 'GitLab ID', type: 'rich_text', rich_text: {} },
  Feature: { id: 'b', name: 'Feature', type: 'title', title: {} },
  Status: {
    id: 'c',
    name: 'Status',
    type: 'select',
    select: { options: [{ name: 'In progress' }, { name: 'Released' }, { name: 'Backlog' }] },
  },
  Progress: { id: 'd', name: 'Progress', type: 'number', number: { format: 'percent' } },
  'GitLab URL': { id: 'e', name: 'GitLab URL', type: 'url', url: {} },
  Level: { id: 'f', name: 'Level', type: 'select', select: { options: [{ name: 'Bundle' }, { name: 'Item' }] } },
}

/** Records every call in order, so the gate can assert the sequence. */
function stub(properties: Record<string, unknown> = PROPERTIES) {
  const log: string[] = []
  const written: string[] = []

  const client = {
    databases: {
      retrieve: async () => {
        log.push('databases.retrieve')
        return { object: 'database', id: 'db-1', data_sources: [{ id: 'ds-1', name: 'Roadmap' }] }
      },
    },
    dataSources: {
      retrieve: async () => {
        log.push('dataSources.retrieve')
        return { object: 'data_source', id: 'ds-1', properties }
      },
      query: async () => {
        log.push('dataSources.query')
        return { results: [] }
      },
    },
    pages: {
      create: async (args: any) => {
        log.push('pages.create')
        written.push(args.properties['GitLab ID'].rich_text[0].text.content)
        return { id: 'page-new' }
      },
      update: async () => {
        log.push('pages.update')
        return { id: 'page-1' }
      },
    },
    blocks: {
      children: {
        list: async () => {
          log.push('blocks.children.list')
          return { results: [] }
        },
        append: async () => {
          log.push('blocks.children.append')
          return { results: [] }
        },
      },
      delete: async () => {
        log.push('blocks.delete')
        return {}
      },
    },
  } as unknown as Client

  return { client, log, written }
}

function stage(over: Partial<Stage> = {}): Stage {
  return { category: null, categoryName: null, label: null, ...over }
}

function item(key: string, closed: boolean): Item {
  return {
    key,
    number: Number(key.split('#')[1]),
    title: `Issue ${key}`,
    description: '',
    closed,
    stage: stage({ label: 'Flow::Doing' }),
    url: `https://gitlab.example.invalid/acme/product/app/-/issues/${key.split('#')[1]}`,
    bundle: 'acme/product&7',
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    health: null,
  }
}

/** One bundle with two items and a child bundle — the shape the gate asks
 *  for, built through the core so the rows are the real thing. */
function theRows() {
  const child: Bundle = {
    key: 'acme/product&8',
    number: 8,
    name: 'A sub-epic',
    description: '',
    closed: false,
    due: null,
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/8',
    progress: { done: 0, total: 1, ratio: 0 },
    lastActivity: new Date('2026-08-02T00:00:00Z'),
    health: null,
    items: [item('acme/product/app#43', false)],
    children: [],
  }

  const bundle: Bundle = {
    key: 'acme/product&7',
    number: 7,
    name: 'The bundle',
    description: 'What this is about.',
    closed: false,
    due: new Date('2026-09-30T00:00:00Z'),
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
    progress: { done: 1, total: 3, ratio: 1 / 3 },
    lastActivity: new Date('2026-08-05T00:00:00Z'),
    health: null,
    items: [item('acme/product/app#41', true), item('acme/product/app#42', false)],
    children: [child],
  }

  const result: SourceResult = { bundles: [bundle], prefixes: ['Workflow'], truncated: [] }
  return rowsOf(result, cfg)
}

const noWait = async () => {}

test('the schema is read first, the pre-check runs, then rows are written', async () => {
  const target = stub()
  const result = await createNotionTarget(target.client, COLUMNS, noWait).write('db-1', theRows(), cfg)

  // The two schema calls come before anything else — the pre-check needs the
  // schema, and both come before the first write.
  assert.equal(target.log[0], 'databases.retrieve')
  assert.equal(target.log[1], 'dataSources.retrieve')
  assert.ok(target.log.indexOf('pages.create') > 1)

  // The schema is read ONCE, not per row.
  assert.equal(target.log.filter((c) => c === 'databases.retrieve').length, 1)
  assert.equal(target.log.filter((c) => c === 'dataSources.retrieve').length, 1)

  assert.equal(result.created, 5)
  assert.deepEqual(result.failures, [])
})

test('a bundle is written before its own items', async () => {
  const target = stub()
  await createNotionTarget(target.client, COLUMNS, noWait).write('db-1', theRows(), cfg)

  assert.deepEqual(target.written, [
    'acme/product&7',
    'acme/product/app#41',
    'acme/product/app#42',
    'acme/product&8',
    'acme/product/app#43',
  ])
})

test('nothing is ever deleted', async () => {
  const target = stub()
  await createNotionTarget(target.client, COLUMNS, noWait).write('db-1', theRows(), cfg)
  assert.equal(target.log.includes('blocks.delete'), false)
})

test('EC5 without a type column only bundles are written, and it follows from the SCHEMA', async () => {
  const properties = { ...PROPERTIES } as Record<string, unknown>
  delete properties['Level']

  const target = stub(properties)
  // The config still names the column — the schema is what decides.
  const result = await createNotionTarget(target.client, COLUMNS, noWait).write('db-1', theRows(), cfg)

  assert.deepEqual(target.written, ['acme/product&7', 'acme/product&8'])
  assert.equal(result.skippedItems, 3)
})

test('a 429 on one row is retried inside the same chain, and the rest still get written', async () => {
  const target = stub()
  const client = target.client as any
  const create = client.pages.create
  let refused = 0
  client.pages.create = async (args: any) => {
    const key = args.properties['GitLab ID'].rich_text[0].text.content
    if (key === 'acme/product/app#42' && refused === 0) {
      refused += 1
      const error = new Error('429') as Error & { status: number; headers: Record<string, string> }
      error.status = 429
      error.headers = { 'retry-after': '1' }
      throw error
    }
    return create(args)
  }

  const waited: number[] = []
  const result = await createNotionTarget(target.client, COLUMNS, async (ms) => void waited.push(ms), () => 0.5).write(
    'db-1',
    theRows(),
    cfg,
  )

  // One RETRY wait of a second, as Retry-After named. The shorter waits are
  // the minimum gap between requests, which is pacing rather than backoff.
  assert.deepEqual(waited.filter((ms) => ms > 334), [1000])
  assert.deepEqual(result.failures, [])
  assert.equal(result.created, 5)
  assert.equal(target.written.length, 5)
})

test('a target whose state column lacks a value aborts before the first write', async () => {
  const properties = {
    ...PROPERTIES,
    Status: { id: 'c', name: 'Status', type: 'select', select: { options: [{ name: 'Backlog' }] } },
  }
  const target = stub(properties)

  await assert.rejects(
    () => createNotionTarget(target.client, COLUMNS, noWait).write('db-1', theRows(), cfg),
    /does not offer/,
  )
  // Nothing was written — that is the whole point of the pre-check.
  assert.equal(target.log.includes('pages.create'), false)
})

test('R29 a key_is changed after the fact aborts before the first write', async () => {
  // The check existed and was tested, but nothing called it — so a changed
  // key_is silently added a second row beside every existing one, which is
  // exactly what it was written to prevent.
  const notion = stub()
  const client = notion.client as any
  client.dataSources.query = async () => ({
    results: [
      {
        id: 'page-1',
        // The rows were written with key_is = "url"; the config now says "id".
        properties: { 'GitLab ID': { url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7' } },
      },
    ],
  })

  await assert.rejects(
    () => createNotionTarget(notion.client, COLUMNS, noWait).write('db-1', theRows(), cfg),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /key_is was changed after these rows were written/)
      assert.match(e.message, /clear the key column/)
      return true
    },
  )

  assert.deepEqual(notion.written, [], 'nothing was written')
})

test('R29 rows in the configured key form pass the check', async () => {
  const notion = stub()
  const client = notion.client as any
  client.dataSources.query = async () => ({
    results: [{ id: 'page-1', properties: { 'GitLab ID': { rich_text: [{ plain_text: 'acme/product&7' }] } } }],
  })

  const exitCode = await createNotionTarget(notion.client, COLUMNS, noWait).write('db-1', theRows(), cfg)
  assert.equal(exitCode.failures.length, 0)
})

test('an empty target has nothing to contradict', async () => {
  const notion = stub()
  const result = await createNotionTarget(notion.client, COLUMNS, noWait).write('db-1', theRows(), cfg)

  // The query returns no rows, so the key-form check has nothing to compare
  // and the run proceeds normally.
  assert.equal(result.failures.length, 0)
  assert.ok(result.created > 0)
})

test('progress is written as whole percent, never with trailing digits', async () => {
  const notion = stub()
  const client = notion.client as any
  const numbers: unknown[] = []
  client.pages.create = async (args: any) => {
    numbers.push(args.properties['Progress']?.number)
    return { id: 'page-new' }
  }

  await createNotionTarget(notion.client, COLUMNS, noWait).write('db-1', theRows(), cfg)

  // 1 of 3 is 0.333… — the cell must carry 0.33, which Notion renders as
  // 33 %, not 33.33333333333333 %. The exact counts stay in the page body.
  assert.ok(numbers.includes(0.33))
  assert.ok(!numbers.some((n) => typeof n === 'number' && n * 100 !== Math.round(n * 100)))
})
