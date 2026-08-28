import { lastActivityOf } from '../../core/activity.js'
import { bundleKeyOf, itemKeyOf } from '../../core/key.js'
import { progressOf } from '../../core/progress.js'
import type { Bundle, CoreConfig, Item, SourceResult } from '../../core/types.js'
import { createGitLabClient, type Http } from './client.js'
import { filterBundles, type Filters } from './filter.js'
import { PAGE_SIZE } from './query.js'
import { complain, projectPathOf, stageFrom, UnusableItemUrl, type Complaint } from './translate.js'

/** What the run needs to read milestones. */
export type MilestoneSourceConfig = { projects: readonly string[] } & Filters

export type MilestoneResult = SourceResult & { complaints: Complaint[] }

/**
 * Milestones per project.
 *
 * TWO queries, because `Milestone` carries no `issues` field in GraphQL (R4):
 * the milestones and their counts come first, the issues after, per project.
 */
const MILESTONES = `
query Milestones($project: ID!, $after: String) {
  project(fullPath: $project) {
    milestones(first: ${PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid
        title
        description
        state
        dueDate
        updatedAt
        # The path WITHOUT the host — the host comes from [gitlab].host, so
        # the URL form of the key is composed from two known parts rather
        # than guessed (section 5).
        webPath
        # Progress comes from HERE, not from counting the item list: this is
        # what GitLab offers for a milestone (R4).
        stats { totalIssuesCount closedIssuesCount }
      }
    }
  }
}`

/** The status widget is asked for ONLY under stage_source = "status" — the
 *  same rule the epic query follows (R6a), and for the same reason: it would
 *  not be evaluated otherwise, and the complexity budget is tight.
 *
 *  Asking for it never would be worse than wasteful: the translation would
 *  then find no status on any item and report the INSTANCE as lacking the
 *  field (EC7b), advising an upgrade that changes nothing. */
const issuesQuery = (withStatus: boolean) => `
query MilestoneIssues($project: ID!, $titles: [String!], $after: String) {
  project(fullPath: $project) {
    issues(milestoneTitle: $titles, first: ${PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid
        title
        description
        state
        webUrl
        updatedAt
        milestone { title }
        labels { nodes { title } }${
          withStatus
            ? `
        # EXPERIMENTAL, GitLab 17.11+. The wire carries the category
        # lowercase although the schema reports it in capitals — see the
        # mapping in translate.ts.
        widgets { ... on WorkItemWidgetStatus { status { name category } } }`
            : ''
        }
      }
    }
  }
}`

/**
 * The milestone source.
 *
 * A milestone holds issues, never other milestones, so `children` stays
 * EMPTY for every bundle here — and with it the depth signal of R3c, which
 * has nothing to measure.
 */
export function createMilestoneSource(host: string, token: string, cfg: CoreConfig, http: Http = fetch) {
  const client = createGitLabClient(host, token, http)

  return {
    async read(source: MilestoneSourceConfig): Promise<MilestoneResult> {
      const complaints: Complaint[] = []
      const prefixes = new Set<string>()
      const bundles: Bundle[] = []

      for (const project of source.projects) {
        // A 403 on a CONFIGURED project is NOT a foreign subgroup: here the
        // 403 IS the finding, and the run aborts (section 12). Copying the
        // skip behaviour of AK19 into this loop would silently drop a
        // project the user asked for by name.
        const milestones = (await client.all(MILESTONES, { project }, (data) => {
          const found = (data as { project?: { milestones?: Page } }).project
          return found?.milestones ?? null
        })) as WireMilestone[]

        if (milestones.length === 0) continue

        const issues = (await client.all(
          issuesQuery(cfg.stageSource === 'status'),
          { project, titles: milestones.map((m) => m.title) },
          (data) => {
            const found = (data as { project?: { issues?: Page } }).project
            return found?.issues ?? null
          },
        )) as WireIssue[]

        // Grouped once, not filtered per milestone: the issue list is the sum
        // over ALL milestones of the project (they are fetched in one query
        // above), so filtering inside the loop walks the whole list once per
        // milestone.
        const byMilestone = new Map<string, WireIssue[]>()
        for (const issue of issues) {
          const title = issue.milestone?.title
          if (title === undefined) continue
          const bucket = byMilestone.get(title)
          if (bucket === undefined) byMilestone.set(title, [issue])
          else bucket.push(issue)
        }

        for (const milestone of milestones) {
          bundles.push(
            bundleFrom(milestone, project, byMilestone.get(milestone.title) ?? [], cfg, prefixes, complaints),
          )
        }
      }

      return {
        bundles: filterBundles(bundles, source),
        prefixes: [...prefixes],
        // A milestone has no children, so nothing can be cut short (R3c).
        truncated: [],
        complaints,
      }
    },
  }
}

export type MilestoneSource = ReturnType<typeof createMilestoneSource>

function bundleFrom(
  milestone: WireMilestone,
  project: string,
  /** This milestone's issues, already grouped by the caller. */
  mine: readonly WireIssue[],
  cfg: CoreConfig,
  prefixes: Set<string>,
  complaints: Complaint[],
): Bundle {
  const number = Number(milestone.iid)
  const key = bundleKeyOf(
    // `%` is not allowed in GitLab paths and is therefore collision-free —
    // a milestone with `&` would clash with an epic of the same number in
    // the same group (section 5). The path travels as sourcePath, so
    // GitLab's field name for it never reaches the core (R12a).
    { path: project, number, kind: 'milestone', sourcePath: milestone.webPath },
    cfg,
  )

  // One unusable item does not cost the milestone its other rows — a broken
  // single item must not stop the run (section 12). Dropped and named, never
  // given a made-up key. The same handling the epic path applies, for the
  // same error out of the same function.
  const items: Item[] = []
  for (const issue of mine) {
    try {
      items.push(itemFrom(issue, key, cfg, prefixes, complaints))
    } catch (error) {
      if (!(error instanceof UnusableItemUrl)) throw error
      complain(complaints, error.message)
    }
  }

  const stats = milestone.stats

  const bundle: Bundle = {
    key,
    number,
    name: milestone.title,
    description: milestone.description ?? '',
    closed: milestone.state === 'closed',
    due: milestone.dueDate === null || milestone.dueDate === undefined ? null : new Date(milestone.dueDate),
    url: `https://${cfg.host.replace(/\/+$/, '')}${milestone.webPath}`,
    // From the counts GitLab supplies, never from counting `items` — with
    // include_closed = false the item list would be the wrong denominator
    // (EC3), and a milestone whose issues were not all fetched would report
    // a quiet undercount.
    progress: stats === null || stats === undefined ? null : progressOf(stats.totalIssuesCount, stats.closedIssuesCount),
    lastActivity: new Date(milestone.updatedAt),
    // Milestones carry no health field in GitLab.
    health: null,
    items,
    // A milestone holds issues, not milestones.
    children: [],
  }

  // The rollup rule lives in core and is called here rather than rebuilt
  // (R12). `children` is always empty for a milestone, but the rule is not
  // re-derived from that — it is applied, so the two sources cannot drift.
  bundle.lastActivity = lastActivityOf(bundle)

  return bundle
}

function itemFrom(
  issue: WireIssue,
  bundleKey: string,
  cfg: CoreConfig,
  prefixes: Set<string>,
  complaints: Complaint[],
): Item {
  // An issue of a milestone carries its labels FLAT, while an epic's arrive
  // on a widget — so the extraction is here and the rule is shared.
  const labels = (issue.labels?.nodes ?? []).map((l) => l.title)
  const status = (issue.widgets ?? []).find((w) => w.status !== undefined)?.status
  const stage = stageFrom(labels, status, cfg, prefixes, complaints)

  const number = Number(issue.iid)
  return {
    // The path of the ISSUE, not the configured project. An issue list
    // fetched for a project can hold issues from sibling projects: the query
    // filters by milestone TITLE, and a project query reaches through to a
    // group milestone of the same name (`groupMilestoneGap`). Keyed by the
    // configured path, two different tickets numbered 10 would share one
    // Notion row and overwrite each other every run — the failure
    // `projectPathOf` is written against, and the epic path already avoids.
    key: itemKeyOf(projectPathOf(issue.webUrl), number, cfg),
    number,
    title: issue.title,
    description: issue.description ?? '',
    closed: issue.state === 'closed',
    stage,
    url: issue.webUrl,
    bundle: bundleKey,
    updatedAt: new Date(issue.updatedAt),
    health: null,
  }
}

type Page = { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

type WireMilestone = {
  iid: string
  title: string
  description: string | null
  state: string
  dueDate: string | null
  updatedAt: string
  webPath: string
  stats: { totalIssuesCount: number; closedIssuesCount: number } | null
}

type WireIssue = {
  iid: string
  title: string
  description: string | null
  state: string
  webUrl: string
  updatedAt: string
  milestone: { title: string } | null
  labels?: { nodes: { title: string }[] }
  widgets?: { status?: { name: string; category: string } }[]
}
