import { createGitLabClient, type Http } from './client.js'
import { prefixOf } from '../../core/label.js'
import { categoryOf, type Complaint } from './translate.js'
import type { StatusCategory } from '../../core/types.js'

/**
 * What both stage sources actually look like in one group — the numbers
 * `init` puts side by side so choosing `stage_source` rests on a measurement
 * rather than on a guess (R27b).
 *
 * PRESENT and MAINTAINED fall apart here, and only a human knows which
 * counts. A status field can be 100 % filled with the default value nobody
 * ever touched, while the labels carry the real state.
 */
export type Survey = {
  /** The work steps the top-level group DEFINES, already translated to core
   *  words — GitLab's own field name for these stays inside this file
   *  (ADR-0003). */
  defined: { name: string; category: StatusCategory | null }[]
  /** The scoped-label prefixes present in the group. */
  prefixes: string[]
  /** How the sampled issues are actually filled. */
  sample: {
    issues: number
    byStatus: { value: string; count: number }[]
    byLabel: { value: string; count: number }[]
  }
  complaints: Complaint[]
}

/** Statuses hang off the TOP-LEVEL group (18.1): subgroups inherit them and
 *  Project does not carry the field at all (checked 2026-08-24). */
const SURVEY_QUERY = `
query Survey($group: ID!) {
  group(fullPath: $group) {
    statuses { name category }
    labels(first: 100) { nodes { title } }
    workItems(types: [ISSUE], first: 20, state: OPEN) {
      nodes {
        widgets {
          ... on WorkItemWidgetLabels { labels { nodes { title } } }
          ... on WorkItemWidgetStatus { status { name category } }
        }
      }
    }
  }
}`

/**
 * Ask the group what it has. Read-only and best effort: an instance without
 * the status field answers with an error for that part, and `init` still has
 * something useful to show — the point is the comparison, not completeness.
 */
export function createSurveySource(host: string, token: string, http: Http = fetch) {
  const client = createGitLabClient(host, token, http)

  return {
    async survey(group: string): Promise<Survey> {
      const complaints: Complaint[] = []
      const data = (await client.query(SURVEY_QUERY, { group })) as { group?: WireGroup }
      const found = data.group

      const defined = (found?.statuses ?? []).map((entry) => ({
        name: entry.name,
        category: categoryOf(entry.category, complaints),
      }))

      const prefixes = [...new Set((found?.labels?.nodes ?? []).map((l) => prefixOf(l.title)).filter((p) => p !== ''))]

      const issues = found?.workItems?.nodes ?? []
      const statusValues: string[] = []
      const labelValues: string[] = []
      for (const issue of issues) {
        const widgets = issue.widgets ?? []
        const status = widgets.find((w) => w.status !== undefined)?.status
        if (status !== undefined) statusValues.push(status.name)
        for (const label of widgets.flatMap((w) => w.labels?.nodes ?? [])) {
          if (label.title.includes('::')) labelValues.push(label.title)
        }
      }

      return {
        defined,
        prefixes,
        sample: { issues: issues.length, byStatus: countOf(statusValues), byLabel: countOf(labelValues) },
        complaints,
      }
    },
  }
}

export type SurveySource = ReturnType<typeof createSurveySource>

/** Descending, so the reader sees at a glance whether everything sits on one
 *  value — which is exactly what a fill rate would hide. */
function countOf(values: readonly string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

type WireGroup = {
  statuses?: { name: string; category: string }[]
  labels?: { nodes: { title: string }[] }
  workItems?: {
    nodes: {
      widgets?: { labels?: { nodes: { title: string }[] }; status?: { name: string; category: string } }[]
    }[]
  }
}
