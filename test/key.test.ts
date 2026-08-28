import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleKeyOf, itemKeyOf } from '../src/core/key.js'
import type { CoreConfig } from '../src/core/types.js'

const base: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map(),
  active: [],
  blocked: [],
  closed: 'Done',
  default: 'Backlog',
}

const byId: CoreConfig = base
const byUrl: CoreConfig = { ...base, keyIs: 'url' }

test('epic, milestone and item of the same number get different keys', () => {
  const epic = bundleKeyOf({ path: 'acme/product', number: 7, kind: 'epic', sourcePath: null }, byId)
  const milestone = bundleKeyOf(
    { path: 'acme/product', number: 7, kind: 'milestone', sourcePath: '/groups/acme/product/-/milestones/7' },
    byId,
  )
  const item = itemKeyOf('acme/product', 7, byId)

  assert.equal(epic, 'acme/product&7')
  assert.equal(milestone, 'acme/product%7')
  assert.equal(item, 'acme/product#7')
  assert.equal(new Set([epic, milestone, item]).size, 3)
})

test('the same item number in two projects gets two keys', () => {
  assert.notEqual(itemKeyOf('acme/product/app', 42, byId), itemKeyOf('acme/product/api', 42, byId))
})

test('two epics of the same number in different subgroups get two keys', () => {
  const one = bundleKeyOf({ path: 'acme/alpha', number: 59, kind: 'epic', sourcePath: null }, byId)
  const two = bundleKeyOf({ path: 'acme/beta', number: 59, kind: 'epic', sourcePath: null }, byId)
  assert.notEqual(one, two)
})

test('key_is = url builds the epic URL itself, in the classic form', () => {
  assert.equal(
    bundleKeyOf({ path: 'acme/product', number: 7, kind: 'epic', sourcePath: null }, byUrl),
    'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
  )
})

test('key_is = url takes the source path for a group milestone', () => {
  assert.equal(
    bundleKeyOf(
      { path: 'acme', number: 3, kind: 'milestone', sourcePath: '/groups/acme/-/milestones/3' },
      byUrl,
    ),
    'https://gitlab.example.invalid/groups/acme/-/milestones/3',
  )
})

test('key_is = url takes the source path for a project milestone', () => {
  assert.equal(
    bundleKeyOf(
      { path: 'acme/product', number: 3, kind: 'milestone', sourcePath: '/acme/product/-/milestones/3' },
      byUrl,
    ),
    'https://gitlab.example.invalid/acme/product/-/milestones/3',
  )
})

test('key_is = url leaves no double slash when the host carries a trailing one', () => {
  const key = bundleKeyOf(
    { path: 'acme', number: 3, kind: 'milestone', sourcePath: '/groups/acme/-/milestones/3' },
    { ...byUrl, host: 'gitlab.example.invalid/' },
  )
  assert.equal(key, 'https://gitlab.example.invalid/groups/acme/-/milestones/3')
})

test('an epic without a source path shows no "null" in its URL', () => {
  const key = bundleKeyOf({ path: 'acme/product', number: 7, kind: 'epic', sourcePath: null }, byUrl)
  assert.ok(!key.includes('null'), key)
})

test('key_is = url builds the item URL in the classic form', () => {
  assert.equal(
    itemKeyOf('acme/product/app', 42, byUrl),
    'https://gitlab.example.invalid/acme/product/app/-/issues/42',
  )
})

test('the same bundle yields different keys under id and url', () => {
  const ref = { path: 'acme/product', number: 7, kind: 'epic' as const, sourcePath: null }
  assert.notEqual(bundleKeyOf(ref, byId), bundleKeyOf(ref, byUrl))
})
