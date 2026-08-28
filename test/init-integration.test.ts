import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from '@notionhq/client'
import { main, type Environment } from '../src/main.js'
import type { Http } from '../src/source/gitlab/client.js'

/**
 * The group integration gate for stage 6: init as ONE command, against stubs
 * for both backends, driven through main.ts exactly as a user would.
 */

const CONFIG = `
[gitlab]
host = "gitlab.example.invalid"
bundle = "epic"
group = "acme/product"
stage_source = "label"

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
type = "Level"
`

const EPIC = {
  id: 'gid://gitlab/WorkItem/1',
  iid: '7',
  workItemType: { name: 'Epic' },
  title: 'Offline mode',
  description: '',
  state: 'OPEN',
  webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
  updatedAt: '2026-08-05T09:00:00Z',
  widgets: [
    { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 3, closed: 1 } }], rolledUpHealthStatus: [] },{ labels: { nodes: [{ title: 'Flow::Doing' }] } }, { hasChildren: false }],
}

/** Answers the epic query and the survey query from the same stub, telling
 *  them apart by what they ask for. */
function gitlabStub(status = 200): Http {
  return async (_url, init) => {
    if (status !== 200) return new Response('no', { status })

    const query = JSON.parse(String(init.body)).query as string
    const answer = query.includes('statuses')
      ? {
          data: {
            group: {
              statuses: [{ name: 'To do', category: 'to_do' }],
              labels: { nodes: [{ title: 'Flow::Doing' }] },
              workItems: {
                nodes: [
                  { widgets: [{ status: { name: 'To do', category: 'to_do' } }, { labels: { nodes: [{ title: 'Flow::Doing' }] } }] },
                  { widgets: [{ status: { name: 'To do', category: 'to_do' } }, { labels: { nodes: [{ title: 'Flow::Blocked' }] } }] },
                ],
              },
            },
          },
        }
      : { data: { group: { workItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [EPIC] } } } }

    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

function notionStub(missing: string[] = []) {
  const properties: Record<string, unknown> = {
    'GitLab ID': { id: 'a', name: 'GitLab ID', type: 'rich_text', rich_text: {} },
    Feature: { id: 'b', name: 'Feature', type: 'title', title: {} },
    Status: { id: 'c', name: 'Status', type: 'select', select: { options: [{ name: 'In progress' }] } },
    Level: { id: 'd', name: 'Level', type: 'select', select: { options: [{ name: 'Bundle' }] } },
  }
  for (const name of missing) delete properties[name]

  const added: string[] = []
  const client = {
    databases: {
      retrieve: async () => ({ object: 'database', id: 'db-1', data_sources: [{ id: 'ds-1', name: 'Roadmap' }] }),
    },
    dataSources: {
      retrieve: async () => ({ object: 'data_source', id: 'ds-1', properties }),
      update: async (args: any) => {
        added.push(...Object.keys(args.properties))
        return { object: 'data_source', id: 'ds-1' }
      },
    },
  } as unknown as Client

  return { client, added }
}

function environmentIn(dir: string, http: Http, notion: Client): Environment & { output: string[] } {
  const output: string[] = []
  return {
    cwd: dir,
    env: { GITLAB_TOKEN: 'glpat-invented', NOTION_TOKEN: 'ntn_invented' },
    out: (text) => void output.push(text),
    err: () => {},
    http,
    notion,
    output,
  }
}

function scratch(config: string | null = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), 'roadmapper-init-int-'))
  if (config !== null) writeFileSync(join(dir, 'roadmapper.toml'), config)
  return dir
}

test('a complete init walks all six steps and ends clean', async () => {
  const notion = notionStub()
  const environment = environmentIn(scratch(), gitlabStub(), notion.client)

  const exitCode = await main(['init'], environment)
  const report = environment.output.join('')

  assert.equal(exitCode, 0)
  // The six steps, in order.
  const order = ['Configuration', 'Credentials', 'GitLab', 'Notion', 'Target schema', 'Source']
  let last = -1
  for (const title of order) {
    const at = report.indexOf(title)
    assert.ok(at > last, `${title} out of order`)
    last = at
  }
  assert.match(report, /1 bundle\(s\) found/)
  assert.match(report, /Everything checks out/)
})

test('step 5 creates the missing column and records the type column', async () => {
  const notion = notionStub(['Status'])
  const environment = environmentIn(scratch(), gitlabStub(), notion.client)

  await main(['init'], environment)

  assert.deepEqual(notion.added, ['Status'])
  const report = environment.output.join('')
  assert.match(report, /created: "Status"/)
  assert.match(report, /"Level" is there — bundles AND items get rows/)
})

test('step 6 shows both stage sources side by side', async () => {
  const environment = environmentIn(scratch(), gitlabStub(), notionStub().client)

  await main(['init'], environment)
  const report = environment.output.join('')

  assert.match(report, /Sampled 2 open issues/)
  assert.match(report, /2x To do\s+\(all on one value\)/)
  assert.match(report, /"label" fits this group/)
})

test('step 3 failing means steps 4-6 never run', async () => {
  const environment = environmentIn(scratch(), gitlabStub(401), notionStub().client)

  const exitCode = await main(['init'], environment)
  const report = environment.output.join('')

  assert.equal(exitCode, 1)
  assert.match(report, /Step 3 failed/)
  assert.match(report, /rejected the token/)
  assert.match(report, /read_api/)
  assert.equal(/Target schema/.test(report), false)
  assert.equal(/Everything checks out/.test(report), false)
})

test('AK47b init --config on a missing file aborts and creates nothing', async () => {
  const dir = scratch(null)
  const environment = environmentIn(dir, gitlabStub(), notionStub().client)

  const exitCode = await main(['init', '--config', 'produktiv.toml'], environment)

  assert.equal(exitCode, 1)
  assert.match(environment.output.join(''), /never created/)
  assert.deepEqual(readdirSync(dir), [], 'no file was created anywhere')
})

test('AK47b init without --config creates the config from the example and stops', async () => {
  const dir = scratch(null)
  const environment = environmentIn(dir, gitlabStub(), notionStub().client)

  const exitCode = await main(['init'], environment)

  assert.equal(exitCode, 0)
  assert.ok(existsSync(join(dir, 'roadmapper.toml')))
  const report = environment.output.join('')
  assert.match(report, /Created/)
  // It stops there: the freshly copied example points at nothing real.
  assert.equal(/Credentials/.test(report), false)
})
