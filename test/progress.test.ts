import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressOf } from '../src/core/progress.js'

test('counts closed against total', () => {
  assert.deepEqual(progressOf(30, 12), { done: 12, total: 30, ratio: 0.4 })
})

test('a bundle without items has no progress', () => {
  assert.equal(progressOf(0, 0), null)
})
