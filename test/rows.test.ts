import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowsOf } from '../src/core/rows.js'
import type { Bundle, CoreConfig, Item, SourceResult, Stage } from '../src/core/types.js'

const DEFAULT = 'Backlog'
const CLOSED = 'Done'

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
  closed: CLOSED,
  default: DEFAULT,
}

function stage(over: Partial<Stage> = {}): Stage {
  return { category: null, categoryName: null, label: null, ...over }
}

let counter = 0
function item(over: Partial<Item> = {}): Item {
  counter += 1
  return {
    key: `acme/product#${counter}`,
    number: counter,
    title: `Issue ${counter}`,
    description: '',
    closed: false,
    stage: stage(),
    url: `https://example.invalid/i/${counter}`,
    bundle: 'acme/product&1',
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    health: null,
    ...over,
  }
}

function bundle(over: Partial<Bundle> = {}): Bundle {
  return {
    key: 'acme/product&1',
    number: 1,
    name: 'A bundle',
    description: '',
    closed: false,
    due: null,
    url: 'https://example.invalid/b/1',
    progress: { done: 1, total: 2, ratio: 0.5 },
    lastActivity: new Date('2026-08-01T00:00:00Z'),
    health: null,
    items: [],
    children: [],
    ...over,
  }
}

const result = (bundles: Bundle[]): SourceResult => ({ bundles, prefixes: [], truncated: [] })

test('AK51 a bundle with two items yields three rows', () => {
  const b = bundle({ items: [item(), item()] })
  const rows = rowsOf(result([b]), cfg)

  assert.equal(rows.length, 3)
  assert.equal(rows.filter((r) => r.level === 'bundle').length, 1)
  assert.equal(rows.filter((r) => r.level === 'item').length, 2)

  const bundleRow = rows.find((r) => r.level === 'bundle')!
  assert.notEqual(bundleRow.progress, null)
})

test('AK51a an item row carries no progress', () => {
  const rows = rowsOf(result([bundle({ items: [item()] })]), cfg)
  assert.equal(rows.find((r) => r.level === 'item')!.progress, null)
})

test('AK52 a row is fully derived — it carries a state string, never a config', () => {
  const b = bundle({ items: [item({ stage: stage({ label: 'Flow::Doing' }) })] })
  const rows = rowsOf(result([b]), cfg)

  assert.equal(rows.find((r) => r.level === 'bundle')!.state, 'In progress')
  assert.equal(rows.find((r) => r.level === 'item')!.state, 'In progress')
  for (const row of rows) assert.equal(typeof row.state, 'string')
})

test('AK55 a closed child bundle counts in the derivation but gets no row', () => {
  const closedChild = () => bundle({ key: 'acme/product&2', closed: true })
  const parent = bundle({ children: [closedChild(), closedChild()] })
  const rows = rowsOf(result([parent]), cfg)

  // Table row 3: all children done -> closed, not default.
  assert.equal(rows.find((r) => r.key === parent.key)!.state, CLOSED)
  // Counter-check: the closed child itself is not on the board.
  assert.equal(rows.filter((r) => r.key === 'acme/product&2').length, 0)
})

test('an open child bundle gets a row of its own, at bundle level', () => {
  const child = bundle({ key: 'acme/product&2', items: [item({ stage: stage({ label: 'Flow::Doing' }) })] })
  const rows = rowsOf(result([bundle({ children: [child] })]), cfg)

  const childRow = rows.find((r) => r.key === 'acme/product&2')
  assert.ok(childRow, 'the child bundle has a row')
  assert.equal(childRow.level, 'bundle')
  assert.equal(childRow.state, 'In progress')
})

test('the order is a bundle followed by its own items', () => {
  const b = bundle({ items: [item(), item()] })
  const rows = rowsOf(result([b]), cfg)

  assert.equal(rows[0]!.level, 'bundle')
  assert.equal(rows[1]!.level, 'item')
  assert.equal(rows[2]!.level, 'item')
})

test('a bundle row carries its items so the page body can list them', () => {
  const b = bundle({ items: [item(), item()] })
  const bundleRow = rowsOf(result([b]), cfg).find((r) => r.level === 'bundle')!
  assert.equal(bundleRow.items.length, 2)
  assert.equal(bundleRow.items[0]!.level, 'item')
})

test('rows carry dates and a count pair, never rendered strings', () => {
  const b = bundle({ due: new Date('2026-09-01T00:00:00Z'), items: [item()] })
  const bundleRow = rowsOf(result([b]), cfg).find((r) => r.level === 'bundle')!

  assert.ok(bundleRow.due instanceof Date)
  assert.ok(bundleRow.activity instanceof Date)
  assert.deepEqual(bundleRow.progress, { done: 1, total: 2, ratio: 0.5 })
})

test('an item row of a closed item reads as closed, whatever it wore', () => {
  const b = bundle({ items: [item({ closed: true, stage: stage({ label: 'Flow::Doing' }) })] })
  assert.equal(rowsOf(result([b]), cfg).find((r) => r.level === 'item')!.state, CLOSED)
})

test('a row carries the source\'s own closed flag, not a reading of its state', () => {
  const b = bundle({
    items: [
      item({ key: 'acme/product/app#1', closed: true, stage: stage({ label: 'Flow::Doing' }) }),
      item({ key: 'acme/product/app#2', closed: false }),
    ],
  })
  const rows = rowsOf(result([b]), cfg)

  assert.equal(rows.find((r) => r.key === 'acme/product/app#1')!.closed, true)
  assert.equal(rows.find((r) => r.key === 'acme/product/app#2')!.closed, false)
  assert.equal(rows.find((r) => r.level === 'bundle')!.closed, false)
})

test('a done category counts as finished although GitLab still calls the item open', () => {
  // This is why Row carries `closed` instead of the body comparing
  // state === cfg.closed: here the state is the display name, and the
  // comparison would list a finished item under ○ among the open ones.
  const byStatus: CoreConfig = { ...cfg, stageSource: 'status', active: [], blocked: [] }
  const verified = item({
    key: 'acme/product/app#3',
    closed: false,
    stage: stage({ category: 'done', categoryName: 'Verification' }),
  })
  const rows = rowsOf(result([bundle({ items: [verified] })]), byStatus)
  const itemRow = rows.find((r) => r.key === 'acme/product/app#3')!

  assert.equal(itemRow.state, 'Verification')
  assert.notEqual(itemRow.state, byStatus.closed)
  // Finished is finished — the same rule the state table applies in row 3,
  // where a cancelled ticket must not block "all children done" forever.
  assert.equal(itemRow.closed, true)
})

test('include_closed applies the SAME rule at every level', () => {
  const closedChild = bundle({ key: 'acme/product&2', closed: true })
  const openChild = bundle({ key: 'acme/product&3' })
  const parent = bundle({ children: [closedChild, openChild] })

  // Default: no closed bundle gets a row, at any level.
  const hidden = rowsOf(result([parent]), cfg).map((r) => r.key)
  assert.deepEqual(hidden, ['acme/product&1', 'acme/product&3'])

  // include_closed = true: every closed bundle gets one, at any level —
  // a closed sub-epic is treated exactly like a closed top-level one.
  const shown = rowsOf(result([parent]), cfg, { includeClosed: true }).map((r) => r.key)
  assert.deepEqual(shown, ['acme/product&1', 'acme/product&2', 'acme/product&3'])
})

test('include_closed never touches the derivation, only the rows', () => {
  const closedChild = () => bundle({ key: 'acme/product&2', closed: true })
  const parent = bundle({ children: [closedChild(), closedChild()] })

  // Table row 3 fires in BOTH cases: the children are counted either way.
  for (const options of [{}, { includeClosed: true }]) {
    const rows = rowsOf(result([parent]), cfg, options)
    assert.equal(rows.find((r) => r.key === parent.key)!.state, CLOSED)
  }
})

test('a row carries its number for display, never parsed back out of the key', () => {
  // Identity is the key's job, display is the number's (CONTEXT.md). Reading
  // it back out of the key inverts that — and under keyIs = "url" there is
  // no number in the key to read.
  const byUrl: CoreConfig = { ...cfg, keyIs: 'url' }
  const b = bundle({ number: 7, items: [item({ number: 42 })] })
  const rows = rowsOf(result([b]), byUrl)

  assert.equal(rows.find((r) => r.level === 'bundle')!.number, 7)
  assert.equal(rows.find((r) => r.level === 'item')!.number, 42)
})

test('rowsOf passes health, description and activity through unchanged', () => {
  // These are plain hand-overs, which is exactly why nothing tested them:
  // all three could be dropped and the derivation tests would stay green.
  const b = bundle({
    health: 'risk',
    description: 'What this is about.',
    lastActivity: new Date('2026-08-24T00:00:00Z'),
    items: [item({ description: 'The item text.', health: 'attention' })],
  })
  const rows = rowsOf(result([b]), cfg)

  const bundleRow = rows.find((r) => r.level === 'bundle')!
  assert.equal(bundleRow.health, 'risk')
  assert.equal(bundleRow.description, 'What this is about.')
  assert.deepEqual(bundleRow.activity, new Date('2026-08-24T00:00:00Z'))

  const itemRow = rows.find((r) => r.level === 'item')!
  assert.equal(itemRow.description, 'The item text.')
  assert.equal(itemRow.health, 'attention')
})

test('EC11 an empty description stays an empty string, never null', () => {
  const rows = rowsOf(result([bundle({ description: '', items: [item({ description: '' })] })]), cfg)
  for (const row of rows) {
    assert.equal(row.description, '')
    assert.notEqual(row.description, null)
  }
})
