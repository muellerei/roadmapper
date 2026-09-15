import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createEpicSource } from '../src/source/gitlab/epics.js'
import { StatusFieldMissing } from '../src/source/gitlab/translate.js'
import type { Http } from '../src/source/gitlab/client.js'
import { stateOf } from '../src/core/state.js'
import { rowsOf } from '../src/core/rows.js'
import { lastActivityOf } from '../src/core/activity.js'
import type { CoreConfig } from '../src/core/types.js'

/**
 * The group integration gate for stage 4. Query, translation, prefixes and
 * filtering each passed their own fixture tests; this proves they form ONE
 * source — and it runs the actual call chain source -> core, which nothing
 * before this exercised.
 */

const cfg: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([['Flow::Doing', 'In progress']]),
  active: ['In progress'],
  blocked: ['Blocked'],
  closed: 'Released',
  default: 'Backlog',
}

const source = { group: 'acme/product', subgroups: false, excludeTitles: [], includeClosed: true }

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/epics', `${name}.json`), 'utf8'))

/** Answers each page exactly once, in order. Deliberately NOT repeating the
 *  last page: a fixture carrying hasNextPage: true would then be served
 *  forever, which GitLab never does and which would hide a paging bug behind
 *  an out-of-memory crash rather than a failed assertion. */
function httpOf(pages: unknown[]): { http: Http; sent: string[] } {
  const sent: string[] = []
  let call = 0
  const http: Http = async (_url, init) => {
    sent.push(JSON.parse(String(init.body)).query)
    const answer = pages[call]
    call += 1
    if (answer === undefined) throw new Error(`the stub was asked for page ${call}, but only ${pages.length} were given`)
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { http, sent }
}

/** page-1 reports a next page, so a test using it alone must say where
 *  paging stops. */
const lastPage = { data: { group: { workItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }

test('both fixture pages are fetched and both bundles arrive', async () => {
  const { http, sent } = httpOf([fixture('page-1'), fixture('page-2')])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  assert.equal(sent.length, 2)
  assert.deepEqual(result.bundles.map((b) => b.key), ['acme/product&7', 'acme/product&9'])
})

test('the bundles the source hands over drive the core, unchanged', async () => {
  const { http } = httpOf([fixture('page-1'), fixture('page-2')])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  const epic = result.bundles.find((b) => b.key === 'acme/product&7')!
  // One open item under a child epic, labelled Flow::Doing -> active.
  assert.equal(stateOf(epic, cfg), 'In progress')

  const finished = result.bundles.find((b) => b.key === 'acme/product&9')!
  assert.equal(stateOf(finished, cfg), 'Released')
})

test('progress comes from the rolled-up pair, complete when it leaves the source', async () => {
  const { http } = httpOf([fixture('page-1'), fixture('page-2')])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  assert.deepEqual(result.bundles[0]!.progress, { done: 1, total: 3, ratio: 1 / 3 })
  assert.deepEqual(result.bundles[1]!.progress, { done: 4, total: 4, ratio: 1 })
})

test('the key was built by the core, from the bundle path', async () => {
  const { http } = httpOf([fixture('page-1'), lastPage])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  assert.equal(result.bundles[0]!.key, 'acme/product&7')
  assert.equal(result.bundles[0]!.children[0]!.key, 'acme/product&8')
  assert.equal(result.bundles[0]!.children[0]!.items[0]!.key, 'acme/product/app#43')
})

test('lastActivity is already filled and reaches through the tree', async () => {
  const { http } = httpOf([fixture('page-1'), lastPage])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  const epic = result.bundles[0]!
  assert.deepEqual(epic.lastActivity, new Date('2026-08-24T14:00:00Z'))
  // The core agrees with what the source filled in.
  assert.deepEqual(lastActivityOf(epic), epic.lastActivity)
})

test('the prefixes and depth markers travel alongside, ready for the report', async () => {
  const { http } = httpOf([fixture('page-1'), lastPage])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  assert.deepEqual(result.prefixes, ['Flow'])
  assert.deepEqual(result.truncated, [])
  assert.deepEqual(result.complaints, [])
})

test('the whole chain source -> core -> rows produces writable rows', async () => {
  const { http } = httpOf([fixture('page-1'), fixture('page-2')])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  const rows = rowsOf(result, cfg)

  // epic 7 + its child 8 + the child's item + epic 9
  assert.equal(rows.length, 4)
  assert.equal(rows[0]!.key, 'acme/product&7')
  assert.equal(rows[0]!.level, 'bundle')
  assert.equal(rows.find((r) => r.key === 'acme/product/app#43')!.level, 'item')
  // Nothing GitLab-shaped survived into a row.
  for (const row of rows) {
    assert.equal('iid' in row, false)
    assert.equal('webUrl' in row, false)
  }
})

test('R8 no response object leaves the source', async () => {
  const { http } = httpOf([fixture('page-1'), lastPage])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source)

  const raw = JSON.stringify(result)
  for (const field of ['iid', 'webUrl', 'widgets', 'rolledUpCountsByType', 'hasChildren']) {
    assert.equal(raw.includes(field), false, `${field} must not leave the source`)
  }
})

test('AK7j stage_source = "status" against an instance without the field aborts, naming both ways out', async () => {
  const byStatus: CoreConfig = { ...cfg, stageSource: 'status', active: [] }
  const { http } = httpOf([fixture('page-1'), lastPage])

  await assert.rejects(
    () => createEpicSource('gitlab.example.invalid', 'glpat-invented', byStatus, http).read(source),
    (e: unknown) => {
      assert.ok(e instanceof StatusFieldMissing)
      assert.match(e.message, /17\.11/)
      assert.match(e.message, /stage_source = "label"/)
      return true
    },
  )
})

test('AK19 a 403 on a FOREIGN subgroup does not end the run — it is named at the end', async () => {
  const http: Http = async () => new Response('forbidden', { status: 403 })
  // Only with subgroups enabled does the query reach namespaces the token
  // may not see; that is the case AK19 is about.
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read({
    ...source,
    subgroups: true,
  })

  assert.deepEqual(result.bundles, [])
  assert.equal(result.complaints.length, 1)
  assert.match(result.complaints[0]!.message, /403/)
})

test('a 403 on the CONFIGURED group ends the run — there the 403 IS the finding', async () => {
  const http: Http = async () => new Response('forbidden', { status: 403 })
  // Without subgroups the query never leaves the configured group, so a
  // refusal can only be about that group. Section 12 gives the two cases
  // opposite answers, and treating this one as foreign would report an empty
  // roadmap every night for a group the token may not read.
  await assert.rejects(
    () => createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source),
    /403/,
  )
})

test('a refusal that is NOT a 403 still ends the run', async () => {
  const http: Http = async () =>
    new Response(JSON.stringify({ errors: [{ message: 'Recursive query - too many of fields' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  await assert.rejects(
    () => createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read(source),
    /Recursive query/,
  )
})

test('the filters reach the source result', async () => {
  const { http } = httpOf([fixture('page-1'), fixture('page-2')])
  const result = await createEpicSource('gitlab.example.invalid', 'glpat-invented', cfg, http).read({
    ...source,
    includeClosed: false,
  })

  // Epic 9 is closed and drops out; epic 7 stays.
  assert.deepEqual(result.bundles.map((b) => b.key), ['acme/product&7'])
})

// --- Stage5-2: the milestone source plugs into the same sockets ---------

import { createMilestoneSource } from '../src/source/gitlab/milestones.js'
import { progressOf } from '../src/core/progress.js'
import { bundleKeyOf } from '../src/core/key.js'

const milestoneFixture = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/milestones', `${name}.json`), 'utf8'))

function milestoneHttp(issues: unknown = milestoneFixture('issues')): Http {
  return async (_url, init) => {
    const query = JSON.parse(String(init.body)).query as string
    const answer = query.includes('milestones(') ? milestoneFixture('page-1') : issues
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

const milestoneSource = { projects: ['acme/product/app'], excludeTitles: [], includeClosed: true }

test('milestone bundles drive the same core functions as epic bundles', async () => {
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, milestoneHttp()).read(
    milestoneSource,
  )

  const release = result.bundles.find((b) => b.name === 'Release 2.0')!
  assert.equal(stateOf(release, cfg), 'In progress')
  assert.deepEqual(release.progress, progressOf(30, 12))
})

test('table row 2 is reachable for a milestone: no children AND no items', async () => {
  // With children always empty, a milestone whose issues did not come along
  // is the only way to reach "no children" — so it must work.
  const empty = { data: { project: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, milestoneHttp(empty)).read(
    milestoneSource,
  )

  const release = result.bundles.find((b) => b.name === 'Release 2.0')!
  assert.deepEqual(release.items, [])
  assert.deepEqual(release.children, [])
  // Nothing known — not "nothing done".
  assert.equal(stateOf(release, cfg), cfg.default)
  // And the progress still stands, because it comes from the stats pair.
  assert.deepEqual(release.progress, { done: 12, total: 30, ratio: 0.4 })
})

test('AK12 a milestone key never equals an epic key of the same number and path', () => {
  const ref = { path: 'acme/product', number: 3, sourcePath: '/acme/product/-/milestones/3' }
  const milestone = bundleKeyOf({ ...ref, kind: 'milestone' }, cfg)
  const epic = bundleKeyOf({ ...ref, kind: 'epic', sourcePath: null }, cfg)

  assert.equal(milestone, 'acme/product%3')
  assert.equal(epic, 'acme/product&3')
  assert.notEqual(milestone, epic)
})

test('once fetched, a bundle carries no trace of where it came from', async () => {
  const fromEpics = await createEpicSource('gitlab.example.invalid', 'glpat-x', cfg, httpOf([fixture('page-1'), lastPage]).http).read(source)
  const fromMilestones = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, milestoneHttp()).read(
    milestoneSource,
  )

  const epicBundle = fromEpics.bundles[0]!
  const milestoneBundle = fromMilestones.bundles[0]!

  // Same shape, no discriminator: the core functions below take either
  // without being told which source produced it (CONTEXT.md).
  assert.deepEqual(Object.keys(epicBundle).sort(), Object.keys(milestoneBundle).sort())

  for (const bundle of [epicBundle, milestoneBundle]) {
    assert.equal(typeof stateOf(bundle, cfg), 'string')
    assert.equal(rowsOf({ bundles: [bundle], prefixes: [], truncated: [] }, cfg)[0]!.level, 'bundle')
  }
})

test('both sources are called the same way and return the same shape', async () => {
  const fromEpics = await createEpicSource('gitlab.example.invalid', 'glpat-x', cfg, httpOf([fixture('page-1'), lastPage]).http).read(source)
  const fromMilestones = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, milestoneHttp()).read(
    milestoneSource,
  )

  // That sameness is what lets main.ts choose by [gitlab].bundle.
  assert.deepEqual(Object.keys(fromEpics).sort(), Object.keys(fromMilestones).sort())
})
