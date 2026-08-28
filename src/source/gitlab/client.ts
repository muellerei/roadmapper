import { BUNDLE_PAGE_SIZE, endpointOf } from './query.js'

/** What a GraphQL call needs. `http` is a parameter so a test can pass a
 *  stub and assert on the query TEXT that was sent (ADR-0010, R14). */
export type Http = (url: string, init: RequestInit) => Promise<Response>

/** GitLab answered, but with errors in the body — GraphQL returns 200 for
 *  those, so a status check alone would let them through. */
export class GitLabRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitLabRejected'
  }
}

/**
 * GitLab ran out of its own execution budget — about 30 seconds — rather than
 * refusing the query.
 *
 * It is worth telling apart because it is the one refusal a SMALLER QUESTION
 * can answer: a malformed field stays malformed however little is asked for,
 * but a page that was too heavy can be halved (ADR-0023).
 *
 * The answer arrives as HTTP 200 with `data` PRESENT and null nodes scattered
 * through it (measured 2026-08-26: 8 of 40 nodes null, with nothing naming
 * which bundles they were). That partial body is never used — a roadmap with
 * holes, published as a whole one, is the failure this tool is written
 * against.
 */
class GitLabTimedOut extends GitLabRejected {
  constructor(message: string) {
    super(message)
    this.name = 'GitLabTimedOut'
  }
}

/**
 * A GraphQL caller for one host and token.
 *
 * Pagination lives here, with the rest of GitLab's quirks: 100 per page, a
 * cursor, until `hasNextPage` is false (R5).
 */
export function createGitLabClient(host: string, token: string, http: Http = fetch) {
  const endpoint = endpointOf(host)

  async function once(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await http(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
    } catch (cause) {
      // Node's own message for an unreachable host is "fetch failed" — true
      // and useless. Whoever reads it in a cron mail needs to know WHICH
      // host was not reachable, because that is usually a typo in
      // [gitlab].host or a network the machine cannot leave.
      throw new GitLabRejected(
        `Could not reach GitLab at ${endpoint}.\n` +
          `Check [gitlab].host and that this machine can reach it.\n` +
          `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }

    if (!response.ok) {
      // 403 on a foreign subgroup is not fatal — the caller decides whether
      // to carry on (R19/AK19); everything else is reported as it stands.
      throw new GitLabRejected(`GitLab answered ${response.status} for ${endpoint}.`)
    }

    const body = (await response.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] }
    if (body.errors !== undefined && body.errors.length > 0) {
      // GraphQL answers 200 even when it refuses — a status check alone
      // would pass this through as an empty result.
      const messages = body.errors.map((e) => e.message)
      if (messages.some((m) => /^Timeout on /.test(m))) {
        throw new GitLabTimedOut(`GitLab refused the query: ${messages.join('; ')}`)
      }
      throw new GitLabRejected(`GitLab refused the query: ${messages.join('; ')}`)
    }
    if (body.data === undefined) throw new GitLabRejected('GitLab returned no data.')
    return body.data
  }

  return {
    /** One call, no paging. */
    query: once,

    /**
     * Follow the cursor until the last page. `pageOf` points at the
     * connection inside the response, because only the caller knows where it
     * sits in its own query.
     *
     * `query` may be a builder taking a page size. Given one, a timed-out page
     * is asked again HALF THE SIZE from the SAME cursor, until it fits or the
     * page is down to a single bundle (ADR-0023). Given a plain string there is
     * no size to lower, and the timeout is reported like any other refusal —
     * which is what the milestone sources pass.
     */
    async all(
      query: string | ((bundles: number) => string),
      variables: Record<string, unknown>,
      pageOf: (data: Record<string, unknown>) => { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null,
    ): Promise<unknown[]> {
      const nodes: unknown[] = []
      let after: string | null = null
      // Whatever made one page too heavy — a busy server, or bundles that are
      // simply fat — holds for the rest of the run, so a size that worked is
      // KEPT rather than raised again. Going back up would spend another 30
      // seconds finding out the same thing on the next page.
      let size = BUNDLE_PAGE_SIZE

      for (;;) {
        let data: Record<string, unknown>
        for (;;) {
          try {
            data = await once(typeof query === 'string' ? query : query(size), { ...variables, after })
            break
          } catch (cause) {
            if (!(cause instanceof GitLabTimedOut) || typeof query === 'string') throw cause
            if (size <= 1) {
              // Below one bundle per page there is nothing left to halve, and
              // the finding has changed: it is no longer "too many bundles at
              // once" but "this one bundle is too big for GitLab to answer
              // about". Naming a size the reader cannot lower would be an
              // instruction they cannot follow.
              throw new GitLabRejected(
                `GitLab timed out reading one bundle at a time.\n` +
                  `A single bundle is too large for the source to answer about — not the page size.\n` +
                  `Cause: ${cause.message}`,
              )
            }
            size = Math.max(1, Math.floor(size / 2))
          }
        }

        const page = pageOf(data)
        if (page === null) break

        nodes.push(...page.nodes)
        if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) break
        after = page.pageInfo.endCursor
      }

      return nodes
    },

    endpoint,
  }
}

export type GitLabClient = ReturnType<typeof createGitLabClient>
