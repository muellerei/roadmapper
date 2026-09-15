import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outcomeOf, emptyOutcome } from '../src/report/outcome.js'
import type { Row } from '../src/core/types.js'
import type { WriteResult } from '../src/output/notion/write.js'

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    level: 'bundle' as const,
    key: `acme/product&${i + 1}`,
    number: i + 1,
    name: `Bundle ${i + 1}`,
    state: 'In progress',
    closed: false,
    progress: { done: 1, total: 2, ratio: 0.5 },
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/1',
    due: null,
    activity: new Date('2026-08-01T00:00:00Z'),
    health: null,
    description: '',
    items: [],
  }))
}

const wrote = (over: Partial<WriteResult> = {}): WriteResult => ({
  created: 0,
  updated: 0,
  duplicates: [],
  failures: [],
  unusable: [],
  ...over,
})

test('AK25 one failure among thirty keeps EXIT 0, and the row is named', () => {
  const outcome = outcomeOf(
    rows(30),
    wrote({ created: 29, failures: [{ key: 'acme/product&7', reason: 'Property "Status" not found' }] }),
    [],
  )

  // The tool runs in cron: exit != 0 here would mean a failure mail every
  // night although 29 of 30 rows were written.
  assert.equal(outcome.exitCode, 0)
  assert.match(outcome.summary, /29 created/)
  assert.ok(outcome.problems.some((p) => p.includes('acme/product&7') && p.includes('skipped')))
})

test('AK48 EVERY row failing inverts it: exit != 0, naming the first reason', () => {
  const failures = rows(30).map((r) => ({ key: r.key, reason: '403 restricted_resource' }))
  const outcome = outcomeOf(rows(30), wrote({ failures }), [])

  // Nothing was written, so "the run did not happen" is literally true.
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.summary, '')
  const message = outcome.problems.join('\n')
  assert.match(message, /0 of 30 rows written/)
  assert.match(message, /403 restricted_resource/)
  // The most common cause is a rights problem, and the message says so with
  // the click path rather than leaving the user to guess.
  assert.match(message, /rights problem/)
  assert.match(message, /Connections/)
  assert.match(message, /Can edit/)
})

test('AK48 counter-check: one of thirty still exits 0', () => {
  const outcome = outcomeOf(rows(30), wrote({ created: 29, failures: [{ key: 'x', reason: 'boom' }] }), [])
  assert.equal(outcome.exitCode, 0)
})

test('a fully successful run reports what it did', () => {
  const outcome = outcomeOf(rows(30), wrote({ created: 12, updated: 18 }), [])

  assert.equal(outcome.exitCode, 0)
  assert.match(outcome.summary, /12 created, 18 updated, 0 skipped/)
  assert.deepEqual(outcome.problems, [])
})

test('an updated-only run does not read as "nothing written"', () => {
  // 0 created but 30 updated is a perfectly normal second run.
  const outcome = outcomeOf(rows(30), wrote({ updated: 30 }), [])
  assert.equal(outcome.exitCode, 0)
})

test('AK20 no bundles is a gap, not an error — exit 0 and where to look', () => {
  const outcome = emptyOutcome(['Flow'])

  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.summary, '')
  const message = outcome.problems.join('\n')
  assert.match(message, /No bundles found/)
  assert.match(message, /Nothing was written/)
  assert.match(message, /Flow/)
})

test('AK20 with nothing to name it says what it can and no more', () => {
  const message = emptyOutcome([]).problems.join('\n')
  assert.match(message, /No bundles found/)
  // No issue count: getting one needs a second query on a run that already
  // found nothing, and the number is not actionable (decided 2026-08-25).
  assert.equal(/open issue/.test(message), false)
  assert.match(message, /No scoped labels were found/)
})

test('EC4 a duplicate key is named, and nothing is deleted for it', () => {
  const outcome = outcomeOf(rows(1), wrote({ updated: 1, duplicates: ['acme/product&7'] }), [])

  assert.equal(outcome.exitCode, 0)
  const message = outcome.problems.join('\n')
  assert.match(message, /"acme\/product&7" is in the target more than once/)
  assert.match(message, /nothing is ever deleted/)
})

test('R3c truncated bundles are named, and the report says progress is unaffected', () => {
  const outcome = outcomeOf(rows(2), wrote({ created: 2 }), ['acme/product&7', 'acme/product&8'])

  assert.equal(outcome.exitCode, 0)
  const message = outcome.problems.join('\n')
  assert.match(message, /2 bundle\(s\) nest deeper/)
  assert.match(message, /progress is still complete/)
})

test('an empty run — no rows at all — is not treated as "every row failed"', () => {
  // Zero attempted is not zero succeeded out of something.
  const outcome = outcomeOf([], wrote(), [])
  assert.equal(outcome.exitCode, 0)
})

test('EC10 a row whose progress could not be obtained is written, with the column EMPTY', () => {
  // Not 0 %: a bundle nobody could count reads as "nothing known", never as
  // "nothing done" (ADR-0015). The row itself is written all the same.
  const withoutProgress = rows(1).map((r) => ({ ...r, progress: null }))
  const outcome = outcomeOf(withoutProgress, wrote({ created: 1 }), [])

  assert.equal(outcome.exitCode, 0)
  assert.match(outcome.summary, /1 created/)

  // And the gap is NAMED. Writing the row while saying nothing would leave an
  // empty column that reads like a statement — EC10 asks for the cause, with
  // the minimum version, so nobody has to search the source for it.
  assert.equal(outcome.problems.length, 1)
  assert.match(outcome.problems[0]!, /Progress unavailable for 1 bundle\(s\)/)
  assert.match(outcome.problems[0]!, /experimental/)
  assert.match(outcome.problems[0]!, /17\.3\+/)
})

test('EC10 the count is over bundles — an item row carries no progress by design', () => {
  // Every item row has progress null (section 4b). Counting those would report
  // a gap on a perfectly healthy run.
  const bundle = { ...rows(1)[0]!, level: 'bundle' as const, progress: { done: 1, total: 2, ratio: 0.5 } }
  const item = { ...rows(1)[0]!, level: 'item' as const, progress: null }

  const outcome = outcomeOf([bundle, item], wrote({ created: 2 }), [])

  assert.deepEqual(outcome.problems, [])
})

// --- Run-3: the fill rate ------------------------------------------------

import { fillOf, renderFill } from '../src/report/fill.js'
import type { CoreConfig } from '../src/core/types.js'

const byLabel: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([['Flow::Doing', 'In progress']]),
  active: ['In progress'],
  blocked: [],
  closed: 'Released',
  default: 'To do',
}

const COLUMNS = { key: 'GitLab ID', name: 'Feature', state: 'Status', progress: 'Progress', health: 'Health' }
const carried = new Set(Object.values(COLUMNS))

/** `set` rows carry a real state, the rest sit on the default. */
function stated(total: number, set: number, value = 'In progress'): Row[] {
  return rows(total).map((row, i) => ({ ...row, state: i < set ? value : byLabel.default }))
}

test('AK23 every written column gets a filled/total line', () => {
  const report = fillOf(stated(30, 2), byLabel, COLUMNS, carried, ['Flow'])

  const status = report.columns.find((c) => c.column === 'Status')!
  // AK23 verbatim: 30 bundles, `state` set on two of them -> `state 2/30`.
  // A row on the default carries a value, and that value is what "nothing was
  // found here" looks like — counting it as filled would put the rate at
  // 30/30 on a board where 28 rows say nothing.
  assert.equal(status.filled, 2)
  assert.equal(status.total, 30)

  const progress = report.columns.find((c) => c.column === 'Progress')!
  assert.equal(progress.filled, 30)

  // health is null on every row here.
  const health = report.columns.find((c) => c.column === 'Health')!
  assert.equal(health.filled, 0)
})

test('EC6 a column skipped for its type reads 0, with the skip as its note', () => {
  // The board HAS the column and the rows HAVE values, but nothing was
  // written into it. Counting the values would state the source data while
  // claiming the target — the one failure the fill rate exists against.
  const report = fillOf(stated(30, 2), byLabel, COLUMNS, carried, ['Flow'], [
    { role: 'progress', column: 'Progress', type: 'rich_text', wanted: ['number'] },
  ])

  const progress = report.columns.find((c) => c.column === 'Progress')!
  assert.equal(progress.filled, 0)
  assert.equal(progress.total, 30)
  assert.match(progress.note!, /rich_text/)

  // The line STAYS: a column vanishing from the report is itself a silence.
  assert.ok(report.columns.some((c) => c.column === 'Progress'))
  // Every other column is untouched by the skip.
  assert.equal(report.columns.find((c) => c.column === 'Status')!.filled, 2)
})

test('a column the target does not carry gets no line at all', () => {
  const report = fillOf(stated(30, 2), byLabel, COLUMNS, new Set(['GitLab ID', 'Feature']), [])
  assert.deepEqual(report.columns.map((c) => c.column), ['GitLab ID', 'Feature'])
})

test('the state line ALWAYS names the source, under both settings', () => {
  const fromLabels = fillOf(stated(10, 5), byLabel, COLUMNS, carried, ['Flow'])
  assert.match(fromLabels.columns.find((c) => c.column === 'Status')!.note!, /from labels/)

  const byStatus: CoreConfig = { ...byLabel, stageSource: 'status', active: [] }
  const fromField = fillOf(stated(10, 5), byStatus, COLUMNS, carried, [])
  assert.match(fromField.columns.find((c) => c.column === 'Status')!.note!, /status field/)
})

test('the state line carries the distribution, descending — a rate alone deceives', () => {
  // 28 on the default, 2 in progress: 30/30 filled would look healthy.
  const report = fillOf(stated(30, 2), byLabel, COLUMNS, carried, ['Flow'])
  const note = report.columns.find((c) => c.column === 'Status')!.note!

  assert.match(note, /28x To do, 2x In progress/)
})

test('AK24 a majority on the default names the prefixes actually found', () => {
  const report = fillOf(stated(30, 2), byLabel, COLUMNS, carried, ['Stage', 'Rank'])

  const hint = report.hints.join('\n')
  assert.match(hint, /28 of 30 rows fell to "To do"/)
  assert.match(hint, /maps "Flow"/)
  assert.match(hint, /Found in source: Stage, Rank/)
  assert.match(hint, /Adjust \[status\], or drop the state column/)
})

test('a case-only mismatch is diagnosed as such — labels are case-sensitive', () => {
  // Measured against a real group: two spellings of one prefix differing
  // only in case are two different labels, one empty and one oversized.
  const report = fillOf(stated(30, 0), byLabel, COLUMNS, carried, ['flow'])

  const hint = report.hints.join('\n')
  assert.match(hint, /differ only in CASE/)
  assert.match(hint, /"Flow" vs "flow"/)
  assert.match(hint, /case-sensitive/)
})

test('under stage_source = "status" the hint points at the status field, not at labels', () => {
  const byStatus: CoreConfig = { ...byLabel, stageSource: 'status', active: [] }
  const report = fillOf(stated(30, 1), byStatus, COLUMNS, carried, [])

  const hint = report.hints.join('\n')
  assert.match(hint, /status field/)
  assert.match(hint, /stage_source = "label"/)
  assert.equal(/\[status\] table maps/.test(hint), false)
})

test('a healthy state column produces no hint at all', () => {
  const report = fillOf(stated(30, 28), byLabel, COLUMNS, carried, ['Flow'])
  assert.deepEqual(report.hints, [])
})

test('a zero-filled column says what caused it', () => {
  const report = fillOf(stated(10, 5), byLabel, COLUMNS, carried, ['Flow'])
  assert.match(report.columns.find((c) => c.column === 'Health')!.note!, /not maintained in GitLab/)
})

test('the rendered report reads as the spec writes it', () => {
  const text = renderFill(fillOf(stated(30, 2), byLabel, COLUMNS, carried, ['Stage']))

  assert.match(text, /^30 bundles, 0 items written\./m)
  // `state 2/30`, verbatim from section 12 — 28 rows fell to the default and
  // that is the opposite of filled. The distribution beside it says what they
  // fell to, which is what makes the rate readable rather than alarming.
  assert.match(text, /Status\s+2\/30\s+\(from labels; 28x To do, 2x In progress\)/)
  assert.match(text, /Health\s+0\/30\s+\(field not maintained in GitLab\)/)
})

test('no rows at all produces no hint and no division by zero', () => {
  const report = fillOf([], byLabel, COLUMNS, carried, [])
  assert.deepEqual(report.hints, [])
  assert.equal(report.bundles, 0)
})

test('section 12: what the source could not reach is NAMED at the end', () => {
  // A 403 on a foreign subgroup is skipped and the run stands (exit 0) — but
  // "skip" is only half the rule: the other half is naming it. Collected and
  // never reported would be the silent failure the error table exists
  // against.
  const outcome = outcomeOf(rows(2), wrote({ created: 2 }), [], [
    { message: 'GitLab answered 403 for https://gitlab.example.invalid/api/graphql.' },
  ])

  assert.equal(outcome.exitCode, 0)
  assert.match(outcome.problems.join('\n'), /403/)
})

test('an empty result explains itself with the refusal that caused it', () => {
  const outcome = emptyOutcome([], [{ message: 'GitLab answered 403 for a subgroup.' }])

  assert.equal(outcome.exitCode, 0)
  // The refusal comes first: it is the answer to "why is this empty".
  assert.match(outcome.problems[0]!, /403/)
  assert.match(outcome.problems.join('\n'), /No bundles found/)
})

test('unknown GitLab values reach the report too', () => {
  const outcome = outcomeOf(rows(1), wrote({ created: 1 }), [], [
    { message: 'GitLab sent an unknown status category: "in_review_by_robot".' },
  ])

  assert.match(outcome.problems.join('\n'), /in_review_by_robot/)
})

/**
 * EC5 — a target without a `type` column takes bundles only. Not a failure:
 * a table that cannot tell the levels apart carries one kind, and on roadmap
 * altitude that is the bundle level. But it is item rows the run did not
 * write, and section 12 asks for what was skipped — silence would let a board
 * look complete while every item is missing from it.
 */
test('item rows the target could not take are named, and the run still stands', () => {
  const outcome = outcomeOf(rows(3), wrote({ created: 3 }), [], [], 210)

  assert.equal(outcome.exitCode, 0)
  assert.match(outcome.summary, /3 created/)
  assert.ok(outcome.problems.some((p) => /210 item row\(s\) were not written/.test(p)))
  assert.ok(outcome.problems.some((p) => /no type column/.test(p)))
})

test('a target that carries the type column reports no skipped items', () => {
  const outcome = outcomeOf(rows(3), wrote({ created: 3 }), [], [], 0)

  assert.equal(outcome.problems.filter((p) => /item row/.test(p)).length, 0)
})

/**
 * A column at zero per cent says WHY, and that sentence needs a test of its
 * own for each role that carries one.
 *
 * Verified by mutation: with the `due` and `progress` branches returning null
 * the whole suite stayed green — only `health` was ever checked. An empty
 * column without its reason is exactly what section 12 is written against:
 * every decision behind it is right on its own, and their sum is a board that
 * says nothing while the run reports success.
 */
test('a due column nobody fills says so', () => {
  const columns = { ...COLUMNS, due: 'Target date' }
  const carriedWithDue = new Set(Object.values(columns))
  const report = fillOf(rows(30), byLabel, columns, carriedWithDue, [])

  const due = report.columns.find((c) => c.column === 'Target date')!
  assert.equal(due.filled, 0)
  assert.equal(due.note, 'no bundle carries a date in GitLab')
})

test('a progress column GitLab could not count says so', () => {
  const withoutProgress = rows(30).map((r) => ({ ...r, progress: null }))
  const report = fillOf(withoutProgress, byLabel, COLUMNS, carried, [])

  const progress = report.columns.find((c) => c.column === 'Progress')!
  assert.equal(progress.filled, 0)
  assert.equal(progress.note, 'GitLab returned no counts')
})

test('a column that IS filled carries no reason — the note explains absence only', () => {
  // The counter-check: the sentence appears because the column is empty, not
  // because the role has one.
  const columns = { ...COLUMNS, due: 'Target date' }
  const dated = rows(30).map((r) => ({ ...r, due: new Date('2026-12-01T00:00:00Z') }))
  const report = fillOf(dated, byLabel, columns, new Set(Object.values(columns)), [])

  const due = report.columns.find((c) => c.column === 'Target date')!
  assert.equal(due.filled, 30)
  assert.equal(due.note, null)
  assert.equal(report.columns.find((c) => c.column === 'Progress')!.note, null)
})

/**
 * Section 12 once gave "the instance carries no epics (edition)" its own row
 * with exit != 0, beside "the source returned no bundle" with exit 0. The two
 * cannot be told apart: epics are a GitLab Premium feature, and a Free
 * instance answers `workItems(types: [EPIC])` with an EMPTY LIST, not an
 * error — so no code can decide which row applies (ADR-0020).
 *
 * The way out the row wanted is worth having all the same, so it is a
 * SENTENCE rather than an exit code: the run did happen, it found nothing,
 * and the report says where to look. Exit 1 here would mail a cron failure
 * every night for a group that is simply empty.
 */
test('an empty epic run names the Premium cause and the way out, at exit 0', () => {
  const outcome = emptyOutcome(['Stage'], [], { bundle: 'epic', group: 'acme/product', subgroups: false })

  assert.equal(outcome.exitCode, 0)
  const message = outcome.problems.join('\n')
  assert.match(message, /No bundles found/)
  assert.match(message, /Premium feature/)
  assert.match(message, /bundle = "milestone"/)
  // With subgroups off, the other possible cause is named too.
  assert.match(message, /subgroups = true/)
})

test('with subgroups on, the answer IS the whole tree and says so', () => {
  const message = emptyOutcome([], [], { bundle: 'epic', group: 'acme/product', subgroups: true }).problems.join('\n')

  assert.match(message, /whole tree/)
  assert.equal(/set subgroups = true/.test(message), false)
})

test('a milestone run gets no epic advice — it would send the reader nowhere', () => {
  const message = emptyOutcome(['Stage'], [], { bundle: 'milestone', group: '', subgroups: false }).problems.join('\n')

  assert.match(message, /No bundles found/)
  assert.equal(/Premium/.test(message), false)
})

test('without the source detail the message is what it always was', () => {
  // The parameter is optional: every existing caller keeps its output.
  const message = emptyOutcome(['Stage']).problems.join('\n')
  assert.match(message, /No bundles found/)
  assert.equal(/Premium/.test(message), false)
})
