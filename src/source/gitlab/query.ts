/**
 * The GraphQL query for `bundle = "epic"`, against `group.workItems`.
 *
 * Everything GitLab-shaped lives in this directory and nowhere else: field
 * names, pagination, complexity limits and the quirks below (ADR-0003).
 */

/** GitLab caps a page at 100 and the query complexity at 250 (R5, R6). This is
 *  the CHILD page, which is always asked for in full: children are fetched to
 *  the end (ADR-0022), and a smaller bite here would drop them silently. */
export const PAGE_SIZE = 100

/**
 * How many BUNDLES one page asks for, to begin with.
 *
 * Not GitLab's maximum, and deliberately so. The cost of this query is driven
 * by how many CHILDREN arrive in one answer, not by how many bundles were
 * requested, and GitLab gives a query about 30 seconds. Measured 2026-08-26
 * against a real group of 51 epics (1091 children, median 10 per epic, four
 * epics over 100):
 *
 *     size=20   0 of 3 attempts completed — every one hit the wall at ~31s
 *     size=10   3 of 3 completed, 6 requests, 58-68s
 *     size=5    3 of 3 completed, 11 requests, 60-68s
 *
 * Ten is the largest size measured to hold. Five is no faster despite twice
 * the requests — the time is server work, not round trips — so the smaller
 * number buys nothing, while ten leaves room to halve (10, 5, 2, 1) when a
 * group turns out heavier than this one (ADR-0023).
 *
 * NOT configurable: it adjusts itself downwards on a timeout, which is what a
 * setting would have been for.
 */
export const BUNDLE_PAGE_SIZE = 10

/**
 * The fragments both queries read a node with.
 *
 * Shared rather than written twice: the follow-up for an overflowing child
 * list (`childrenQuery`) must read a child EXACTLY as the main query does,
 * or a bundle would carry two kinds of item depending on which page it
 * arrived on. Two copies drift; one cannot.
 */
const FRAGMENTS = `
fragment nodeFields on WorkItem {
  # The GLOBAL id, as the follow-up for an overflowing child list needs it:
  # workItem(id:) takes this, never the iid, which is only unique per
  # namespace. Selected on every level because any bundle can overflow.
  id
  iid
  # What KIND of work item this is — the field that tells a child bundle from
  # an item (R3d). Read as a NAME, and that is a decision with two measured
  # reasons: WorkItem carries no type enum at all (asking for a bare "type"
  # field is refused as non-existent), and workItemType.id is
  # a per-instance number (WorkItems::Type/8 on gitlab.com) that a
  # self-hosted instance may number differently. The name is stable and NOT
  # localised: measured 2026-08-25 under an Accept-Language: de-DE header, it
  # still reads "Epic".
  workItemType { name }
  # The bundle's OWN namespace, not the configured one. With
  # includeDescendants the answer spans several subgroups, and epic numbers
  # restart per namespace — number 59 exists in two subgroups of gitlab-org
  # (measured). Keying on the configured group would give both the same key,
  # so one Notion row would hold two epics and each run would overwrite the
  # other (section 5, property 1).
  namespace { fullPath }
  title
  description
  state
  webUrl
  updatedAt
}

fragment bundleWidgets on WorkItemWidget {
  ... on WorkItemWidgetStartAndDueDate { dueDate }
  # A scoped label arrives as ONE string ("Flow::Doing") and is passed on
  # WHOLE — the [status] table is keyed by the full label (R7).
  ... on WorkItemWidgetLabels { labels { nodes { title } } }
  # Truncation is recognised by hasChildren on the last queried level, by
  # THAT FIELD ALONE. Do not additionally test for an empty children list:
  # where children is queried it is never empty when hasChildren is true, and
  # where it is not queried the list is absent rather than empty (measured
  # across 145 child nodes: zero hits for the conjunction, nine for
  # hasChildren alone). Do not use depthLimitReachedByType either — it is a
  # list per work item type and measures whether a child of that type may be
  # CREATED, not whether the answer was cut short.
  ... on WorkItemWidgetHierarchy {
    hasChildren
    # EXPERIMENTAL, GitLab 17.3+. Progress is counted from this rollup and
    # never from a recursive children walk — GitLab totals the whole subtree
    # here in one field (ADR-0015). This is the place to look when progress
    # one day goes missing. It hangs off the WIDGET, not off the work item:
    # asking for it on WorkItem fails with "Field doesn't exist on type
    # 'WorkItem'" (measured 2026-08-25).
    rolledUpCountsByType { workItemType { name } countsByState { all closed } }
  }
  # EXPERIMENTAL, GitLab 17.3+, same class as the counts above. Measured
  # unmaintained in practice (0 of 20 epics in gitlab-org carry one), which
  # is why the health column is optional rather than assumed.
  ... on WorkItemWidgetHealthStatus {
    rolledUpHealthStatus { healthStatus count }
  }
}

fragment itemWidgets on WorkItemWidget {
  ... on WorkItemWidgetHierarchy {
    children(first: ${PAGE_SIZE}) {
      pageInfo { hasNextPage endCursor }
      nodes { ...nodeFields }
    }
  }
}
`.trim()

/**
 * Build the epic query.
 *
 * `subgroups` is a SWITCH on `includeDescendants`, not a filter applied
 * afterwards. `group.workItems` returns only the group's own epics; the
 * subgroups come along only with the argument set (measured 2026-08-24:
 * gitlab-org one namespace without it, ten with it). Filtering after the
 * fact could only ever filter what already arrived — and whoever builds it
 * that way does not notice, because `subgroups = false` is then accidentally
 * right while `subgroups = true` quietly returns too little (R2a).
 *
 * `withStatus` adds the status widget only under `stageSource = "status"`.
 * Under 'label' it stays out: it would not be evaluated anyway, and the
 * complexity budget of R6 is tight.
 */
export function epicQuery(subgroups: boolean, withStatus: boolean, bundles: number = BUNDLE_PAGE_SIZE): string {
  return `
query Epics($group: ID!, $after: String) {
  group(fullPath: $group) {
    workItems(
      types: [EPIC]
      first: ${bundles}
      after: $after${subgroups ? '\n      includeDescendants: true' : ''}
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ...nodeFields
        # ONE widgets block per level. GitLab counts the nesting of WIDGETS,
        # not of children: two levels pass, the third aborts with
        # "Recursive query - too many of fields {widgets=>3}" (measured
        # 2026-08-25 against gitlab.com, on this very query). So the level
        # below opens its own widgets block rather than nesting one inside a
        # fragment that already opened one.
        widgets {
          ...bundleWidgets
          ... on WorkItemWidgetHierarchy {
            children(first: ${PAGE_SIZE}) {
              # WITHOUT this the tail is invisible: GitLab caps the connection
              # at 100 and a full page looks exactly like a complete one.
              # Measured 2026-08-26 against a real group, four of 51 epics
              # overflowed, one returning 100 of its 205 children — silently,
              # costing that bundle its items, its sub-bundles, its state and
              # its activity (roadmapper-sp7).
              pageInfo { hasNextPage endCursor }
              nodes {
                ...nodeFields
                widgets {
                  ...bundleWidgets
                  ...itemWidgets${withStatus ? '\n                  ...statusWidget' : ''}
                }
              }
            }
          }
        }
      }
    }
  }
}

${FRAGMENTS}
${
  withStatus
    ? `
fragment statusWidget on WorkItemWidget {
  # EXPERIMENTAL, GitLab 17.11+. Measured unfilled on epics (0/15 in
  # gitlab-org, 0/15 in gitlab-com) and filled on issues (20/20) — this is
  # the place to look when every state suddenly reads as the default value.
  #
  # The schema reports the category enum in CAPITALS (TRIAGE, IN_PROGRESS)
  # but the wire carries it lowercase ("triage", "in_progress"). Reading the
  # schema instead of a real response produces a switch that never matches.
  ... on WorkItemWidgetStatus { status { name category } }
}
`
    : ''
}`.trim()
}

/**
 * The follow-up for ONE bundle whose child list did not fit on a page.
 *
 * GitLab caps `children` at 100 per page and offers no way to raise it, so a
 * bundle with more descendants than that needs asking again — addressed by
 * its global id, carrying the cursor the previous page returned.
 *
 * Measured 2026-08-26 against a real group: four of 51 epics overflowed, the
 * largest holding 205 direct children. Untreated, that bundle loses its
 * items, any sub-bundle past position 100 together with its whole subtree,
 * and — because both are derived from the child list — its state and its
 * activity (roadmapper-sp7). Progress survives regardless: it comes from
 * GitLab's own rollup over the subtree, never from this list (ADR-0015).
 *
 * It reads a child through the SAME fragments as the main query. A child
 * fetched here must be indistinguishable from one that arrived on the first
 * page, or a bundle would carry two kinds of item depending on where they sat.
 */
export function childrenQuery(withStatus: boolean): string {
  return `
query BundleChildren($id: WorkItemID!, $after: String) {
  workItem(id: $id) {
    widgets {
      ... on WorkItemWidgetHierarchy {
        children(first: ${PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ...nodeFields
            widgets {
              ...bundleWidgets
              ...itemWidgets${withStatus ? '\n              ...statusWidget' : ''}
            }
          }
        }
      }
    }
  }
}

${FRAGMENTS}
${
    withStatus
      ? `
fragment statusWidget on WorkItemWidget {
  ... on WorkItemWidgetStatus { status { name category } }
}
`
      : ''
  }`.trim()
}

/** The API endpoint, built from the bare host (R2b).
 *
 *  Written down although it sounds obvious: nobody violates a requirement by
 *  hardwiring the endpoint, and against gitlab.com it never shows. A
 *  self-hosted instance is the only case where it breaks — and the one case
 *  nobody tests who does not have one. */
export function endpointOf(host: string): string {
  return `https://${host}/api/graphql`
}
