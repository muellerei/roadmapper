import type { Row } from '../core/types.js'
import type { WriteResult } from '../output/notion/write.js'
import { quote, noEpics, notionReadOnly } from '../messages.js'

/**
 * What a finished run says and what it exits with.
 *
 * This is not one regime but a DISTINCTION: abort where the error IS the
 * finding, carry on where it is foreign.
 *
 * The tool runs in cron, and that is what makes the exit code matter. One
 * broken epic must not stop the other 29 rows — exit != 0 there would mean a
 * failure mail every night although 29 of 30 rows were written, which trains
 * people to ignore the mails, and then the one mail reporting a real abort
 * goes under.
 *
 * **Exit != 0 means "the run did not happen", not "something in the run was
 * ugly."** What was ugly goes in the report, and the report gets read
 * because it does not arrive every night.
 */
export type Outcome = {
  exitCode: 0 | 1
  /** Goes to stdout: what the run did. */
  summary: string
  /** Goes to stderr: what it could not do. */
  problems: string[]
}

/**
 * The one case that inverts the rule: if EVERY row failed, nothing was
 * written and "it did not happen" is literally true.
 *
 * The most common cause is not a data problem but a rights problem — an
 * integration connected to the database but allowed only to read. The schema
 * reads fine, every pre-check passes, and only the write fails. With per-row
 * skipping and exit 0 the tool would run in cron every night, apparently
 * successfully, and never write anything.
 */
export function outcomeOf(
  rows: readonly Row[],
  written: WriteResult,
  truncated: readonly string[],
  /** What the source could not translate or could not reach — a 403 on a
   *  foreign subgroup, an unknown GitLab enum value. None of these stop the
   *  run, and all of them must be NAMED at the end (section 12); collecting
   *  them without reporting would be the silent failure the whole error
   *  table is written against. */
  complaints: readonly { message: string }[] = [],
  /** Item rows the target could not take because it carries no `type` column
   *  (EC5). Not a failure — a table that cannot tell the levels apart holds
   *  one kind — but it is 200 rows the run did not write, and section 12 asks
   *  for what was skipped. Silence here would let a board look complete while
   *  every item is missing from it. */
  skippedItems = 0,
): Outcome {
  const problems: string[] = [...complaints.map((c) => c.message)]
  const attempted = rows.length
  const succeeded = written.created + written.updated

  // EC6 — a column the target carries under a type this role cannot be
  // written into. Named BEFORE the per-row failures: it explains a column
  // that stayed empty across the whole board, which is a bigger finding than
  // a single skipped row.
  for (const column of written.unusable) {
    problems.push(
      `Column ${quote(column.column)} is a ${column.type} column, which cannot hold ${quote(column.role)} — ` +
        `it takes ${column.wanted.map(quote).join(' or ')}.\n` +
        `The column was left out and everything else was written. Change the column's type\n` +
        `in Notion, or drop ${quote(column.role)} from [columns].`,
    )
  }

  for (const duplicate of written.duplicates) {
    problems.push(
      `The key ${quote(duplicate)} is in the target more than once. The first row was ` +
        `updated and the others were left alone — nothing is ever deleted (R21).`,
    )
  }

  // EC10 — the rollup field is missing or has changed. Two causes, one
  // answer: GitLab < 17.3 does not have it, and being experimental it can be
  // renamed or disappear. `progress` stays empty (ADR-0015 — no fallback to
  // counting direct children, a number that quietly means something narrower
  // is worse than none), and the report names the cause so nobody has to
  // search the source for it. Counted over BUNDLES only: an item row carries
  // no progress by definition (section 4b), and counting those would report a
  // gap where there is none.
  const withoutProgress = rows.filter((row) => row.level === 'bundle' && row.progress === null).length
  if (withoutProgress > 0) {
    problems.push(
      `Progress unavailable for ${withoutProgress} bundle(s): GitLab returned no rolled-up\n` +
        `counts. The field is experimental and may have changed (requires GitLab 17.3+).`,
    )
  }

  if (skippedItems > 0) {
    problems.push(
      `${skippedItems} item row(s) were not written: the target carries no type column,\n` +
        `so it holds bundles only (EC5). Add the column named in [columns].type to get\n` +
        `item rows as well.`,
    )
  }

  if (truncated.length > 0) {
    problems.push(
      `${truncated.length} bundle(s) nest deeper than the state could follow: ${truncated.join(', ')}.\n` +
        `Their progress is still complete (GitLab rolls it up); only "which step is it in"\n` +
        `stops one level down.`,
    )
  }

  if (attempted > 0 && succeeded === 0) {
    const first = written.failures[0]
    return {
      exitCode: 1,
      summary: '',
      problems: [
        ...problems,
        `0 of ${attempted} rows written — every write failed.\n` +
          (first === undefined ? '' : `First error: ${first.reason}\n`) +
          notionReadOnly(),
      ],
    }
  }

  // A skipped row keeps exit 0 — the row is named, the run stands.
  for (const failure of written.failures) {
    problems.push(`${failure.key} was skipped: ${failure.reason}`)
  }

  return {
    exitCode: 0,
    summary: `${written.created} created, ${written.updated} updated, ${written.failures.length} skipped.\n`,
    problems,
  }
}

/**
 * No bundles at all is a GAP, not an error: the run did happen, it just found
 * nothing to write. So exit 0 — and a sentence that says where to look
 * instead of an empty success (AK20, ADR-0002).
 *
 * ADR-0002 once wrote this message with a count ("47 open issues, none
 * assigned to a milestone"). The count is deliberately NOT given: getting it
 * needs a second query for issues, on a run that already established there is
 * nothing to sync — and a number nobody can act on adds no more than the
 * prefixes below, which say where to look. Decided 2026-08-25.
 */
export function emptyOutcome(
  prefixes: readonly string[],
  complaints: readonly { message: string }[] = [],
  /** What the run was asked to read, and — for epics — whether subgroups were
   *  included. Present only to name the one cause that cannot be READ off an
   *  empty answer: epics are a GitLab Premium feature, and a Free instance
   *  answers `workItems(types: [EPIC])` with an empty list rather than an
   *  error. Section 12 once gave that its own row with exit != 0; it cannot
   *  have one, because nothing distinguishes it from a group that genuinely
   *  holds no epics. So it is a sentence, not an exit code — see
   *  ADR-0020. */
  source?: { bundle: 'epic' | 'milestone'; group: string; subgroups: boolean },
): Outcome {
  const found =
    prefixes.length === 0
      ? '\nNo scoped labels were found in the source either.'
      : `\nScoped label prefixes found in the source: ${prefixes.join(', ')}.`

  return {
    exitCode: 0,
    summary: '',
    // The complaints come FIRST: when the source returned nothing because a
    // subgroup was refused, that refusal is the answer to "why is it empty".
    problems: [
      ...complaints.map((c) => c.message),
      `No bundles found. Nothing was written.${found}`,
      ...(source?.bundle === 'epic' ? [noEpics(source.group, source.subgroups)] : []),
    ],
  }
}
