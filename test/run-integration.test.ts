import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from '@notionhq/client'
import { main, type Environment } from '../src/main.js'
import type { Http } from '../src/source/gitlab/client.js'

/**
 * The group integration gate for the run path, and the first test in the
 * plan that exercises the tool AS A TOOL: a real TOML file on disk, through
 * config, source, core, target and report, down to the exit code — with
 * nothing but stubs at the two doors to the outside.
 */

const CONFIG = `
[gitlab]
host = "gitlab.example.invalid"
bundle = "epic"
group = "acme/product"
stage_source = "label"
include_closed = false

[notion]
database = "00000000-0000-0000-0000-000000000000"
key_is = "id"

[status]
"Flow::Doing" = "In progress"
default = "Backlog"
closed = "Released"
active = ["In progress"]

[columns]
key = "GitLab ID"
name = "Feature"
state = "Status"
progress = "Progress"
type = "Level"
`

const EPICS = {
  data: {
    group: {
      workItems: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: 'gid://gitlab/WorkItem/1',
            iid: '7',
            workItemType: { name: 'Epic' },
            title: 'Offline mode',
            description: 'Work without a connection.',
            state: 'OPEN',
            webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
            updatedAt: '2026-08-05T09:00:00Z',
            widgets: [
              { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 3, closed: 1 } }], rolledUpHealthStatus: [] },
              { dueDate: '2026-09-30' },
              { labels: { nodes: [{ title: 'Flow::Doing' }] } },
              {
                hasChildren: true,
                children: {
                  nodes: [
                    {
                      id: 'gid://gitlab/WorkItem/2',
                      iid: '8',
                      workItemType: { name: 'Epic' },
                      title: 'Sync queue',
                      description: '',
                      state: 'OPEN',
                      webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/8',
                      updatedAt: '2026-08-02T11:00:00Z',
                      widgets: [
                        { rolledUpCountsByType: [
                        { workItemType: { name: 'Issue' }, countsByState: { all: 1, closed: 0 } },
                      ], rolledUpHealthStatus: [] },
                        { hasChildren: false },
                        { labels: { nodes: [] } },
                        {
                          children: {
                            nodes: [
                              {
                                id: 'gid://gitlab/WorkItem/3',
                                iid: '43',
                                workItemType: { name: 'Issue' },
                                title: 'Queue drains on reconnect',
                                description: '',
                                state: 'OPEN',
                                webUrl: 'https://gitlab.example.invalid/acme/product/app/-/issues/43',
                                updatedAt: '2026-08-24T14:00:00Z',
                                widgets: [
                                  { labels: { nodes: [{ title: 'Flow::Doing' }] } },
                                  // GitLab answers an ISSUE with a FILLED
                                  // rollup too — the query selects it on this
                                  // level (measured 2026-08-25). A stub that
                                  // leaves it out cannot catch R3d.
                                  { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 0, closed: 0 } }], rolledUpHealthStatus: [] },
                                ],
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  },
}

const NO_EPICS = {
  data: { group: { workItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
}

const SCHEMA = {
  object: 'data_source',
  id: 'ds-1',
  properties: {
    'GitLab ID': { id: 'a', name: 'GitLab ID', type: 'rich_text', rich_text: {} },
    Feature: { id: 'b', name: 'Feature', type: 'title', title: {} },
    Status: {
      id: 'c',
      name: 'Status',
      type: 'select',
      select: { options: [{ name: 'In progress' }, { name: 'Backlog' }, { name: 'Released' }] },
    },
    Progress: { id: 'd', name: 'Progress', type: 'number', number: { format: 'percent' } },
    Level: { id: 'e', name: 'Level', type: 'select', select: { options: [{ name: 'Bundle' }, { name: 'Item' }] } },
  },
}

function gitlabStub(answer: unknown): Http {
  return async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** `failWith` makes page creation fail — for all rows, or for one key. */
function notionStub(failWith?: { reason: string; onlyKey?: string }) {
  const created: string[] = []
  const client = {
    databases: {
      retrieve: async () => ({ object: 'database', id: 'db-1', data_sources: [{ id: 'ds-1', name: 'Roadmap' }] }),
    },
    dataSources: {
      retrieve: async () => SCHEMA,
      query: async () => ({ results: [] }),
    },
    pages: {
      create: async (args: any) => {
        const key = args.properties['GitLab ID'].rich_text[0].text.content
        if (failWith !== undefined && (failWith.onlyKey === undefined || failWith.onlyKey === key)) {
          throw new Error(failWith.reason)
        }
        created.push(key)
        return { id: `page-${created.length}` }
      },
      update: async () => ({ id: 'page-1' }),
    },
    blocks: {
      children: { list: async () => ({ results: [] }), append: async () => ({ results: [] }) },
      delete: async () => ({}),
    },
  } as unknown as Client

  return { client, created }
}

function environmentOf(http: Http, notion: Client): Environment & { output: string[]; errors: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'roadmapper-run-'))
  writeFileSync(join(dir, 'roadmapper.toml'), CONFIG)

  const output: string[] = []
  const errors: string[] = []
  return {
    cwd: dir,
    env: { GITLAB_TOKEN: 'glpat-invented', NOTION_TOKEN: 'ntn_invented' },
    out: (text) => void output.push(text),
    err: (text) => void errors.push(text),
    http,
    notion,
    sleep: async () => {},
    output,
    errors,
  }
}

test('a complete run: config file to exit code, through every stage', async () => {
  const notion = notionStub()
  const environment = environmentOf(gitlabStub(EPICS), notion.client)

  const exitCode = await main([], environment)

  assert.equal(exitCode, 0)
  // Bundle, its child bundle, and the child's item — the child epic carries
  // the only issue, and rows come out bundle-first.
  assert.deepEqual(notion.created, ['acme/product&7', 'acme/product&8', 'acme/product/app#43'])

  const report = environment.output.join('')
  assert.match(report, /2 bundles, 1 items written/)
  assert.match(report, /3 created, 0 updated, 0 skipped/)
})

test('the report names the fill rate per column, with the state source', async () => {
  const notion = notionStub()
  const environment = environmentOf(gitlabStub(EPICS), notion.client)

  await main([], environment)
  const report = environment.output.join('')

  assert.match(report, /Status\s+3\/3\s+\(from labels/)
  assert.match(report, /Progress\s+2\/3/)
  // A column the target does not carry gets no line.
  assert.equal(/Health/.test(report), false)
})

test('the core really derived: the epic reads as active from its child\'s label', async () => {
  const notion = notionStub()
  const environment = environmentOf(gitlabStub(EPICS), notion.client)

  await main([], environment)

  // 28x-style distributions aside, the two bundles and the item all carry
  // the mapped value rather than the default.
  assert.match(environment.output.join(''), /3x In progress/)
})

test('AK25 one row failing keeps exit 0 and names the row', async () => {
  const notion = notionStub({ reason: 'Invalid select value', onlyKey: 'acme/product&8' })
  const environment = environmentOf(gitlabStub(EPICS), notion.client)

  const exitCode = await main([], environment)

  assert.equal(exitCode, 0)
  assert.equal(notion.created.length, 2)
  const problems = environment.errors.join('')
  assert.match(problems, /acme\/product&8 was skipped/)
  assert.match(problems, /Invalid select value/)
})

test('AK48 every row failing inverts it: exit 1, first reason named', async () => {
  const notion = notionStub({ reason: '403 restricted_resource' })
  const environment = environmentOf(gitlabStub(EPICS), notion.client)

  const exitCode = await main([], environment)

  assert.equal(exitCode, 1)
  assert.deepEqual(notion.created, [])
  const problems = environment.errors.join('')
  assert.match(problems, /0 of 3 rows written/)
  assert.match(problems, /403 restricted_resource/)
  assert.match(problems, /Can edit/)
})

test('AK20 a source without bundles writes nothing, names the gap, exits 0', async () => {
  const notion = notionStub()
  const environment = environmentOf(gitlabStub(NO_EPICS), notion.client)

  const exitCode = await main([], environment)

  assert.equal(exitCode, 0)
  assert.deepEqual(notion.created, [])
  assert.match(environment.errors.join(''), /No bundles found/)
})

test('a failure reads like a message, never like a crash', async () => {
  const notion = notionStub()
  const environment = environmentOf(gitlabStub(EPICS), notion.client)
  const withoutToken = { ...environment, env: { NOTION_TOKEN: 'ntn_invented' } }

  await assert.rejects(
    () => main([], withoutToken),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /GITLAB_TOKEN is not set/)
      // No stack-trace vocabulary in what the user reads.
      assert.equal(/undefined|Cannot read|TypeError/.test(e.message), false)
      return true
    },
  )
})
