import { quote } from '../messages.js'
import { prefixOf } from '../core/label.js'
import type { CoreConfig } from '../core/types.js'
import type { Survey } from '../source/gitlab/survey.js'

/**
 * Put both stage sources side by side, so choosing `stage_source` rests on
 * numbers instead of a guess (R27b).
 *
 * THE SAMPLE IS THE POINT, not the definition. Five defined statuses say
 * nothing about whether anybody uses them; a distribution sitting entirely
 * on the default says everything. That is the same reason the closing report
 * shows a distribution rather than a fill rate.
 */
export function compareSources(survey: Survey, cfg: CoreConfig): string {
  const lines: string[] = []

  const defined = survey.defined.length
  lines.push(
    `Status field: ${defined === 0 ? 'not available on this instance' : `${defined} statuses defined`}`,
  )
  lines.push(`Scoped label prefixes: ${survey.prefixes.length === 0 ? '(none found)' : survey.prefixes.join(', ')}`)

  if (survey.sample.issues === 0) {
    lines.push('No open issues to sample — nothing to compare yet.')
    return lines.join('\n')
  }

  lines.push(`Sampled ${survey.sample.issues} open issues:`)
  lines.push(`  status field  ${distribution(survey.sample.byStatus)}`)
  lines.push(`  labels        ${distribution(survey.sample.byLabel)}`)

  const advice = adviceOf(survey, cfg)
  if (advice !== null) lines.push('', advice)

  return lines.join('\n')
}

/**
 * Name what fits, and say why — but decide nothing. The tool does not know
 * which of the two a team maintains; it only knows what the numbers show
 * (ADR-0006).
 */
function adviceOf(survey: Survey, cfg: CoreConfig): string | null {
  const status = survey.sample.byStatus
  const labels = survey.sample.byLabel

  // R27a comes FIRST, because it is the only advice that says what to DO.
  // "label fits this group" is useless while the configured prefix matches
  // nothing in it — the reader would set a source that still yields nothing.
  const unmatched = missingPrefixesOf(survey, cfg)
  if (unmatched !== null) return unmatched

  // One value across the whole sample means the field is present but nobody
  // has made a decision in it.
  const statusOnOneValue = status.length === 1 && status[0]!.count === survey.sample.issues
  const labelsSpread = labels.length > 1

  if (statusOnOneValue && labelsSpread) {
    return (
      `→ "label" fits this group: the status field sits entirely on ${quote(status[0]!.value)},\n` +
      `  while the labels carry ${labels.length} different values. Set stage_source = "status"\n` +
      `  only after the status field carries your workflow.`
    )
  }

  if (status.length === 0 && labelsSpread) {
    return `→ "label" fits this group: no sampled issue carries a status, the labels do.`
  }

  if (labels.length === 0 && status.length > 0) {
    return `→ "status" fits this group: no sampled issue carries a scoped label, the status field does.`
  }

  return null
}

/**
 * R27a — suggest instead of guess. When the configured prefix matches
 * nothing in the group, name the prefixes that ARE there and leave the
 * decision to the human. Nothing is guessed, nothing is written; naming what
 * stands in the source is not supplying project content (ADR-0006).
 */
function missingPrefixesOf(survey: Survey, cfg: CoreConfig): string | null {
  if (cfg.stageSource !== 'label' || survey.prefixes.length === 0) return null

  const wanted = [...new Set([...cfg.statusMap.keys()].map(prefixOf))].filter((p) => p !== '')
  const missing = wanted.filter((want) => !survey.prefixes.includes(want))
  if (missing.length === 0) return null

  return (
    `→ No label matches ${missing.map(quote).join(', ')}.\n` +
    `  Scoped labels found in the group: ${survey.prefixes.join(', ')}\n` +
    `  Adjust [status], or drop the state column.`
  )
}

function distribution(counts: readonly { value: string; count: number }[]): string {
  if (counts.length === 0) return '(nothing filled)'
  const rendered = counts.map((c) => `${c.count}x ${c.value}`).join(', ')
  // A single value across the sample is the finding, so it is said aloud.
  return counts.length === 1 ? `${rendered}   (all on one value)` : rendered
}
