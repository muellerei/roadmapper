import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastActivityOf } from '../src/core/activity.js'
import type { Bundle, Item } from '../src/core/types.js'

const at = (iso: string) => new Date(iso)

function item(updatedAt: Date): Item {
  return {
    key: 'acme/product#1',
    number: 1,
    title: 'An issue',
    description: '',
    closed: false,
    stage: { category: null, categoryName: null, label: null },
    url: 'https://example.invalid/acme/product/-/issues/1',
    bundle: 'acme/product&1',
    updatedAt,
    health: null,
  }
}

function bundle(updatedAt: Date, items: Item[] = [], children: Bundle[] = []): Bundle {
  return {
    key: 'acme/product&1',
    number: 1,
    name: 'A bundle',
    description: '',
    closed: false,
    due: null,
    url: 'https://example.invalid/acme/product/-/epics/1',
    progress: null,
    lastActivity: updatedAt,
    health: null,
    items,
    children,
  }
}

test('a bundle newer than all its items carries its own date', () => {
  const b = bundle(at('2026-08-20T00:00:00Z'), [item(at('2026-08-10T00:00:00Z'))])
  assert.deepEqual(lastActivityOf(b), at('2026-08-20T00:00:00Z'))
})

test('an item newer than the bundle wins', () => {
  const b = bundle(at('2026-08-10T00:00:00Z'), [item(at('2026-08-20T00:00:00Z'))])
  assert.deepEqual(lastActivityOf(b), at('2026-08-20T00:00:00Z'))
})

test('a child that moved yesterday beats the bundle with no items of its own', () => {
  const child = bundle(at('2026-08-24T00:00:00Z'))
  const b = bundle(at('2026-07-01T00:00:00Z'), [], [child])
  assert.deepEqual(lastActivityOf(b), at('2026-08-24T00:00:00Z'))
})

test('the newest sits in a child, beside items of its own', () => {
  const child = bundle(at('2026-08-24T00:00:00Z'), [item(at('2026-08-25T00:00:00Z'))])
  const b = bundle(at('2026-07-01T00:00:00Z'), [item(at('2026-08-02T00:00:00Z'))], [child])
  assert.deepEqual(lastActivityOf(b), at('2026-08-25T00:00:00Z'))
})

test('a bundle without items and without children carries its own date', () => {
  const b = bundle(at('2026-08-20T00:00:00Z'))
  assert.deepEqual(lastActivityOf(b), at('2026-08-20T00:00:00Z'))
})
