import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressOf } from '../src/core/progress.js'
import { stateOf } from '../src/core/state.js'
import { healthOf } from '../src/core/health.js'
import { lastActivityOf } from '../src/core/activity.js'
import { bundleKeyOf } from '../src/core/key.js'
import { rowsOf } from '../src/core/rows.js'
import type { Bundle, CoreConfig, HealthCount, Item, SourceResult } from '../src/core/types.js'

/**
 * The group integration gate for the core. Every module above passed its own
 * unit tests against input it invented for itself; nothing so far built ONE
 * bundle and carried it through all six.
 *
 * The question here is not "does stateOf work" but "does a bundle survive
 * the whole core" — including the recursion into a child, which no unit test
 * exercises together with the key, the health rollup and the dates.
 */

const cfg: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([
    ['Flow::Doing', 'In progress'],
    ['Flow::Blocked', 'Blocked'],
  ]),
  active: ['In progress'],
  blocked: ['Blocked'],
  closed: 'Done',
  default: 'Backlog',
}

/** The one bundle every assertion below runs against: two own items (one
 *  closed, one active), one child bundle carrying its own item, a due date,
 *  and dates spread so the NEWEST sits in the child. */
function theBundle(): Bundle {
  const closedItem: Item = {
    key: 'acme/product/app#41',
    number: 41,
    title: 'Something finished',
    description: 'Done last month.',
    closed: true,
    stage: { category: null, categoryName: null, label: 'Flow::Doing' },
    url: 'https://gitlab.example.invalid/acme/product/app/-/issues/41',
    bundle: 'acme/product&7',
    updatedAt: new Date('2026-07-10T00:00:00Z'),
    health: 'ok',
  }

  const activeItem: Item = {
    key: 'acme/product/app#42',
    number: 42,
    title: 'Something running',
    description: '',
    closed: false,
    stage: { category: null, categoryName: null, label: 'Flow::Doing' },
    url: 'https://gitlab.example.invalid/acme/product/app/-/issues/42',
    bundle: 'acme/product&7',
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    health: null,
  }

  const childItem: Item = {
    key: 'acme/product/app#43',
    number: 43,
    title: 'Work in the child',
    description: '',
    closed: false,
    stage: { category: null, categoryName: null, label: 'Flow::Doing' },
    url: 'https://gitlab.example.invalid/acme/product/app/-/issues/43',
    bundle: 'acme/product&8',
    updatedAt: new Date('2026-08-24T00:00:00Z'), // the newest date in the tree
    health: 'risk',
  }

  const child: Bundle = {
    key: 'acme/product&8',
    number: 8,
    name: 'A sub-epic',
    description: '',
    closed: false,
    due: null,
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/8',
    progress: progressOf(1, 0),
    lastActivity: new Date('2026-08-02T00:00:00Z'),
    health: null,
    items: [childItem],
    children: [],
  }

  return {
    key: 'acme/product&7',
    number: 7,
    name: 'The bundle',
    description: 'What this is about.',
    closed: false,
    due: new Date('2026-09-30T00:00:00Z'),
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
    progress: progressOf(3, 1),
    lastActivity: new Date('2026-08-05T00:00:00Z'),
    health: null,
    items: [closedItem, activeItem],
    children: [child],
  }
}

test('progress comes from the rolled-up pair, not from counting items', () => {
  const b = theBundle()
  assert.deepEqual(b.progress, { done: 1, total: 3, ratio: 1 / 3 })
  // The tree holds three issues while the bundle carries two of its own —
  // which is the point of counting through rather than counting items.
  assert.equal(b.items.length, 2)
})

test('the state recurses into the child and terminates', () => {
  assert.equal(stateOf(theBundle(), cfg), 'In progress')
})

test('health takes the worst from the rollup', () => {
  const rolled: HealthCount[] = [
    { health: 'ok', count: 12 },
    { health: 'risk', count: 1 },
  ]
  assert.equal(healthOf(null, rolled), 'risk')
})

test('last activity comes from the child, not from the bundle', () => {
  assert.deepEqual(lastActivityOf(theBundle()), new Date('2026-08-24T00:00:00Z'))
})

test('the key is built under both forms, from the bundle path', () => {
  const ref = { path: 'acme/product', number: 7, kind: 'epic' as const, sourcePath: null }
  assert.equal(bundleKeyOf(ref, cfg), 'acme/product&7')
  assert.equal(
    bundleKeyOf(ref, { ...cfg, keyIs: 'url' }),
    'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
  )
})

test('the whole bundle survives one pass through rowsOf', () => {
  const b = theBundle()
  const result: SourceResult = { bundles: [b], prefixes: ['Workflow'], truncated: [] }
  const rows = rowsOf(result, cfg)

  // parent + its two items + the child + the child's item
  assert.equal(rows.length, 5)

  const parentRow = rows.find((r) => r.key === 'acme/product&7')!
  assert.equal(parentRow.level, 'bundle')
  assert.equal(parentRow.state, 'In progress')
  assert.deepEqual(parentRow.progress, { done: 1, total: 3, ratio: 1 / 3 })
  assert.deepEqual(parentRow.due, new Date('2026-09-30T00:00:00Z'))

  // The closed item keeps its closed value although it wore an active label.
  assert.equal(rows.find((r) => r.key === 'acme/product/app#41')!.state, 'Done')
  assert.equal(rows.find((r) => r.key === 'acme/product/app#42')!.state, 'In progress')

  const childRow = rows.find((r) => r.key === 'acme/product&8')!
  assert.equal(childRow.level, 'bundle')
  assert.equal(childRow.state, 'In progress')

  // An item row carries no progress of its own.
  for (const row of rows.filter((r) => r.level === 'item')) {
    assert.equal(row.progress, null)
  }
})
