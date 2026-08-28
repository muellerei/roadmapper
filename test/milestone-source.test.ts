import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMilestoneSource } from '../src/source/gitlab/milestones.js'
import { StatusFieldMissing } from '../src/source/gitlab/translate.js'
import type { Http } from '../src/source/gitlab/client.js'
import { stateOf } from '../src/core/state.js'
import { rowsOf } from '../src/core/rows.js'
import type { CoreConfig } from '../src/core/types.js'

const cfg: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([['Flow::Doing', 'In progress']]),
  active: ['In progress'],
  blocked: [],
  closed: 'Released',
  default: 'Backlog',
}

const source = { projects: ['acme/product/app'], excludeTitles: [], includeClosed: true }

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/milestones', `${name}.json`), 'utf8'))

/** Answers the milestone query and the issue query apart, so a test can see
 *  that BOTH were sent — Milestone carries no issues field (R4). */
function httpOf(pages: { milestones: unknown[]; issues: unknown }) {
  const sent: string[] = []
  const queries: string[] = []
  let milestoneCall = 0
  const http: Http = async (_url, init) => {
    const query = JSON.parse(String(init.body)).query as string
    sent.push(query.includes('milestones(') ? 'milestones' : 'issues')
    queries.push(query)

    const answer = query.includes('milestones(')
      ? pages.milestones[Math.min(milestoneCall++, pages.milestones.length - 1)]
      : pages.issues
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { http, sent, queries }
}

const both = () => httpOf({ milestones: [fixture('page-1')], issues: fixture('issues') })

test('R4 two queries are sent, because Milestone carries no issues field', async () => {
  const stub = both()
  await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  assert.deepEqual(stub.sent, ['milestones', 'issues'])
})

test('R4 progress comes from stats, not from counting the item list', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  const release = result.bundles.find((b) => b.name === 'Release 2.0')!
  // 30/12 from stats, although only two issues came along in the fixture.
  assert.deepEqual(release.progress, { done: 12, total: 30, ratio: 0.4 })
  assert.equal(release.items.length, 2)
})

test('items are attached to the right bundle by milestone title', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  const two = result.bundles.find((b) => b.name === 'Release 2.0')!
  const one = result.bundles.find((b) => b.name === 'Release 1.9')!

  assert.deepEqual(two.items.map((i) => i.key).sort(), ['acme/product/app#41', 'acme/product/app#42'])
  assert.deepEqual(one.items.map((i) => i.key), ['acme/product/app#30'])
})

test('children stays EMPTY — a milestone holds issues, not milestones', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  for (const bundle of result.bundles) assert.deepEqual(bundle.children, [])
  // With no children there is nothing R3c could cut short.
  assert.deepEqual(result.truncated, [])
})

test('AK12 the milestone key uses % and carries the path', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  assert.equal(result.bundles[0]!.key, 'acme/product/app%3')
  // Distinct from an epic (&) and an item (#) of the same number.
  assert.notEqual(result.bundles[0]!.key, 'acme/product/app&3')
  assert.notEqual(result.bundles[0]!.key, 'acme/product/app#3')
})

test('AK13b/AK45 key_is = url composes host and webPath for a PROJECT milestone', async () => {
  const byUrl: CoreConfig = { ...cfg, keyIs: 'url' }
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', byUrl, stub.http).read(source)

  assert.equal(result.bundles[0]!.key, 'https://gitlab.example.invalid/acme/product/app/-/milestones/3')
  assert.equal(result.bundles[0]!.key.includes('//-'), false, 'no double slash')
})

test('AK13b/AK45 the same for a GROUP milestone — the path forms differ', async () => {
  const groupMilestone = fixture('page-1')
  groupMilestone.data.project.milestones.nodes[0].webPath = '/groups/acme/-/milestones/1'

  const byUrl: CoreConfig = { ...cfg, keyIs: 'url' }
  const stub = httpOf({ milestones: [groupMilestone], issues: fixture('issues') })
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', byUrl, stub.http).read(source)

  assert.equal(result.bundles[0]!.key, 'https://gitlab.example.invalid/groups/acme/-/milestones/1')
})

test('R5 pagination follows the cursor across two milestone pages', async () => {
  const first = fixture('page-1')
  first.data.project.milestones.pageInfo = { hasNextPage: true, endCursor: 'CURSOR-2' }
  const second = {
    data: {
      project: {
        milestones: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'gid://gitlab/Milestone/503',
              iid: '5',
              title: 'Release 2.1',
              description: '',
              state: 'active',
              dueDate: null,
              updatedAt: '2026-08-10T10:00:00Z',
              webPath: '/acme/product/app/-/milestones/5',
              stats: { totalIssuesCount: 2, closedIssuesCount: 0 },
            },
          ],
        },
      },
    },
  }

  const stub = httpOf({ milestones: [first, second], issues: fixture('issues') })
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  assert.equal(result.bundles.length, 3)
  assert.equal(stub.sent.filter((s) => s === 'milestones').length, 2)
})

test('the bundles drive the core: state comes out of the labels', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  const two = result.bundles.find((b) => b.name === 'Release 2.0')!
  // One open item labelled Flow::Doing, one closed -> active (table row 5).
  assert.equal(stateOf(two, cfg), 'In progress')

  const one = result.bundles.find((b) => b.name === 'Release 1.9')!
  // Closed milestone -> table row 1.
  assert.equal(stateOf(one, cfg), 'Released')
})

test('lastActivity reaches the newest issue, not just the milestone', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  // The milestone says 2026-08-01, its newest issue 2026-08-24.
  assert.deepEqual(result.bundles[0]!.lastActivity, new Date('2026-08-24T14:00:00Z'))
})

test('include_closed = false drops the closed milestone from the rows', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read({
    ...source,
    includeClosed: false,
  })

  assert.deepEqual(result.bundles.map((b) => b.name), ['Release 2.0'])
})

test('a 403 on a CONFIGURED project ends the run — it is not a foreign subgroup', async () => {
  // Section 12 gives these opposite answers, and copying AK19s skip here
  // would silently drop a project the user asked for by name.
  const http: Http = async () => new Response('forbidden', { status: 403 })

  await assert.rejects(
    () => createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, http).read(source),
    /403/,
  )
})

test('AK7j stage_source = "status" without the field aborts here too', async () => {
  const byStatus: CoreConfig = { ...cfg, stageSource: 'status', active: [] }
  const stub = both()

  await assert.rejects(
    () => createMilestoneSource('gitlab.example.invalid', 'glpat-x', byStatus, stub.http).read(source),
    StatusFieldMissing,
  )
})

test('the whole chain milestone source -> core -> rows produces writable rows', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)
  const rows = rowsOf(result, cfg, { includeClosed: true })

  // Two milestones plus their three issues.
  assert.equal(rows.length, 5)
  assert.equal(rows.filter((r) => r.level === 'bundle').length, 2)
  for (const row of rows) {
    assert.equal('iid' in row, false)
    assert.equal('webPath' in row, false)
  }
})

test('R8 no response object leaves the source', async () => {
  const stub = both()
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  const raw = JSON.stringify(result)
  for (const field of ['iid', 'webPath', 'stats', 'totalIssuesCount', 'closedIssuesCount']) {
    assert.equal(raw.includes(field), false, `${field} must not leave the source`)
  }
})

test('AK7j the status widget is ASKED FOR under stage_source = "status"', async () => {
  // Checked at the QUERY TEXT, not against a response: a test that holds
  // both settings against the same answer passes either way — and then the
  // widget is never requested, every item looks status-less, and the run
  // reports the INSTANCE as lacking a field it actually has.
  const byStatus: CoreConfig = { ...cfg, stageSource: 'status', active: [] }
  const stub = both()

  // The fixture items carry no status, so this throws — the query text it
  // sent on the way is what the assertion is about.
  await assert.rejects(() =>
    createMilestoneSource('gitlab.example.invalid', 'glpat-x', byStatus, stub.http).read(source),
  )

  const issueQuery = stub.queries.find((q) => q.includes('issues('))
  assert.ok(issueQuery !== undefined, 'the issue query was sent')
  assert.match(issueQuery, /WorkItemWidgetStatus/)
})

test('AK7j under "label" the widget stays out of the query', async () => {
  const stub = both()
  await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  const issueQuery = stub.queries.find((q) => q.includes('issues('))!
  assert.equal(/WorkItemWidgetStatus/.test(issueQuery), false)
})

test('a milestone item with a status widget is read, not reported as missing', async () => {
  const byStatus: CoreConfig = { ...cfg, stageSource: 'status', active: [] }
  const issues = fixture('issues')
  for (const node of issues.data.project.issues.nodes) {
    node.widgets = [{ status: { name: 'In review', category: 'in_progress' } }]
  }

  const stub = httpOf({ milestones: [fixture('page-1')], issues })
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', byStatus, stub.http).read(source)

  const release = result.bundles.find((b) => b.name === 'Release 2.0')!
  assert.equal(release.items[0]!.stage.categoryName, 'In review')
  assert.equal(release.items[0]!.stage.category, 'active')
})

test('R7b the shared stage rule reaches the FLAT label form of an issue', () => {
  // A milestone's issue carries its labels flat, an epic's on a widget, and
  // both go through the same rule (stageFrom). Built by hand because the
  // fixtures carry one label each, where "first scoped" and "first" agree.
  const issues = {
    data: {
      project: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              iid: '5',
              title: 'An issue',
              description: '',
              state: 'opened',
              webUrl: 'https://gitlab.example.invalid/acme/product/app/-/issues/5',
              updatedAt: '2026-08-02T00:00:00Z',
              milestone: { title: 'Release 2.0' },
              labels: { nodes: [{ title: 'wip' }, { title: 'Flow::Doing' }] },
            },
          ],
        },
      },
    },
  }
  const milestones = {
    data: {
      project: {
        milestones: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              iid: '1',
              title: 'Release 2.0',
              description: '',
              state: 'active',
              dueDate: null,
              updatedAt: '2026-08-01T00:00:00Z',
              webPath: '/acme/product/app/-/milestones/1',
              stats: { totalIssuesCount: 1, closedIssuesCount: 0 },
            },
          ],
        },
      },
    },
  }

  const stub = httpOf({ milestones: [milestones], issues })
  return createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http)
    .read(source)
    .then((result) => {
      assert.equal(result.bundles[0]!.items[0]!.stage.label, 'Flow::Doing')
      // The scoped label's prefix is named for the report; the flat one has none.
      assert.deepEqual(result.prefixes, ['Workflow'])
    })
})

/**
 * An issue list fetched for one project can hold issues from OTHER projects:
 * the query filters by milestone TITLE, and a project query reaches through to
 * a group milestone of the same name (`groupMilestoneGap`). Measured, and the
 * reason that message exists.
 *
 * Keyed by the CONFIGURED project, two different tickets numbered 10 would
 * collapse onto one Notion row and overwrite each other on every run, while
 * the run reported success — the failure `projectPathOf` is written against,
 * and the one the epic path already avoids.
 */
test('items are keyed by their OWN project, not the configured one', async () => {
  const issueNode = (project: string, iid: string) => ({
    id: `gid://gitlab/Issue/${iid}`,
    iid,
    title: `Ticket ${iid} in ${project}`,
    description: '',
    state: 'opened',
    webUrl: `https://gitlab.example.invalid/${project}/-/issues/${iid}`,
    updatedAt: '2026-08-24T14:00:00Z',
    milestone: { title: 'Release 2.0' },
    labels: { nodes: [] },
  })

  const milestones = {
    data: {
      project: {
        milestones: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              iid: '3',
              title: 'Release 2.0',
              description: '',
              state: 'active',
              dueDate: null,
              updatedAt: '2026-08-01T00:00:00Z',
              webPath: '/acme/product/app/-/milestones/3',
              stats: { totalIssuesCount: 2, closedIssuesCount: 0 },
            },
          ],
        },
      },
    },
  }
  const issues = {
    data: {
      project: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          // Same number, two projects — what a group milestone returns.
          nodes: [issueNode('acme/product/app', '10'), issueNode('acme/product/other', '10')],
        },
      },
    },
  }

  const stub = httpOf({ milestones: [milestones], issues })
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  const keys = result.bundles[0]!.items.map((i) => i.key)
  assert.deepEqual(keys, ['acme/product/app#10', 'acme/product/other#10'])
  // The point of the test: two items, two keys, no collision.
  assert.equal(new Set(keys).size, 2)
})

test('an item whose URL carries no project path is dropped and named', async () => {
  const milestones = {
    data: {
      project: {
        milestones: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              iid: '4',
              title: 'Release 3.0',
              description: '',
              state: 'active',
              dueDate: null,
              updatedAt: '2026-08-01T00:00:00Z',
              webPath: '/acme/product/app/-/milestones/4',
              stats: { totalIssuesCount: 2, closedIssuesCount: 0 },
            },
          ],
        },
      },
    },
  }
  const issues = {
    data: {
      project: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'gid://gitlab/Issue/1',
              iid: '7',
              title: 'Sound one',
              description: '',
              state: 'opened',
              webUrl: 'https://gitlab.example.invalid/acme/product/app/-/issues/7',
              updatedAt: '2026-08-24T14:00:00Z',
              milestone: { title: 'Release 3.0' },
              labels: { nodes: [] },
            },
            {
              id: 'gid://gitlab/Issue/2',
              iid: '8',
              title: 'No path in the URL',
              description: '',
              state: 'opened',
              webUrl: 'https://gitlab.example.invalid/-/issues/8',
              updatedAt: '2026-08-24T14:00:00Z',
              milestone: { title: 'Release 3.0' },
              labels: { nodes: [] },
            },
          ],
        },
      },
    },
  }

  const stub = httpOf({ milestones: [milestones], issues })
  const result = await createMilestoneSource('gitlab.example.invalid', 'glpat-x', cfg, stub.http).read(source)

  // The sound item survives — one broken item does not cost the others.
  assert.deepEqual(result.bundles[0]!.items.map((i) => i.key), ['acme/product/app#7'])
  assert.match(result.complaints[0]!.message, /no project path can be read from/)
})
