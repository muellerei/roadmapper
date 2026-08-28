import { test } from 'node:test'
import assert from 'node:assert/strict'
import { healthOf } from '../src/core/health.js'

test('the worst beneath it wins, not the most frequent', () => {
  assert.equal(
    healthOf(null, [
      { health: 'risk', count: 1 },
      { health: 'ok', count: 20 },
    ]),
    'risk',
  )
})

test('an own value beats the rollup', () => {
  assert.equal(healthOf('ok', [{ health: 'risk', count: 1 }]), 'ok')
})

test('zero counts do not count', () => {
  assert.equal(
    healthOf(null, [
      { health: 'ok', count: 0 },
      { health: 'risk', count: 0 },
    ]),
    null,
  )
})

test('nothing beneath it and no own value is no health', () => {
  assert.equal(healthOf(null, []), null)
})

/**
 * The MIDDLE step, and the reason it needs its own test: `bySeverity` is a
 * priority list read front to back, so an order that puts `ok` before
 * `attention` compiles, reads plausibly, and reports a bundle that needs
 * looking at as fine. Checking only the outer two (risk against ok) leaves
 * that swap invisible — verified by mutation: reordering the list to
 * ['risk','ok','attention'] left the whole suite green before these tests
 * existed.
 *
 * Reachable, not hypothetical: AK30 maps GitLab's `needsAttention` onto this
 * value, so it arrives from real data.
 */
test('attention beats ok — the middle of the severity order holds', () => {
  assert.equal(
    healthOf(null, [
      { health: 'ok', count: 20 },
      { health: 'attention', count: 1 },
    ]),
    'attention',
  )
})

test('risk beats attention — the other half of the same order', () => {
  assert.equal(
    healthOf(null, [
      { health: 'attention', count: 20 },
      { health: 'risk', count: 1 },
    ]),
    'risk',
  )
})

test('all three at once still yields the worst', () => {
  assert.equal(
    healthOf(null, [
      { health: 'ok', count: 100 },
      { health: 'attention', count: 10 },
      { health: 'risk', count: 1 },
    ]),
    'risk',
  )
})

test('the order does not depend on how the pairs arrive', () => {
  // GitLab guarantees no order in the rollup, so the list must decide, never
  // the position in the answer.
  const pairs = [
    { health: 'attention' as const, count: 1 },
    { health: 'ok' as const, count: 1 },
  ]
  assert.equal(healthOf(null, pairs), 'attention')
  assert.equal(healthOf(null, [...pairs].reverse()), 'attention')
})

test('a zero count does not win its rank', () => {
  // The counter-check to the order: attention outranks ok, but only when
  // somebody actually carries it.
  assert.equal(
    healthOf(null, [
      { health: 'attention', count: 0 },
      { health: 'ok', count: 3 },
    ]),
    'ok',
  )
})
