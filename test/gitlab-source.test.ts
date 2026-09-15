import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { epicQuery, endpointOf } from '../src/source/gitlab/query.js'
import { createGitLabClient, GitLabRejected, type Http } from '../src/source/gitlab/client.js'

/** Records every request so a test can assert on the QUERY TEXT that was
 *  sent, not just on the answer it got back. That distinction is the whole
 *  point of AK46a. */
function httpStub(responses: unknown[]) {
  const sent: { url: string; query: string; variables: Record<string, unknown> }[] = []
  let call = 0

  const http: Http = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
    sent.push({ url, query: body.query, variables: body.variables })
    // Each response is served ONCE. Repeating the last one would serve a
    // fixture carrying hasNextPage: true forever — GitLab never does that,
    // and a paging bug would surface as an out-of-memory crash instead of a
    // failed assertion.
    const answer = responses[call]
    call += 1
    if (answer === undefined) throw new Error(`the stub was asked for page ${call}, but only ${responses.length} were given`)
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  return { http, sent }
}

/** Fixtures live beside the SOURCE test file. tsc copies no JSON into dist,
 *  so a path relative to this module would point into the build — resolve
 *  from the repository root instead, which holds wherever the tests run. */
const fixturePath = (name: string) => resolve(process.cwd(), 'test/fixtures/epics', `${name}.json`)
const fixture = (name: string) => JSON.parse(readFileSync(fixturePath(name), 'utf8'))

const pageOf = (data: any) => data.group?.workItems ?? null

test('AK49 the endpoint is built from the bare host', () => {
  assert.equal(endpointOf('gitlab.com'), 'https://gitlab.com/api/graphql')
  assert.equal(endpointOf('gitlab.example.com'), 'https://gitlab.example.com/api/graphql')
})

test('AK46a subgroups = true sets includeDescendants ON THE QUERY', () => {
  // Asserted against the query text, not against the response: a test that
  // holds both settings against the same answer passes either way, even when
  // the code filters afterwards — and then subgroups = true silently returns
  // too little.
  assert.match(epicQuery(true, false), /includeDescendants:\s*true/)
})

test('AK46a subgroups = false omits the argument entirely', () => {
  // Read the SELECTIONS, not the whole text: a comment may name the argument
  // while explaining it, and the query is what the assertion is about.
  const selections = epicQuery(false, false)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

  assert.equal(/includeDescendants/.test(selections), false)
})

test('R6a the status widget is in the query only under stage_source = "status"', () => {
  const withStatus = epicQuery(false, true)
  assert.match(withStatus, /WorkItemWidgetStatus/)
  assert.match(withStatus, /status \{ name category \}/)

  const withoutStatus = epicQuery(false, false)
  assert.equal(/WorkItemWidgetStatus/.test(withoutStatus), false)
})

test('R3 the rolled-up counts and health are always asked for', () => {
  const query = epicQuery(false, false)
  assert.match(query, /rolledUpCountsByType/)
  assert.match(query, /rolledUpHealthStatus/)
})

test('R3c hasChildren is queried, and the rejected signal is not selected', () => {
  const query = epicQuery(false, false)
  assert.match(query, /hasChildren/)

  // depthLimitReachedByType measures something else entirely and must not be
  // SELECTED. It is named in a comment explaining why — so the check reads
  // the selections rather than the whole text, which a plain substring test
  // would fail on the explanation itself.
  const selections = query
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  assert.equal(/depthLimitReachedByType/.test(selections), false)
})

test('R6 the query stays well inside the 10,000 character limit', () => {
  for (const query of [epicQuery(false, false), epicQuery(true, true)]) {
    assert.ok(query.length < 10_000, `query is ${query.length} characters`)
  }
})

test('R5 pagination follows the cursor until hasNextPage is false', async () => {
  const stub = httpStub([fixture('page-1'), fixture('page-2')])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  const nodes = await client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf)

  assert.equal(stub.sent.length, 2)
  // The first call carries no cursor, the second the one the first returned.
  assert.equal(stub.sent[0]!.variables['after'], null)
  assert.equal(stub.sent[1]!.variables['after'], 'CURSOR-PAGE-2')
  assert.equal(nodes.length, 2)
})

test('R5 both pages arrive as complete trees, not just as a count', async () => {
  // The paging test above counts nodes; this one holds the CONTENT of both
  // pages. A concatenation bug that drops the children of page one would keep
  // the count right and the trees wrong.
  const stub = httpStub([fixture('page-1'), fixture('page-2')])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  const nodes = await client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf)
  const { bundles } = translateEpics(nodes, 'acme/product', byLabel)

  assert.deepEqual(bundles.map((b) => b.key), ['acme/product&7', 'acme/product&9'])
  // Page one carries a sub-epic with an item of its own; page two carries none.
  assert.equal(bundles[0]!.children[0]!.items[0]!.key, 'acme/product/app#43')
  assert.deepEqual(bundles[1]!.children, [])
})

test('R5 a single page stops after one call', async () => {
  const stub = httpStub([fixture('page-2')])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  const nodes = await client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf)

  assert.equal(stub.sent.length, 1)
  assert.equal(nodes.length, 1)
})

test('the request carries the token and goes to the built endpoint', async () => {
  const stub = httpStub([fixture('page-2')])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  await client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf)

  assert.equal(stub.sent[0]!.url, 'https://gitlab.example.invalid/api/graphql')
})

test('GraphQL errors are refused although the status is 200', async () => {
  const http: Http = async () =>
    new Response(JSON.stringify({ errors: [{ message: 'Recursive query - too many of fields' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', http)

  await assert.rejects(
    () => client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf),
    (e: unknown) => {
      assert.ok(e instanceof GitLabRejected)
      assert.match(e.message, /Recursive query/)
      return true
    },
  )
})

test('a non-200 answer is reported with its status', async () => {
  const http: Http = async () => new Response('forbidden', { status: 403 })
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', http)

  await assert.rejects(
    () => client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf),
    (e: unknown) => {
      assert.ok(e instanceof GitLabRejected)
      assert.match(e.message, /403/)
      return true
    },
  )
})

/**
 * Fixtures must be invented. The check is a POSITIVE one — every host and
 * every namespace has to match the reserved shapes — rather than a list of
 * names that must not appear.
 *
 * A list of forbidden names only catches what someone already thought of,
 * and it has to spell out the very strings it exists to keep out of the
 * repository. `.invalid` is reserved by RFC 2606 and `acme` by RFC 2606's
 * sibling convention, so neither can ever be somebody's real instance.
 */
test('the fixtures carry invented hosts and namespaces only', () => {
  const files = [
    'epics/page-1',
    'epics/page-2',
    'epics/children-page-1',
    'epics/children-page-2',
    'epics/children-page-3',
    'milestones/page-1',
    'milestones/issues',
  ]

  for (const file of files) {
    const raw = readFileSync(resolve(process.cwd(), 'test/fixtures', `${file}.json`), 'utf8')

    for (const match of raw.matchAll(/https?:\/\/([^/"]+)/g)) {
      const host = match[1] ?? ''
      assert.ok(
        host.endsWith('.invalid'),
        `${file}: host ${host} is not a reserved name — fixtures must be invented`,
      )
    }

    for (const match of raw.matchAll(/"(?:fullPath|full_path|namespace)":\s*"([^"]+)"/g)) {
      const path = match[1] ?? ''
      assert.ok(
        path.startsWith('acme/'),
        `${file}: namespace ${path} is not an invented one`,
      )
    }
  }
})

test('the fixture guard rejects a real host', () => {
  // Without this, the test above would pass just as well on a fixture set
  // that contains no URLs at all.
  const planted = '{"webUrl": "https://gitlab.com/real/group/-/epics/1"}'
  const hosts = [...planted.matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1] ?? '')
  assert.equal(hosts.length, 1)
  assert.equal(hosts.every((h) => h.endsWith('.invalid')), false)
})

// --- Stage4-2: the translation at the edge ------------------------------

import {
  categoryOf,
  healthValueOf,
  issueCountsOf,
  translateEpics,
  StatusFieldMissing,
  type Complaint,
} from '../src/source/gitlab/translate.js'
import { createEpicSource } from '../src/source/gitlab/epics.js'
import { lastActivityOf } from '../src/core/activity.js'
import type { CoreConfig } from '../src/core/types.js'

const byLabel: CoreConfig = {
  host: 'gitlab.example.invalid',
  keyIs: 'id',
  stageSource: 'label',
  statusMap: new Map([['Flow::Doing', 'In progress']]),
  active: ['In progress'],
  blocked: [],
  closed: 'Released',
  default: 'Backlog',
}

test('AK29 the category arrives LOWERCASE, as GitLab actually sends it', () => {
  const complaints: Complaint[] = []
  // Written against the wire spelling, not the schema spelling: the schema
  // says IN_PROGRESS, the wire says in_progress, and a mapping built from
  // the schema would never hit a branch.
  assert.equal(categoryOf('in_progress', complaints), 'active')
  assert.equal(categoryOf('triage', complaints), 'triage')
  assert.equal(categoryOf('to_do', complaints), 'todo')
  assert.equal(categoryOf('done', complaints), 'done')
  assert.deepEqual(complaints, [])
})

test('the schema spelling does NOT map — that is the trap, and it must stay caught', () => {
  const complaints: Complaint[] = []
  assert.equal(categoryOf('IN_PROGRESS', complaints), null)
  assert.equal(complaints.length, 1)
})

test('"canceled" with one L maps to "cancelled" with two', () => {
  const complaints: Complaint[] = []
  assert.equal(categoryOf('canceled', complaints), 'cancelled')
  assert.deepEqual(complaints, [])
})

test('AK29 an unknown category is reported and the field stays empty', () => {
  const complaints: Complaint[] = []
  assert.equal(categoryOf('in_review_by_robot', complaints), null)

  assert.equal(complaints.length, 1)
  assert.match(complaints[0]!.message, /unknown status category: "in_review_by_robot"/)
  // Names what it does know, so the gap is actionable.
  assert.match(complaints[0]!.message, /"in_progress"/)
})

test('AK30 no GitLab health word reaches the core', () => {
  const complaints: Complaint[] = []
  assert.equal(healthValueOf('onTrack', complaints), 'ok')
  assert.equal(healthValueOf('needsAttention', complaints), 'attention')
  assert.equal(healthValueOf('atRisk', complaints), 'risk')
  assert.deepEqual(complaints, [])
})

test('AK30 an unknown health value is reported, not passed through', () => {
  const complaints: Complaint[] = []
  assert.equal(healthValueOf('onFire', complaints), null)
  assert.match(complaints[0]!.message, /unknown health status: "onFire"/)
})

test('the Issue entry of the rollup is what progress counts from', () => {
  const rolled = [
    { workItemType: { name: 'Epic' }, countsByState: { all: 2, closed: 1 } },
    { workItemType: { name: 'Issue' }, countsByState: { all: 30, closed: 12 } },
  ]
  assert.deepEqual(issueCountsOf(rolled), { all: 30, closed: 12 })
  // No rollup at all is not 0/0 — the caller must be able to tell them apart.
  assert.equal(issueCountsOf(null), null)
  assert.equal(issueCountsOf([]), null)
})

test('a fixture page becomes complete bundles, with no GitLab word left', () => {
  const nodes = fixture('page-1').data.group.workItems.nodes
  const { bundles, prefixes, truncated } = translateEpics(nodes, 'acme/product', byLabel)

  assert.equal(bundles.length, 1)
  const epic = bundles[0]!

  assert.equal(epic.key, 'acme/product&7')
  assert.equal(epic.name, 'Offline mode')
  assert.equal(epic.closed, false)
  assert.deepEqual(epic.progress, { done: 1, total: 3, ratio: 1 / 3 })
  assert.deepEqual(epic.due, new Date('2026-09-30'))
  // The rollup carries one atRisk among two onTrack — the worst wins.
  assert.equal(epic.health, 'risk')
  assert.equal(prefixes.includes('Flow'), true)
  assert.deepEqual(truncated, [])

  // The child epic came along, one level deep, and carries its own item.
  assert.equal(epic.children.length, 1)
  const child = epic.children[0]!
  assert.equal(child.key, 'acme/product&8')
  assert.equal(child.items.length, 1)
  assert.equal(child.items[0]!.key, 'acme/product/app#43')
  assert.equal(child.items[0]!.stage.label, 'Flow::Doing')
})

test('lastActivity reaches through the tree, not just the epic itself', () => {
  const nodes = fixture('page-1').data.group.workItems.nodes
  const epic = translateEpics(nodes, 'acme/product', byLabel).bundles[0]!

  // The epic says 2026-08-05, but the grandchild issue moved on 2026-08-24.
  assert.deepEqual(epic.lastActivity, new Date('2026-08-24T14:00:00Z'))
})

test('a closed epic without a due date translates cleanly', () => {
  const nodes = fixture('page-2').data.group.workItems.nodes
  const epic = translateEpics(nodes, 'acme/product', byLabel).bundles[0]!

  assert.equal(epic.closed, true)
  assert.equal(epic.due, null)
  assert.deepEqual(epic.progress, { done: 4, total: 4, ratio: 1 })
  assert.equal(epic.health, null)
  assert.equal(epic.description, '')
})

test('AK7j / EC7b a missing status field aborts instead of switching to labels', () => {
  const byStatus: CoreConfig = { ...byLabel, stageSource: 'status', active: [] }
  const nodes = fixture('page-1').data.group.workItems.nodes

  assert.throws(
    () => translateEpics(nodes, 'acme/product', byStatus),
    (e: unknown) => {
      assert.ok(e instanceof StatusFieldMissing)
      assert.match(e.message, /17\.11/)
      assert.match(e.message, /stage_source = "label"/)
      return true
    },
  )
})

test('no response object leaves the source — a bundle carries only seam fields', () => {
  const nodes = fixture('page-1').data.group.workItems.nodes
  const epic = translateEpics(nodes, 'acme/product', byLabel).bundles[0]!

  const seam = ['key','number','name','description','closed','due','url','progress','lastActivity','health','items','children']
  assert.deepEqual(Object.keys(epic).sort(), [...seam].sort())
  assert.equal('iid' in epic, false)
  assert.equal('webUrl' in epic, false)
  assert.equal('widgets' in epic, false)
})

test('R3c hasChildren on the TOP level is not a cut — the query asked for that level', () => {
  // The cut is a property of where the QUERY stops, not of any node saying
  // it has children. A top-level epic's children ARE fetched, so hasChildren
  // there says nothing about truncation.
  const top = {
    id: 'gid://gitlab/WorkItem/2001',
    iid: '11',
    workItemType: { name: 'Epic' },
    title: 'A top-level epic',
    description: '',
    state: 'OPEN',
    webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/11',
    updatedAt: '2026-08-01T00:00:00Z',
    widgets: [
      { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 5, closed: 1 } }], rolledUpHealthStatus: [] },{ hasChildren: true }],
  }

  assert.deepEqual(translateEpics([top], 'acme/product', byLabel).truncated, [])
})

test('R3c an epic whose children DID come along is not reported as truncated', () => {
  const nodes = fixture('page-1').data.group.workItems.nodes
  // page-1 carries hasChildren: true AND the children — nothing was cut.
  assert.deepEqual(translateEpics(nodes, 'acme/product', byLabel).truncated, [])
})

test('a bundle with no rollup has no progress rather than 0 of 0', () => {
  const noRollup = {
    id: 'gid://gitlab/WorkItem/2002',
    iid: '12',
    workItemType: { name: 'Epic' },
    title: 'An epic GitLab counted nothing for',
    description: '',
    state: 'OPEN',
    webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/12',
    updatedAt: '2026-08-01T00:00:00Z',
    widgets: [
      { rolledUpCountsByType: null, rolledUpHealthStatus: [] },],
  }

  assert.equal(translateEpics([noRollup], 'acme/product', byLabel).bundles[0]!.progress, null)
})

// --- Stage4-3: prefixes and the depth signal ----------------------------

/**
 * An epic carrying whatever labels a case needs, with an optional child.
 *
 * Every node a test builds goes through here or through `issueNode`, and the
 * reason is R3d: the classification reads `workItemType`, so a node built by
 * hand without one tests a shape GitLab never sends. The helpers carry the
 * type so no case can forget it.
 */
function epicNode(over: Record<string, unknown> = {}, widgets: unknown[] = []) {
  return {
    id: 'gid://gitlab/WorkItem/3001',
    iid: '20',
    workItemType: { name: 'Epic' },
    title: 'An epic',
    description: '',
    state: 'OPEN',
    webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/20',
    updatedAt: '2026-08-01T00:00:00Z',
    widgets: [
      { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 5, closed: 2 } }] },
      ...widgets,
    ],
    ...over,
  }
}

/**
 * An issue as GitLab really sends it inside a children list — carrying a
 * FILLED `rolledUpCountsByType`, because the query selects `bundleWidgets`
 * on that level too and GraphQL answers every field it was asked for
 * (measured 2026-08-25). A fixture that leaves the rollup out describes a
 * response that cannot occur, and it is what let the misclassification pass
 * a green suite (R3d).
 */
function issueNode(over: Record<string, unknown> = {}, widgets: unknown[] = []) {
  return {
    id: 'gid://gitlab/WorkItem/4001',
    iid: '42',
    workItemType: { name: 'Issue' },
    title: 'An issue',
    description: '',
    state: 'OPEN',
    webUrl: 'https://gitlab.example.invalid/acme/product/app/-/issues/42',
    updatedAt: '2026-08-01T00:00:00Z',
    widgets: [
      { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 0, closed: 0 } }] },
      ...widgets,
    ],
    ...over,
  }
}

test('R7a the prefix is the part before the LAST ::, not the first', () => {
  const labels = { labels: { nodes: [{ title: 'Flow::Doing' }, { title: 'Rank::1' }, { title: 'AST::Ruleset::FN' }] } }
  const { prefixes } = translateEpics([epicNode({}, [labels])], 'acme/product', byLabel)

  assert.deepEqual([...prefixes].sort(), ['AST::Ruleset', 'Flow', 'Rank'])
  // The scope GitLab holds exclusively is AST::Ruleset — not AST.
  assert.equal(prefixes.includes('AST'), false)
})

test('R7a a flat label without :: contributes no prefix', () => {
  const labels = { labels: { nodes: [{ title: 'bug' }] } }
  const { prefixes } = translateEpics([epicNode({}, [labels])], 'acme/product', byLabel)
  assert.deepEqual(prefixes, [])
})

test('AK31 a child reporting hasChildren marks the tree as deeper than the state reached', () => {
  const child = epicNode(
    {
      id: 'gid://gitlab/WorkItem/3002',
      iid: '21',
      title: 'A sub-epic with children of its own',
      webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/21',
    },
    // The last queried level says there is more below.
    [{ hasChildren: true }],
  )
  child.widgets[0] = { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 9, closed: 3 } }] }

  const { bundles, truncated } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [child] } }])],
    'acme/product',
    byLabel,
  )

  assert.deepEqual(truncated, ['acme/product&21'])
  // Progress is untouched by the cut — GitLab rolls it up without limit.
  assert.deepEqual(bundles[0]!.children[0]!.progress, { done: 3, total: 9, ratio: 3 / 9 })
})

test('AK31 counter-check: hasChildren false is NOT marked', () => {
  const child = epicNode(
    {
      id: 'gid://gitlab/WorkItem/3003',
      iid: '22',
      title: 'A sub-epic with nothing below',
      webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/22',
    },
    [{ hasChildren: false }],
  )

  const { truncated } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [child] } }])],
    'acme/product',
    byLabel,
  )
  assert.deepEqual(truncated, [])
})

test('AK31 counter-check: a POPULATED children list does not cancel the signal', () => {
  // This is the measured trap: an extra condition on the list would never
  // have fired, because where children is queried it is not empty when
  // hasChildren is true.
  const grandchild = issueNode({
    id: 'gid://gitlab/WorkItem/3005',
    iid: '44',
    title: 'An issue under the sub-epic',
    webUrl: 'https://gitlab.example.invalid/acme/product/app/-/issues/44',
  })
  const child = epicNode(
    {
      id: 'gid://gitlab/WorkItem/3004',
      iid: '23',
      title: 'A sub-epic that carries children AND reports more',
      webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/23',
    },
    [{ hasChildren: true, children: { nodes: [grandchild] } }],
  )

  const { bundles, truncated } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [child] } }])],
    'acme/product',
    byLabel,
  )

  assert.deepEqual(truncated, ['acme/product&23'])
  // The children that DID arrive are still there — the cut is about what lies
  // beyond, not about what came back.
  assert.equal(bundles[0]!.children[0]!.items.length, 1)
})

// --- R3d: bundle or item, decided on the type GitLab states -------------

test('AK57 an issue DIRECTLY under a top-level epic becomes an item', () => {
  // The case the suite was missing entirely, and the one that occurs most:
  // every epic in the group this was measured against holds issues with no
  // sub-epic in between. The old classification asked whether the node
  // carried rolledUpCountsByType — which the query selects on this level too
  // — so this issue became a BUNDLE and no item row was ever written.
  const { bundles } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [issueNode()] } }])],
    'acme/product',
    byLabel,
  )

  const epic = bundles[0]!
  assert.equal(epic.children.length, 0, 'an issue is not a child bundle')
  assert.equal(epic.items.length, 1)
  // Keyed as an item (#), never as an epic (&) — an epic key would collide
  // with a real epic of that number and one row would overwrite the other.
  assert.equal(epic.items[0]!.key, 'acme/product/app#42')
})

test('AK57 counter-check: a child of type Epic is still a bundle', () => {
  const sub = epicNode({
    id: 'gid://gitlab/WorkItem/3009',
    iid: '24',
    title: 'A real sub-epic',
    webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/24',
  })
  const { bundles } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [sub] } }])],
    'acme/product',
    byLabel,
  )

  assert.equal(bundles[0]!.children.length, 1)
  assert.equal(bundles[0]!.children[0]!.key, 'acme/product&24')
  assert.equal(bundles[0]!.items.length, 0)
})

test('AK57 a Ticket is an item, not a bundle — the unknown side is the safe one', () => {
  // GitLab allows Epic, Issue and Ticket as direct children of an epic. A
  // negative test (`!== "Issue"`) would put a ticket in the bundle branch and
  // key it as an epic, colliding with a real epic of that number.
  const ticket = issueNode({
    workItemType: { name: 'Ticket' },
    iid: '77',
    webUrl: 'https://gitlab.example.invalid/acme/product/app/-/issues/77',
  })
  const { bundles, complaints } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [ticket] } }])],
    'acme/product',
    byLabel,
  )

  assert.equal(bundles[0]!.items.length, 1)
  assert.equal(bundles[0]!.items[0]!.key, 'acme/product/app#77')
  // A known item type says nothing — only an UNKNOWN one is reported.
  assert.deepEqual(complaints, [])
})

test('AK57 a type no table knows is reported, not swallowed (R3b)', () => {
  const exotic = issueNode({ workItemType: { name: 'Objective' }, iid: '88' })
  const { bundles, complaints } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [exotic] } }])],
    'acme/product',
    byLabel,
  )

  // Still an item — the safe side — but it does not pass in silence.
  assert.equal(bundles[0]!.items.length, 1)
  assert.equal(complaints.length, 1)
  assert.match(complaints[0]!.message, /work item type/)
  assert.match(complaints[0]!.message, /Objective/)
})

test('AK57 the type is reported ONCE per child, not once per list', () => {
  const exotic = issueNode({ workItemType: { name: 'Objective' }, iid: '89' })
  const { complaints } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [exotic] } }])],
    'acme/product',
    byLabel,
  )

  assert.equal(complaints.length, 1, 'classifying twice would report twice')
})

test('section 5 a CHILD bundle in another subgroup keeps its own path', () => {
  // The parent passes its path down as the fallback, so a child that ignored
  // its own namespace would silently inherit the parent's — and two epics of
  // the same number in different subgroups would land on one Notion row, each
  // run overwriting the other. The top-level case has a test; this is the
  // same property one level down, where the fallback makes it invisible.
  const child = epicNode({
    id: 'gid://gitlab/WorkItem/3011',
    iid: '59',
    namespace: { fullPath: 'acme/beta' },
    title: 'Same number, different subgroup',
    webUrl: 'https://gitlab.example.invalid/groups/acme/beta/-/epics/59',
  })
  const parent = epicNode({
    id: 'gid://gitlab/WorkItem/3010',
    iid: '59',
    namespace: { fullPath: 'acme/alpha' },
    webUrl: 'https://gitlab.example.invalid/groups/acme/alpha/-/epics/59',
  })
  parent.widgets.push({ hasChildren: true, children: { nodes: [child] } })

  const { bundles } = translateEpics([parent], 'acme', byLabel)

  assert.equal(bundles[0]!.key, 'acme/alpha&59')
  assert.equal(bundles[0]!.children[0]!.key, 'acme/beta&59')
  assert.notEqual(bundles[0]!.key, bundles[0]!.children[0]!.key)
})

test('a mixed children list splits into BOTH lists at once', () => {
  // Epic and issue side by side under one parent. The sorting loop fills two
  // lists; no test held both of them non-empty in the same call.
  const sub = epicNode({
    id: 'gid://gitlab/WorkItem/3012',
    iid: '60',
    webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/60',
  })
  const { bundles } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [sub, issueNode()] } }])],
    'acme/product',
    byLabel,
  )

  assert.deepEqual(bundles[0]!.children.map((c) => c.key), ['acme/product&60'])
  assert.deepEqual(bundles[0]!.items.map((i) => i.key), ['acme/product/app#42'])
})

test('an empty answer translates to nothing, without complaint', () => {
  assert.deepEqual(translateEpics([], 'acme/product', byLabel), {
    bundles: [],
    prefixes: [],
    truncated: [],
    complaints: [],
  })
})

test('an unknown type is named ONCE however many children carry it', () => {
  // Measured before the fix: 1000 children of an unknown type produced 1000
  // identical sentences, 179 KB out of a single epic. The report is read
  // because it does not arrive every night (section 12) — repetition on that
  // scale trains the reader to skip it.
  const many = Array.from({ length: 50 }, (_, i) =>
    issueNode({ workItemType: { name: 'Objective' }, iid: String(100 + i) }),
  )
  const { bundles, complaints } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: many } }])],
    'acme/product',
    byLabel,
  )

  assert.equal(bundles[0]!.items.length, 50, 'every child still becomes a row')
  assert.equal(complaints.length, 1, 'but the reason is stated once')
})

test('two DIFFERENT unknown types are both named', () => {
  // The counter-check to the one above: deduplication must not swallow a
  // second, genuinely different message.
  const { complaints } = translateEpics(
    [
      epicNode({}, [
        {
          hasChildren: true,
          children: {
            nodes: [
              issueNode({ workItemType: { name: 'Objective' }, iid: '101' }),
              issueNode({ workItemType: { name: 'Key Result' }, iid: '102' }),
            ],
          },
        },
      ]),
    ],
    'acme/product',
    byLabel,
  )

  assert.equal(complaints.length, 2)
})

test('an item URL without a project path is dropped and named, not keyed as #42', () => {
  // The path is half the key. Empty would collapse every item of that number
  // onto one Notion row across all projects, and the run would report success.
  const good = issueNode({ iid: '42' })
  const bad = issueNode({ iid: '43', webUrl: 'https://gitlab.example.invalid/' })
  const { bundles, complaints } = translateEpics(
    [epicNode({}, [{ hasChildren: true, children: { nodes: [good, bad] } }])],
    'acme/product',
    byLabel,
  )

  // The healthy item keeps its row — one broken item does not cost the others.
  assert.deepEqual(bundles[0]!.items.map((i) => i.key), ['acme/product/app#42'])
  assert.equal(complaints.length, 1)
  assert.match(complaints[0]!.message, /no project path/)
})

test('AK57 the query asks for the type the classification reads', () => {
  // Asserted on the QUERY, like AK46a: without this field the translation
  // cannot classify at all, and the failure would look like missing data.
  const selections = epicQuery(false, false)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

  assert.match(selections, /workItemType \{ name \}/)
})

// --- Stage4-4: the two filters ------------------------------------------

import { filterBundles } from '../src/source/gitlab/filter.js'
import type { Bundle } from '../src/core/types.js'

function bundleNamed(name: string, closed = false, over: Partial<Bundle> = {}): Bundle {
  return {
    key: `acme/product&${name.length}`,
    number: name.length,
    name,
    description: '',
    closed,
    due: null,
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/1',
    progress: { done: 1, total: 2, ratio: 0.5 },
    lastActivity: new Date('2026-08-01T00:00:00Z'),
    health: null,
    items: [],
    children: [],
    ...over,
  }
}

const keep = { excludeTitles: [], includeClosed: true }

test('exclude_titles compares on EQUALITY, not as a substring', () => {
  const bundles = [
    bundleNamed('Dependency Dashboard'),
    bundleNamed('Rework Dependency Dashboard UX'),
    bundleNamed('Offline mode'),
  ]

  const kept = filterBundles(bundles, { ...keep, excludeTitles: ['Dependency Dashboard'] })

  assert.deepEqual(kept.map((b) => b.name), ['Rework Dependency Dashboard UX', 'Offline mode'])
})

test('exclude_titles is case-sensitive — a filter that guesses is worse than one written out', () => {
  const bundles = [bundleNamed('Dependency Dashboard')]
  const kept = filterBundles(bundles, { ...keep, excludeTitles: ['dependency dashboard'] })
  assert.equal(kept.length, 1)
})

test('exclude_titles takes a variant only when it is written out as its own line', () => {
  // The Renovate bot writes an emoji in front, depending on version.
  const bundles = [bundleNamed('Dependency Dashboard'), bundleNamed('🔍 Dependency Dashboard')]
  const kept = filterBundles(bundles, {
    ...keep,
    excludeTitles: ['Dependency Dashboard', '🔍 Dependency Dashboard'],
  })
  assert.deepEqual(kept, [])
})

test('include_closed = false drops closed bundles, true keeps them', () => {
  const bundles = [bundleNamed('Open one'), bundleNamed('Finished one', true)]

  assert.deepEqual(
    filterBundles(bundles, { excludeTitles: [], includeClosed: false }).map((b) => b.name),
    ['Open one'],
  )
  assert.equal(filterBundles(bundles, keep).length, 2)
})

test('EC3 progress still counts closed items in a bundle that was kept', () => {
  // The denominator is the whole tree, not the remaining work — otherwise
  // progress would FALL while people are working.
  const bundle = bundleNamed('Open one', false, { progress: { done: 12, total: 30, ratio: 0.4 } })
  const kept = filterBundles([bundle], { excludeTitles: [], includeClosed: false })

  assert.deepEqual(kept[0]!.progress, { done: 12, total: 30, ratio: 0.4 })
})

test('child bundles are NOT filtered — visibility is not derivation', () => {
  // An epic with two finished sub-epics must still reach table row 3 and read
  // closed; filtering the children away would drop it to default, which is
  // "nothing known" for something that is done (section 4b).
  const parent = bundleNamed('Parent', false, {
    children: [bundleNamed('Done child', true), bundleNamed('Excluded by name', false)],
  })

  const kept = filterBundles([parent], {
    excludeTitles: ['Excluded by name'],
    includeClosed: false,
  })

  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.children.length, 2, 'children survive both filters')
})

test('no filters configured keeps everything', () => {
  const bundles = [bundleNamed('One'), bundleNamed('Two', true)]
  assert.equal(filterBundles(bundles, keep).length, 2)
})

test('an unreachable host reads like a message, not like Node\'s "fetch failed"', async () => {
  const http: Http = async () => {
    throw new TypeError('fetch failed')
  }
  const client = createGitLabClient('nothing.invalid', 'glpat-invented', http)

  await assert.rejects(
    () => client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf),
    (e: unknown) => {
      assert.ok(e instanceof GitLabRejected)
      // Names the host, the setting to check, and keeps the original cause.
      assert.match(e.message, /Could not reach GitLab at https:\/\/nothing\.invalid\/api\/graphql/)
      assert.match(e.message, /\[gitlab\]\.host/)
      assert.match(e.message, /fetch failed/)
      return true
    },
  )
})

test('section 5 two epics of the same number in different subgroups get different keys', () => {
  // The key must carry the bundle's OWN path. With includeDescendants the
  // answer spans several subgroups and epic numbers restart per namespace —
  // keying on the configured group would put two epics in one Notion row and
  // each run would overwrite the other.
  const epicIn = (namespace: string) =>
    epicNode(
      {
        id: `gid://gitlab/WorkItem/${namespace}`,
        iid: '59',
        namespace: { fullPath: namespace },
        title: 'Same number, different subgroup',
        webUrl: `https://gitlab.example.invalid/groups/${namespace}/-/epics/59`,
      },
      [{ hasChildren: false }],
    )

  const { bundles } = translateEpics([epicIn('acme/alpha'), epicIn('acme/beta')], 'acme', byLabel)

  assert.deepEqual(bundles.map((b) => b.key), ['acme/alpha&59', 'acme/beta&59'])
  assert.equal(new Set(bundles.map((b) => b.key)).size, 2)
})

test('the fixture bundle is keyed by the namespace GitLab sent', () => {
  const nodes = fixture('page-1').data.group.workItems.nodes
  assert.equal(translateEpics(nodes, 'acme/product', byLabel).bundles[0]!.key, 'acme/product&7')
})

test('without a namespace the configured group is used', () => {
  // The DEFENSIVE case, and it is written as one: the query selects
  // `namespace { fullPath }` on every level, so a real answer always carries
  // it — asserting this against a fixture that merely omitted the field would
  // describe a response GitLab never sends, which is how the classification
  // defect passed a green suite (R3d). Built by hand instead, so the node
  // says out loud that it is the unusual one.
  const node = epicNode({ iid: '7', namespace: null })
  assert.equal(translateEpics([node], 'acme/product', byLabel).bundles[0]!.key, 'acme/product&7')
})

test('R7b flat labels count as ONE prefix between them, not one each', () => {
  const flat = { labels: { nodes: [{ title: 'wip' }, { title: 'review' }] } }
  const node = epicNode(
    {
      id: 'gid://gitlab/WorkItem/1',
      iid: '1',
      webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/1',
    },
    [flat],
  )

  // A flat label has no prefix to name, so nothing is collected.
  assert.deepEqual(translateEpics([node], 'acme/product', byLabel).prefixes, [])
})

test('R7b the first SCOPED label wins, not the first label delivered', () => {
  // GitLab guarantees no order, so a flat label can arrive first. The rule is
  // "the first scoped one", and `labels[0]` would answer differently here —
  // the fixtures carry one label each, where both forms agree, so this case
  // needs building by hand.
  const mixed = { labels: { nodes: [{ title: 'wip' }, { title: 'Flow::Doing' }] } }
  const epic = epicNode({ iid: '1' }, [{ children: { nodes: [issueNode({ iid: '9' }, [mixed])] } }])

  const item = translateEpics([epic], 'acme/product', byLabel).bundles[0]!.items[0]!
  assert.equal(item.stage.label, 'Flow::Doing')
})

test('a flat label is still used when there is no scoped one', () => {
  const flat = { labels: { nodes: [{ title: 'wip' }] } }
  const epic = epicNode({ iid: '2' }, [{ children: { nodes: [issueNode({ iid: '8' }, [flat])] } }])

  const item = translateEpics([epic], 'acme/product', byLabel).bundles[0]!.items[0]!
  assert.equal(item.stage.label, 'wip')
})

// A bundle with more children than one page holds. GitLab caps that
// connection at 100 and says so in pageInfo — the field the query has to ask
// for, because nothing else distinguishes "these are all" from "these are the
// first hundred". Measured 2026-08-26: four of 51 epics in a real group
// overflow it, one returning 100 of its 205 children.

test('the child connection is queried WITH pageInfo, or truncation is invisible', () => {
  // Asserted on the query text: a fixture can only ever show what the query
  // asked for, so a missing selection would leave every response test green
  // while the real answer silently lost its tail.
  const selections = epicQuery(false, false)
  const child = selections.slice(selections.indexOf('children('))
  assert.match(child, /pageInfo\s*{\s*hasNextPage\s+endCursor\s*}/)
})

test('nodeFields selects id, which the follow-up query needs to address one work item', () => {
  // `id` and `iid` are different fields and only one of them addresses a work
  // item: workItem(id:) takes the global id, and the iid repeats per
  // namespace. Matched on its own line so the `id` inside `iid` cannot pass.
  const fields = epicQuery(false, false)
  const nodeFields = fields.slice(fields.indexOf('fragment nodeFields on WorkItem'))
  assert.match(nodeFields, /^\s*id$/m)
})

test('a bundle whose children span three pages arrives with all of them', async () => {
  const stub = httpStub([fixture('children-page-1'), fixture('children-page-2'), fixture('children-page-3')])
  const source = createEpicSource('gitlab.example.invalid', 'glpat-invented', byLabel, stub.http)

  const { bundles } = await source.read({ group: 'acme/product', subgroups: false, includeClosed: true, excludeTitles: [] })

  // One request for the epic page, then one per remaining child page.
  assert.equal(stub.sent.length, 3)
  const bundle = bundles[0]!
  // Two issues from pages one and two...
  assert.deepEqual(bundle.items.map((i) => i.number), [50, 51])
  // ...and the CHILD BUNDLE that sat on page three. This is the loss that
  // costs most: without the follow-up it and its whole subtree are absent,
  // and nothing says so.
  assert.deepEqual(bundle.children.map((c) => c.key), ['acme/product&12'])
})

test('the follow-up addresses the work item by id and carries the cursor', async () => {
  const stub = httpStub([fixture('children-page-1'), fixture('children-page-2'), fixture('children-page-3')])
  const source = createEpicSource('gitlab.example.invalid', 'glpat-invented', byLabel, stub.http)

  await source.read({ group: 'acme/product', subgroups: false, includeClosed: true, excludeTitles: [] })

  assert.equal(stub.sent[1]!.variables['id'], 'gid://gitlab/WorkItem/2001')
  assert.equal(stub.sent[1]!.variables['after'], 'CHILD-CURSOR-2')
  assert.equal(stub.sent[2]!.variables['after'], 'CHILD-CURSOR-3')
})

test('state and activity see the children that only the follow-up brought', async () => {
  // The point of the fix, not a detail of it: verdict and activity are derived
  // from [...items, ...children] (state.ts, activity.ts). Page two carries the
  // only blocked item and page three the newest timestamp, so both would be
  // wrong on the truncated list while looking perfectly plausible.
  const stub = httpStub([fixture('children-page-1'), fixture('children-page-2'), fixture('children-page-3')])
  const source = createEpicSource('gitlab.example.invalid', 'glpat-invented', byLabel, stub.http)

  const { bundles } = await source.read({ group: 'acme/product', subgroups: false, includeClosed: true, excludeTitles: [] })

  const blocked = bundles[0]!.items.find((i) => i.number === 51)!
  assert.equal(blocked.stage.label, 'Flow::Blocked')
  assert.equal(lastActivityOf(bundles[0]!).toISOString(), '2026-08-09T09:00:00.000Z')
})

test('a bundle whose children fit on one page asks no follow-up', async () => {
  // The cost has to fall only where the overflow is: 47 of 51 epics in the
  // measured group fit, and a follow-up per bundle would triple the run for
  // nothing.
  const stub = httpStub([fixture('page-2')])
  const source = createEpicSource('gitlab.example.invalid', 'glpat-invented', byLabel, stub.http)

  await source.read({ group: 'acme/product', subgroups: false, includeClosed: true, excludeTitles: [] })

  assert.equal(stub.sent.length, 1)
})


// GitLab gives a query about 30 seconds, and the epic query's cost is driven by
// how many CHILDREN land in one answer, not by how many bundles were asked for.
// Measured 2026-08-26 against a real group of 51 epics: the wall sits around
// 450-550 children per answer, a page of 20 failed 3 of 3 attempts, and a page
// of 10 succeeded 3 of 3. The same request also varies by 40 % between
// attempts, so no fixed size is safe for every group on every day — the size
// adjusts itself downwards instead (ADR-0023).

/** GitLab's own timeout, which arrives with HTTP 200 and a partly filled body. */
const timedOut = {
  data: { group: { workItems: { pageInfo: { hasNextPage: true, endCursor: 'X' }, nodes: [null, null] } } },
  errors: [{ message: 'Timeout on WorkItemWidgetHierarchy.hasChildren', path: ['group', 'workItems', 'nodes', 0] }],
}

test('AK50 the epic query starts at 10, the largest size measured to hold', () => {
  assert.match(epicQuery(false, false), /first: 10\n/)
})

test('AK50 the child page stays at 100 whatever the outer page does', () => {
  // ADR-0022: children are fetched in full, and GitLab caps that connection at
  // 100. Shrinking it along with the outer page would silently drop children —
  // measured, 533 of 1090 lost at a child page of 20.
  const shrunk = epicQuery(false, false, 5)
  assert.deepEqual([...shrunk.matchAll(/children\(first: (\d+)\)/g)].map((m) => m[1]), ['100', '100'])
  assert.match(shrunk, /first: 5\n/)
})

test('AK51 a timeout halves the page and asks again from the same cursor', async () => {
  const stub = httpStub([timedOut, fixture('page-2')])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  const nodes = await client.all((size) => epicQuery(false, false, size), { group: 'acme/product' }, pageOf)

  assert.equal(stub.sent.length, 2)
  assert.match(stub.sent[0]!.query, /first: 10\n/)
  assert.match(stub.sent[1]!.query, /first: 5\n/)
  // The same cursor: the failed attempt fetched nothing usable, so the retry
  // must not skip past the position it was meant to read.
  assert.equal(stub.sent[1]!.variables['after'], null)
  assert.equal(nodes.length, 1)
})

test('AK51 the partial body of a timed-out answer is NOT used', async () => {
  // It arrives as HTTP 200 with `data` present and null nodes scattered
  // through it — measured, 8 of 40 nodes null, and nothing says which bundles
  // they were. Writing those would publish a roadmap with holes as a complete
  // one, which is the failure this tool exists against.
  const stub = httpStub([timedOut, fixture('page-2')])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  const nodes = await client.all((size) => epicQuery(false, false, size), { group: 'acme/product' }, pageOf)

  assert.equal(nodes.includes(null), false)
  assert.equal(nodes.length, 1)
})

test('AK51 a page that succeeded smaller stays smaller for the rest of the run', async () => {
  // Not a ratchet back up: whatever made the first attempt too heavy — a busy
  // server, or bundles that are simply fat — does not change within a run, and
  // going back up would burn 30 seconds again on the next page.
  const stub = httpStub([timedOut, fixture('page-1'), fixture('page-2')])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  await client.all((size) => epicQuery(false, false, size), { group: 'acme/product' }, pageOf)

  assert.equal(stub.sent.length, 3)
  assert.match(stub.sent[1]!.query, /first: 5\n/)
  assert.match(stub.sent[2]!.query, /first: 5\n/)
})

test('AK52 a timeout at a page of one names the bundle level, not the page size', async () => {
  // Halving ends at 1. Below that the finding is no longer "too many bundles
  // per page" but "this one bundle is too big", and the message has to say so
  // — a size the reader cannot lower is not an instruction.
  const stub = httpStub(Array.from({ length: 5 }, () => timedOut))
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  await assert.rejects(
    () => client.all((size) => epicQuery(false, false, size), { group: 'acme/product' }, pageOf),
    (error: unknown) => {
      assert.ok(error instanceof GitLabRejected)
      assert.match(error.message, /one bundle at a time/i)
      return true
    },
  )
  // 10, 5, 2, 1 — four attempts, then it stops rather than looping.
  assert.equal(stub.sent.length, 4)
})

test('AK51 a refusal that is NOT a timeout is reported at once, never retried', async () => {
  // Halving cannot help a query GitLab rejects on its merits, and retrying
  // would only delay the same error.
  const stub = httpStub([{ errors: [{ message: "Field 'nope' doesn't exist on type 'WorkItem'" }] }])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  await assert.rejects(() => client.all((size) => epicQuery(false, false, size), { group: 'acme/product' }, pageOf), GitLabRejected)
  assert.equal(stub.sent.length, 1)
})

test('a query passed as a plain string is not retried — the milestone sources rely on it', async () => {
  // Only a builder can be asked for a smaller page. A string has no size to
  // change, so the timeout is reported rather than retried forever.
  const stub = httpStub([timedOut])
  const client = createGitLabClient('gitlab.example.invalid', 'glpat-invented', stub.http)

  await assert.rejects(() => client.all(epicQuery(false, false), { group: 'acme/product' }, pageOf), GitLabRejected)
  assert.equal(stub.sent.length, 1)
})
