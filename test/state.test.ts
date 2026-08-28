import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stateOf, verdictOfChild, verdictOfItem } from '../src/core/state.js'
import type { Bundle, CoreConfig, Item, Stage, StatusCategory } from '../src/core/types.js'

const DEFAULT = 'Backlog'
const CLOSED = 'Done'

/** A label-driven board: the [status] table maps scoped labels onto the
 *  values the board speaks. */
const byLabel: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([
    ['Flow::Doing', 'In progress'],
    ['Flow::Blocked', 'Blocked'],
    ['Flow::Ready', 'Ready'],
  ]),
  active: ['In progress'],
  blocked: ['Blocked'],
  closed: CLOSED,
  default: DEFAULT,
}

/** A status-driven board: `active` is not set at all, because the category
 *  carries the meaning itself (section 10). */
const byStatus: CoreConfig = { ...byLabel, stageSource: 'status', active: [], blocked: ['Blocked'] }

function stage(over: Partial<Stage> = {}): Stage {
  return { category: null, categoryName: null, label: null, ...over }
}

let counter = 0
function item(over: Partial<Item> = {}): Item {
  counter += 1
  return {
    key: `acme/product#${counter}`,
    number: counter,
    title: 'An issue',
    description: '',
    closed: false,
    stage: stage(),
    url: 'https://example.invalid/i',
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
    url: 'https://example.invalid/b',
    progress: null,
    lastActivity: new Date('2026-08-01T00:00:00Z'),
    health: null,
    items: [],
    children: [],
    ...over,
  }
}

const labelled = (label: string) => item({ stage: stage({ label }) })
const categorised = (category: StatusCategory, categoryName: string) =>
  item({ stage: stage({ category, categoryName }) })

test('AK3 one active item makes the bundle active', () => {
  assert.equal(stateOf(bundle({ items: [labelled('Flow::Doing')] }), byLabel), 'In progress')
})

test('AK4 one blocked beside one active is active', () => {
  const b = bundle({ items: [labelled('Flow::Blocked'), labelled('Flow::Doing')] })
  assert.equal(stateOf(b, byLabel), 'In progress')
})

test('AK5 all items blocked makes the bundle blocked', () => {
  const b = bundle({ items: [labelled('Flow::Blocked'), labelled('Flow::Blocked')] })
  assert.equal(stateOf(b, byLabel), 'Blocked')
})

test('AK6 a bundle without items reads as nothing known, not nothing done', () => {
  assert.equal(stateOf(bundle(), byLabel), DEFAULT)
})

test('AK7 an active child bundle counts although items is empty', () => {
  const child = bundle({ items: [labelled('Flow::Doing')] })
  assert.equal(stateOf(bundle({ children: [child] }), byLabel), 'In progress')
})

test('AK7a the status category alone makes it active, with active unset', () => {
  const b = bundle({ items: [categorised('active', 'In review')] })
  assert.equal(stateOf(b, byStatus), 'In review')
})

test('AK7b the chosen source wins: category active beats a blocked label', () => {
  const b = bundle({
    items: [item({ stage: stage({ category: 'active', categoryName: 'In review', label: 'Flow::Blocked' }) })],
  })
  assert.equal(stateOf(b, byStatus), 'In review')
})

test('AK7c a label mapped into active makes it active', () => {
  assert.equal(stateOf(bundle({ items: [labelled('Flow::Doing')] }), byLabel), 'In progress')
})

test('AK7d a stage that is entirely null falls to default under both settings', () => {
  const b = bundle({ items: [item()] })
  assert.equal(stateOf(b, byLabel), DEFAULT)
  assert.equal(stateOf(b, byStatus), DEFAULT)
})

test('AK7e closed beats an active stage', () => {
  const b = bundle({ items: [item({ closed: true, stage: stage({ label: 'Flow::Doing' }) })] })
  assert.equal(stateOf(b, byLabel), CLOSED)
})

test('AK7f a closed bundle takes the closed value', () => {
  assert.equal(stateOf(bundle({ closed: true }), byLabel), CLOSED)
})

test('AK7g label source: a present category does not rescue an unmapped label', () => {
  const b = bundle({
    items: [item({ stage: stage({ category: 'active', categoryName: 'In review', label: 'Flow::Ready' }) })],
  })
  assert.equal(stateOf(b, byLabel), DEFAULT)
})

test('AK7h status source: a label does not rescue a missing category', () => {
  const b = bundle({ items: [item({ stage: stage({ label: 'Flow::Doing' }) })] })
  assert.equal(stateOf(b, byStatus), DEFAULT)
})

test('AK26 all items closed while the bundle is open reads as closed', () => {
  const b = bundle({ items: [item({ closed: true }), item({ closed: true })] })
  assert.equal(stateOf(b, byLabel), CLOSED)
})

test('AK27 one closed beside one open item is active', () => {
  const b = bundle({ items: [item({ closed: true }), labelled('Flow::Ready')] })
  assert.equal(stateOf(b, byLabel), 'In progress')
})

test('AK27a a closed item beside an UNLABELLED open one is still active', () => {
  // The scar of section 9, one level up. Row 5 has two triggers, and only
  // `active` brings a value along — `done` does not, because finished
  // children carry cfg.closed. When the done trigger fires alone the
  // triggering set is EMPTY, and `return cfg.default` there put a bundle
  // somebody demonstrably worked on onto "Backlog". The last branch of
  // pick() returns the value the configuration names FIRST instead.
  const b = bundle({ items: [item({ closed: true }), item()] })
  assert.equal(stateOf(b, byLabel), 'In progress')
  assert.notEqual(stateOf(b, byLabel), byLabel.default)
})

test('AK27a counter-check: with `active` empty the triggering value still wins', () => {
  // stage_source = "status" leaves `active` unset by design, so the branch
  // above cannot fire. The sorted value of the triggering children applies —
  // cfg.default here would put EVERY bundle with running children on the
  // default while the fill rate read 30/30.
  const b = bundle({ items: [item({ closed: true }), categorised('active', 'Doing')] })
  assert.equal(stateOf(b, byStatus), 'Doing')
})

test('AK28 eight own items plus an active child bundle is active', () => {
  const items = Array.from({ length: 8 }, () => labelled('Flow::Ready'))
  const child = bundle({ items: [labelled('Flow::Doing')] })
  assert.equal(stateOf(bundle({ items, children: [child] }), byLabel), 'In progress')
})

test('AK41 status source: an active category whose display name is blocked reads blocked', () => {
  const b = bundle({ items: [categorised('active', 'Blocked'), categorised('active', 'Blocked')] })
  assert.equal(stateOf(b, byStatus), 'Blocked')
})

test('AK42 nine done children beside one blocked read as blocked, not in progress', () => {
  const done = Array.from({ length: 9 }, () => item({ closed: true }))
  const b = bundle({ items: [...done, labelled('Flow::Blocked')] })
  assert.equal(stateOf(b, byLabel), 'Blocked')
})

test('AK43 one blocked child beside one active child is active', () => {
  const blocked = bundle({ items: [labelled('Flow::Blocked')] })
  const active = bundle({ items: [labelled('Flow::Doing')] })
  assert.equal(stateOf(bundle({ children: [blocked, active] }), byLabel), 'In progress')
})

test('AK43b disagreeing blocked values follow the configuration order', () => {
  const cfg: CoreConfig = {
    ...byLabel,
    statusMap: new Map([
      ['Flow::Blocked', 'Blocked'],
      ['Flow::Waiting', 'Waiting'],
    ]),
    blocked: ['Blocked', 'Waiting'],
  }
  const mixed = bundle({ items: [labelled('Flow::Blocked'), labelled('Flow::Waiting')] })
  assert.equal(stateOf(mixed, cfg), 'Blocked')

  const agreed = bundle({ items: [labelled('Flow::Waiting'), labelled('Flow::Waiting')] })
  assert.equal(stateOf(agreed, cfg), 'Waiting')
})

test('AK43c status source with empty active picks a display name, stably', () => {
  const one = bundle({ items: [categorised('active', 'In review')] })
  const two = bundle({ items: [categorised('active', 'In dev')] })
  const b = bundle({ children: [one, two] })

  const first = stateOf(b, byStatus)
  assert.ok(['In review', 'In dev'].includes(first), first)
  assert.notEqual(first, DEFAULT)
  assert.equal(stateOf(b, byStatus), first)
})

test('AK44 both verdict helpers yield the same shape under both settings', () => {
  const shape = ['value', 'done', 'active', 'blocked']
  const child = bundle({ items: [labelled('Flow::Doing')] })

  for (const cfg of [byLabel, byStatus]) {
    assert.deepEqual(Object.keys(verdictOfItem(labelled('Flow::Doing'), cfg)).sort(), [...shape].sort())
    assert.deepEqual(Object.keys(verdictOfChild(child, cfg)).sort(), [...shape].sort())
  }
})

test('a child bundle carries active: true under BOTH stage sources (AK44)', () => {
  const byLabelChild = bundle({ items: [labelled('Flow::Doing')] })
  assert.equal(verdictOfChild(byLabelChild, byLabel).active, true)

  const byStatusChild = bundle({ items: [categorised('active', 'In review')] })
  assert.equal(verdictOfChild(byStatusChild, byStatus).active, true)
})

test('a child bundle whose open children are all blocked carries blocked: true', () => {
  const child = bundle({ items: [labelled('Flow::Blocked')] })
  const v = verdictOfChild(child, byLabel)
  assert.equal(v.blocked, true)
  assert.equal(v.active, false)
  assert.equal(v.value, 'Blocked')
})

test('a child bundle with everything done carries done: true, so row 3 can see it', () => {
  const child = bundle({ items: [item({ closed: true })] })
  assert.equal(verdictOfChild(child, byLabel).done, true)
  assert.equal(stateOf(bundle({ children: [child] }), byLabel), CLOSED)
})

test('a child bundle with nothing known carries no flags at all', () => {
  const v = verdictOfChild(bundle(), byLabel)
  assert.deepEqual(v, { value: DEFAULT, done: false, active: false, blocked: false })
})

test('nesting one level deeper still reads through under the status source', () => {
  const grandchild = bundle({ items: [categorised('active', 'In review')] })
  const child = bundle({ children: [grandchild] })
  assert.equal(stateOf(bundle({ children: [child] }), byStatus), 'In review')
})
