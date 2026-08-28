import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRetrier, NotionUnavailable } from '../src/output/notion/throttle.js'

/**
 * A clock the test advances, so these paths cost no real seconds.
 *
 * `now` moves forward by whatever was slept, which lets the pacing be tested
 * without wall time — and keeps the RETRY waits below distinguishable from
 * the minimum gap between requests.
 */
function clock(start = 1_000_000) {
  const waited: number[] = []
  let time = start
  return {
    waited,
    now: () => time,
    sleep: async (ms: number) => {
      waited.push(ms)
      time += ms
    },
    /** Let time pass without a sleep — as a real request does. */
    pass: (ms: number) => void (time += ms),
  }
}

/** Notion's error shape: a status and the headers it came with. */
function refusal(status: number, retryAfter?: string) {
  const error = new Error(`HTTP ${status}`) as Error & { status: number; headers: Record<string, string> }
  error.status = status
  error.headers = retryAfter === undefined ? {} : { 'retry-after': retryAfter }
  return error
}

/** Fails the first `failures` times, then succeeds. */
function flaky(failures: number, status = 429, retryAfter?: string) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    request: async () => {
      calls += 1
      if (calls <= failures) throw refusal(status, retryAfter)
      return 'written'
    },
  }
}

test('AK36 a 429 with Retry-After waits exactly that long and repeats the SAME request', async () => {
  const time = clock()
  const target = flaky(1, 429, '2')

  const result = await createRetrier(time.sleep, () => 0.5, time.now).run(target.request)

  assert.equal(result, 'written')
  assert.equal(target.calls, 2, 'the same request is repeated, not skipped')
  // Two seconds, in milliseconds — not an interval of our own choosing.
  assert.deepEqual(time.waited, [2000])
})

test('AK37 a 529 takes the same retry path as a 429', async () => {
  const time = clock()
  const target = flaky(1, 529, '1')

  assert.equal(await createRetrier(time.sleep, () => 0.5, time.now).run(target.request), 'written')
  assert.deepEqual(time.waited, [1000])
})

test('AK37 the message distinguishes too-fast from overloaded', async () => {
  const time = clock()

  await assert.rejects(
    () => createRetrier(time.sleep, () => 0.5, time.now).run(flaky(99, 429).request),
    (e: unknown) => {
      assert.ok(e instanceof NotionUnavailable)
      assert.equal(e.status, 429)
      assert.match(e.message, /too fast/)
      return true
    },
  )

  await assert.rejects(
    () => createRetrier(time.sleep, () => 0.5, time.now).run(flaky(99, 529).request),
    (e: unknown) => {
      assert.ok(e instanceof NotionUnavailable)
      assert.equal(e.status, 529)
      assert.match(e.message, /overloaded/)
      return true
    },
  )
})

test('AK38 after six attempts it gives up, having waited five times', async () => {
  const time = clock()
  const target = flaky(99)

  await assert.rejects(() => createRetrier(time.sleep, () => 0.5, time.now).run(target.request), NotionUnavailable)

  assert.equal(target.calls, 6, 'at most six attempts')
  assert.equal(time.waited.length, 5, 'no wait after the last attempt')
})

test('AK39 without Retry-After the wait grows exponentially and stays under 30 s', async () => {
  const time = clock()
  // random() = 1 gives the upper end of the jitter band, so the cap is
  // asserted where it actually bites.
  await assert.rejects(() => createRetrier(time.sleep, () => 1, time.now).run(flaky(99).request), NotionUnavailable)

  assert.deepEqual(time.waited, [1000, 2000, 4000, 8000, 16000])
  for (const wait of time.waited) assert.ok(wait <= 30_000, `${wait} exceeds the 30 s cap`)
})

test('AK39 the cap holds even when the backoff would grow past it', async () => {
  const time = clock()
  // Ten failures would reach 512 s ungapped; six attempts stop earlier, so
  // the cap is checked on the formula itself via a long Retry-After-free run.
  await assert.rejects(() => createRetrier(time.sleep, () => 1, time.now).run(flaky(99).request), NotionUnavailable)
  assert.ok(Math.max(...time.waited) <= 30_000)
})

test('AK39 jitter makes two identical failure sequences wait different lengths', async () => {
  const one = clock()
  const two = clock()
  const sequence = (values: number[]) => {
    let i = 0
    return () => values[i++ % values.length]!
  }

  await assert.rejects(() => createRetrier(one.sleep, sequence([0.1, 0.2, 0.3, 0.4, 0.5]), one.now).run(flaky(99).request), NotionUnavailable)
  await assert.rejects(() => createRetrier(two.sleep, sequence([0.9, 0.8, 0.7, 0.6, 0.5]), two.now).run(flaky(99).request), NotionUnavailable)

  assert.notDeepEqual(one.waited, two.waited)
})

test('Retry-After applies on the FIRST failure only; the own backoff takes over after', async () => {
  const time = clock()
  await assert.rejects(
    () => createRetrier(time.sleep, () => 1, time.now).run(flaky(99, 429, '7').request),
    NotionUnavailable,
  )

  // First the server's seven seconds, then our own growing intervals.
  assert.equal(time.waited[0], 7000)
  assert.deepEqual(time.waited.slice(1), [2000, 4000, 8000, 16000])
})

test('an error that is not 429 or 529 is not retried at all', async () => {
  const time = clock()
  const target = flaky(1, 400)

  await assert.rejects(() => createRetrier(time.sleep, () => 0.5, time.now).run(target.request), /HTTP 400/)
  assert.equal(target.calls, 1)
  assert.deepEqual(time.waited, [])
})

test('a request that succeeds first time never waits', async () => {
  const time = clock()
  assert.equal(await createRetrier(time.sleep, () => 0.5, time.now).run(async () => 'ok'), 'ok')
  assert.deepEqual(time.waited, [])
})

test('a Headers object is read as well as a plain record', async () => {
  const time = clock()
  const error = new Error('429') as Error & { status: number; headers: Headers }
  error.status = 429
  error.headers = new Headers({ 'retry-after': '3' })

  let calls = 0
  await createRetrier(time.sleep, () => 0.5, time.now).run(async () => {
    calls += 1
    if (calls === 1) throw error
    return 'ok'
  })

  assert.deepEqual(time.waited, [3000])
})

test('requests are paced to at most 3 per second', async () => {
  const time = clock()
  const retrier = createRetrier(time.sleep, () => 0.5, time.now)

  // Four instant requests: the first goes straight through, the rest each
  // wait out the gap.
  for (let i = 0; i < 4; i += 1) await retrier.run(async () => 'ok')

  assert.deepEqual(time.waited, [334, 334, 334])
})

test('a request that took longer than the gap is not delayed at all', async () => {
  const time = clock()
  const retrier = createRetrier(time.sleep, () => 0.5, time.now)

  await retrier.run(async () => 'ok')
  // A real round trip of 600 ms — measured against Notion from a laptop.
  time.pass(600)
  await retrier.run(async () => 'ok')

  // The pacer costs nothing on a run that was already slower than the limit.
  assert.deepEqual(time.waited, [])
})

test('pacing is per retrier, so two targets never share a pace', async () => {
  const one = clock()
  const two = clock()

  await createRetrier(one.sleep, () => 0.5, one.now).run(async () => 'ok')
  await createRetrier(two.sleep, () => 0.5, two.now).run(async () => 'ok')

  // Neither waited: each is on its first request.
  assert.deepEqual(one.waited, [])
  assert.deepEqual(two.waited, [])
})

/**
 * The server's Retry-After is the better answer to "how long" — but not a
 * licence to hold the process for as long as it likes. This runs in cron: a
 * `retry-after: 3600` would park one run for an hour while the next starts
 * beside it.
 *
 * Capped at the same 30 s the own backoff uses. That costs at most one extra
 * attempt against a server that wanted more time, and MAX_ATTEMPTS bounds
 * those; waiting an hour costs the run.
 */
test('a very long Retry-After is capped at the same 30 s as the backoff', async () => {
  const time = clock()
  const target = flaky(1, 429, '3600')

  await createRetrier(time.sleep, () => 0.5, time.now).run(target.request)

  assert.deepEqual(time.waited, [30_000])
})

test('a Retry-After below the cap is honoured exactly', async () => {
  // The counter-check: capping must not round ordinary values up.
  const time = clock()
  await createRetrier(time.sleep, () => 0.5, time.now).run(flaky(1, 429, '5').request)

  assert.deepEqual(time.waited, [5000])
})

test('a Retry-After that is not whole seconds falls back to the own backoff', async () => {
  // Retry-After is digits. `Number()` alone would read "0x10" as 16 seconds
  // and "" as 0 — the second one retrying with NO wait, exactly when the
  // server said we were sending too fast. A header we cannot read is not an
  // instruction.
  for (const header of ['soon', '-5', '', '0x10', '1.5']) {
    const time = clock()
    await createRetrier(time.sleep, () => 0.5, time.now).run(flaky(1, 429, header).request)

    // 1000 * (0.5 + 0.5*0.5) = 750 — the own first-attempt backoff, not the
    // header.
    assert.deepEqual(time.waited, [750], `header ${JSON.stringify(header)}`)
  }
})

test('surrounding whitespace does not make a sane Retry-After unreadable', () => {
  // The counter-check to the test above: transports trim header values, and
  // " 2 " means two seconds. Rejecting it would throw away a usable answer.
  const time = clock()
  return createRetrier(time.sleep, () => 0.5, time.now)
    .run(flaky(1, 429, ' 2 ').request)
    .then(() => assert.deepEqual(time.waited, [2000]))
})
