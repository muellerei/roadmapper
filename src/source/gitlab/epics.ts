import type { CoreConfig, SourceResult } from '../../core/types.js'
import { createGitLabClient, GitLabRejected, type GitLabClient, type Http } from './client.js'
import { filterBundles, type Filters } from './filter.js'
import { childrenQuery, epicQuery } from './query.js'
import { translateEpics, type Complaint } from './translate.js'

/** What the run needs to read epics. `http` is a parameter so the tests pass
 *  a stub and can assert on the query text (ADR-0010, R14). */
export type EpicSourceConfig = {
  group: string
  subgroups: boolean
} & Filters

/** A source returns bundles plus what the report needs — and, beyond the
 *  seam type, whatever it could not translate. */
export type EpicResult = SourceResult & { complaints: Complaint[] }

/**
 * The epic source: query, paginate, translate, filter.
 *
 * Everything GitLab-shaped stops here (ADR-0003, R8). What leaves are
 * bundles as `src/core/types.ts` defines them, already complete — key,
 * progress, lastActivity and health filled (section 4b).
 */
export function createEpicSource(host: string, token: string, cfg: CoreConfig, http: Http = fetch) {
  const client = createGitLabClient(host, token, http)

  return {
    async read(source: EpicSourceConfig): Promise<EpicResult> {
      // A BUILDER, not a finished string: the client lowers the page size and
      // asks again when GitLab times out, and it can only do that if it can
      // rebuild the query (ADR-0023).
      const query = (bundles: number) => epicQuery(source.subgroups, cfg.stageSource === 'status', bundles)

      let nodes: unknown[]
      try {
        nodes = await client.all(query, { group: source.group }, (data) => {
          const group = (data as { group?: { workItems?: unknown } }).group
          return (group?.workItems as EpicPage | undefined) ?? null
        })
      } catch (cause) {
        // A 403 has TWO meanings, and section 12 gives them opposite answers:
        //
        //   on a FOREIGN SUBGROUP  -> skip it, name it at the end, exit 0
        //   on the CONFIGURED group -> abort, because here the 403 IS the
        //                              finding (exit != 0)
        //
        // Which one it is follows from `subgroups`: without it the query
        // never reaches a namespace other than the configured one, so a
        // refusal can only be about that group. Treating every 403 as
        // foreign would make `roadmapper` report an empty roadmap for a
        // group the token simply may not read — silently, and every night.
        if (cause instanceof GitLabRejected && /403/.test(cause.message) && source.subgroups) {
          return { bundles: [], prefixes: [], truncated: [], complaints: [{ message: cause.message }] }
        }
        throw cause
      }

      // Before translating: fetch the tail of any child list GitLab cut off.
      // This happens on the WIRE SHAPE, while the cursor is still in reach —
      // once translated, a bundle is a domain object with no memory of which
      // page its children arrived on (R8).
      await completeChildren(nodes, client, cfg.stageSource === 'status')

      const translated = translateEpics(nodes, source.group, cfg)

      return {
        // Filtering happens AFTER translation, so it works on the domain
        // words rather than on GitLab's.
        bundles: filterBundles(translated.bundles, source),
        prefixes: translated.prefixes,
        truncated: translated.truncated,
        complaints: translated.complaints,
      }
    },
  }
}

/** A child connection as it arrives, before anything is translated. */
type WireChildren = { pageInfo?: { hasNextPage: boolean; endCursor: string | null } | undefined; nodes: WireChild[] }
type WireChild = { id?: string; widgets?: { children?: WireChildren }[] }

/**
 * Fetch what did not fit.
 *
 * GitLab caps a child connection at 100 and cannot be asked for more, so a
 * bundle with more descendants arrives cut short — and a full page looks
 * exactly like a complete one. `pageInfo` is the only thing that tells them
 * apart, which is why the query asks for it (roadmapper-sp7).
 *
 * The tail is appended IN PLACE, so the translator downstream sees one whole
 * list and needs to know nothing about paging. The cost falls only where the
 * overflow is: a bundle that fits asks nothing (measured 2026-08-26 on a real
 * group, 47 of 51 epics fit and 4 needed 9 requests between them).
 *
 * Recursive, because a bundle fetched here can overflow in turn — a sub-epic
 * with 150 items of its own is no different from its parent.
 */
async function completeChildren(nodes: readonly unknown[], client: GitLabClient, withStatus: boolean): Promise<void> {
  const query = childrenQuery(withStatus)

  async function walk(node: WireChild): Promise<void> {
    const widget = (node.widgets ?? []).find((w) => w.children !== undefined)
    const children = widget?.children
    if (children === undefined) return

    // The id is what addresses one work item. Without it the tail cannot be
    // asked for, and dropping the bundle silently is the very failure this
    // function exists against — so it is named and the run carries on with
    // the short list.
    // `pageInfo` absent means the question was not asked, which is not the
    // same as "no more pages" — but it is all this function can act on, and
    // guessing a cursor is worse than stopping. Every query in this directory
    // selects it; a response without it comes from a stub or an instance that
    // answered something else, and neither is a reason to crash a whole run.
    while (children.pageInfo?.hasNextPage === true && children.pageInfo.endCursor !== null && node.id !== undefined) {
      const data = await client.query(query, { id: node.id, after: children.pageInfo.endCursor })
      const page = pageOfChildren(data)
      if (page === null) break

      children.nodes.push(...page.nodes)
      children.pageInfo = page.pageInfo
    }

    // Depth first, and AFTER the parent's own list is whole: a child that
    // arrived with the tail can overflow just as the first hundred can.
    for (const child of children.nodes) await walk(child)
  }

  for (const node of nodes) await walk(node as WireChild)
}

/** Where the follow-up puts its answer. Only the caller knows the shape of
 *  its own query, so the reach into the response lives beside it. */
function pageOfChildren(data: Record<string, unknown>): WireChildren | null {
  const item = (data as { workItem?: { widgets?: { children?: WireChildren }[] } }).workItem
  return (item?.widgets ?? []).find((w) => w.children !== undefined)?.children ?? null
}

export type EpicSource = ReturnType<typeof createEpicSource>

type EpicPage = { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
