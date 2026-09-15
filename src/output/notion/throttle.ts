/**
 * Self-throttling and retry against Notion's documented limits. Not
 * configurable (ADR-0005) — every number below is Notion's own, looked up in
 * its request-limits reference, not inherited from the predecessor:
 *
 *   rate        3 requests/second on average, bursts allowed
 *   exceeded    429
 *   overload    529 (service_overload)
 *   Retry-After whole SECONDS, honoured but capped at 30 s like the backoff
 *   backoff     exponential with jitter, capped at 30 s
 *   attempts    at most 6, then give up
 */
const MAX_ATTEMPTS = 6
const CAP_MS = 30_000
const BASE_MS = 1_000

/**
 * The smallest gap between two requests: 3 per second is Notion's documented
 * average, so 1000/3 ms is the pace that stays under it.
 *
 * Measured 2026-08-25 from a laptop against a real workspace, 25 rows and 50
 * requests took 31 s — 1.6 requests/second, no 429 at all. So on THAT path
 * this gap never fires, and it costs that run nothing.
 *
 * It is here for the paths not measured, and they are the likelier ones: a
 * server near Notion's region does 60-80 ms round trips rather than ~600, so
 * the same code reaches 12-15 requests/second; and an UPDATE costs more
 * requests per row than the create measured here (query, update, list
 * blocks, delete each, append).
 *
 * The asymmetry decides it: waiting 333 ms costs nothing on a run that was
 * already slower, while one 429 costs the Retry-After the server names —
 * seconds — plus the wasted attempt. A pacer that never fires is free; a
 * retry that fires is not.
 */
const MIN_GAP_MS = Math.ceil(1000 / 3)

/** How long a request waits before its Nth retry, when the server named no
 *  interval of its own. */
function backoffOf(attempt: number, random: () => number): number {
  const grown = Math.min(BASE_MS * 2 ** (attempt - 1), CAP_MS)
  // Jitter, so a burst of rows that failed together does not come back in
  // lockstep and fail together again.
  return Math.round(grown * (0.5 + random() * 0.5))
}

/** The two temporary answers, treated the SAME: both allow the same retry
 *  path. Only the message distinguishes them, so the report can say whether
 *  we were too fast or Notion was overloaded. */
function temporaryOf(error: unknown): { status: number; retryAfter: number | null } | null {
  const status = (error as { status?: unknown })?.status
  if (status !== 429 && status !== 529) return null

  // Retry-After is in whole seconds — DIGITS, and nothing else. `Number()`
  // alone accepts shapes the HTTP spec does not: "0x10" reads as 16 seconds,
  // " 2 " as 2, and the empty string as 0 — which would retry with no wait at
  // all, exactly when the server said we were too fast. A header we cannot
  // read is not an instruction; the own backoff applies instead.
  const headers = (error as { headers?: unknown }).headers
  const raw = headerOf(headers, 'retry-after')
  if (raw === null || !/^\d+$/.test(raw.trim())) return { status, retryAfter: null }
  const seconds = Number(raw.trim())

  // Capped at the SAME 30 s the own backoff uses. The server's interval is
  // the better answer to "how long", not a licence to hold the process for
  // as long as it likes: this runs in cron, and a `retry-after: 3600` would
  // park one run for an hour while the next one starts beside it. Beyond
  // 2^31-1 ms setTimeout fires IMMEDIATELY rather than late (Node's own
  // overflow behaviour), so an uncapped wait does not even fail safely — it
  // inverts into no wait at all.
  //
  // Capping costs at most an extra attempt against a server that wanted more
  // time, and MAX_ATTEMPTS bounds those. Waiting an hour costs the run.
  return { status, retryAfter: Math.min(seconds * 1000, CAP_MS) }
}

function headerOf(headers: unknown, name: string): string | null {
  if (headers == null) return null
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name)
  const record = headers as Record<string, unknown>
  const hit = record[name] ?? record[name.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase())]
  return typeof hit === 'string' ? hit : null
}

/** Raised when a request kept failing. The caller skips that row and names
 *  it in the report — the run is NOT aborted (section 12, exit 0). */
export class NotionUnavailable extends Error {
  readonly status: number

  constructor(status: number, attempts: number) {
    super(
      status === 429
        ? `Notion refused ${attempts} attempts because we were sending too fast (429).`
        : `Notion was overloaded for ${attempts} attempts (529, service_overload).`,
    )
    this.name = 'NotionUnavailable'
    this.status = status
  }
}

/**
 * Wrap one request so it retries on a temporary refusal.
 *
 * `sleep` and `random` are parameters rather than built in (R14, ADR-0010):
 * in production they are setTimeout and Math.random, in a test a clock the
 * test advances and a sequence it controls. Otherwise these paths would cost
 * real seconds, and a test that waits gets skipped eventually.
 */
export function createRetrier(
  sleep: (ms: number) => Promise<void>,
  random: () => number = Math.random,
  /** Reads the clock. A parameter so a test can drive the pacing without
   *  spending real time, the same reason `sleep` is one. */
  now: () => number = Date.now,
) {
  // The last request's finish time. Closed over rather than module-level, so
  // two targets never share a pace — no module-level state (ADR-0010).
  let previous = 0

  /** Wait out whatever is left of the minimum gap, if anything. */
  async function pace(): Promise<void> {
    const since = now() - previous
    if (previous !== 0 && since < MIN_GAP_MS) await sleep(MIN_GAP_MS - since)
    previous = now()
  }

  return {
    async run<T>(request: () => Promise<T>): Promise<T> {
      let last: { status: number } | null = null

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          await pace()
          return await request()
        } catch (error) {
          const temporary = temporaryOf(error)
          if (temporary === null) throw error
          last = temporary

          if (attempt === MAX_ATTEMPTS) break
          // On the FIRST failure Retry-After applies when the server set it;
          // the own backoff only kicks in from the second. Choosing an
          // interval where the server named one would be guessing where an
          // answer exists.
          const wait =
            attempt === 1 && temporary.retryAfter !== null ? temporary.retryAfter : backoffOf(attempt, random)
          await sleep(wait)
        }
      }

      throw new NotionUnavailable(last!.status, MAX_ATTEMPTS)
    },
  }
}

export type Retrier = ReturnType<typeof createRetrier>

/** Production sleep. Kept here so main.ts wires one obvious thing. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
