import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressOf } from '../src/core/progress.js'

test('counts closed against total', () => {
  const p = progressOf([{ closed: true }, { closed: true }, { closed: false }, { closed: false }])
  assert.deepEqual(p, { done: 2, total: 4, ratio: 0.5 })
})

test('a bundle without items has no progress', () => {
  assert.equal(progressOf([]), null)
})
