import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Client } from '@notionhq/client'
import { runInit, type InitDependencies } from '../src/init/run.js'
import { configStep, tokenStep, InitFailed } from '../src/init/steps.js'
import { validateConfig } from '../src/config/validate.js'
import { readConfig } from '../src/config/read.js'
import { createEpicSource } from '../src/source/gitlab/epics.js'
import type { Http } from '../src/source/gitlab/client.js'

const EXAMPLE = resolve(process.cwd(), 'roadmapper.example.toml')

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
            description: '',
            state: 'OPEN',
            webUrl: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
            updatedAt: '2026-08-05T09:00:00Z',
            widgets: [
              { rolledUpCountsByType: [{ workItemType: { name: 'Issue' }, countsByState: { all: 3, closed: 1 } }], rolledUpHealthStatus: [] },{ labels: { nodes: [{ title: 'Flow::Doing' }] } }, { hasChildren: false }],
          },
        ],
      },
    },
  },
}

const NO_EPICS = { data: { group: { workItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }

const SCHEMA = {
  object: 'data_source',
  id: 'ds-1',
  properties: {
    'GitLab ID': { id: 'a', name: 'GitLab ID', type: 'rich_text', rich_text: {} },
    Feature: { id: 'b', name: 'Feature', type: 'title', title: {} },
    Status: { id: 'c', name: 'Status', type: 'select', select: { options: [{ name: 'In progress' }] } },
    Level: { id: 'd', name: 'Level', type: 'select', select: { options: [{ name: 'Bundle' }] } },
  },
}

function scratch(config: string | null = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), 'roadmapper-init-'))
  if (config !== null) writeFileSync(join(dir, 'roadmapper.toml'), config)
  return dir
}

const gitlab = (answer: unknown): Http => async () =>
  new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })

const failing = (status: number): Http => async () => new Response('no', { status })

/** Records what init asked to be created, so a test can prove it ADDS and
 *  never retypes. */
const created: Record<string, unknown>[] = []

function notionStub(over: Record<string, unknown> = {}, properties = SCHEMA.properties): Client {
  return {
    databases: {
      retrieve: async () => ({ object: 'database', id: 'db-1', data_sources: [{ id: 'ds-1', name: 'Roadmap' }] }),
    },
    dataSources: {
      retrieve: async () => ({ ...SCHEMA, properties }),
      update: async (args: any) => {
        created.push(args.properties)
        return { object: 'data_source', id: 'ds-1' }
      },
    },
    ...over,
  } as unknown as Client
}

function depsIn(
  dir: string,
  over: Partial<InitDependencies> = {},
  http: Http = gitlab(EPICS),
): InitDependencies & { output: string[] } {
  const output: string[] = []
  const path = join(dir, 'roadmapper.toml')
  return {
    env: { GITLAB_TOKEN: 'glpat-invented', NOTION_TOKEN: 'ntn_invented' },
    configPath: path,
    configWasNamed: false,
    examplePath: EXAMPLE,
    load: () => validateConfig(readConfig(path)),
    readSource: (config) =>
      createEpicSource(config.core.host, 'glpat-invented', config.core, http).read({
        group: config.gitlab.group ?? '',
        subgroups: config.gitlab.subgroups,
        excludeTitles: config.gitlab.excludeTitles,
        includeClosed: config.gitlab.includeClosed,
      }),
    notionOf: () => notionStub(),
    out: (text) => void output.push(text),
    output,
    ...over,
  }
}

// --- step 1: the configuration -----------------------------------------

test('AK47b init without --config creates the file from the example, then stops', () => {
  const dir = scratch(null)
  const path = join(dir, 'roadmapper.toml')

  const result = configStep(path, false, EXAMPLE)

  assert.equal(result.done, true)
  assert.ok(existsSync(path))
  assert.equal(readFileSync(path, 'utf8'), readFileSync(EXAMPLE, 'utf8'))
  assert.match(result.message, /Edit it/)
})

test('AK47b init --config does NOT create the named file but aborts', () => {
  const dir = scratch(null)
  const path = join(dir, 'produktiv.toml')

  assert.throws(
    () => configStep(path, true, EXAMPLE),
    (e: unknown) => {
      assert.ok(e instanceof InitFailed)
      assert.equal(e.step, 1)
      assert.match(e.message, /never created/)
      return true
    },
  )
  // A typo must not leave an empty file beside the real one.
  assert.equal(existsSync(path), false)
})

test('an existing config is used as it stands', () => {
  const dir = scratch()
  const result = configStep(join(dir, 'roadmapper.toml'), false, EXAMPLE)
  assert.equal(result.done, undefined)
  assert.match(result.message, /Using/)
})

// --- step 2: the tokens -------------------------------------------------

test('missing tokens are reported at step 2, with where to get them', () => {
  assert.throws(
    () => tokenStep({ NOTION_TOKEN: 'ntn_x' }),
    (e: unknown) => {
      assert.ok(e instanceof InitFailed)
      assert.equal(e.step, 2)
      assert.match(e.message, /GITLAB_TOKEN/)
      assert.match(e.message, /read_api/)
      assert.equal(/NOTION_TOKEN,/.test(e.message), false, 'only the missing one is named')
      return true
    },
  )
})

test('both tokens missing names both', () => {
  assert.throws(() => tokenStep({}), /GITLAB_TOKEN, NOTION_TOKEN/)
})

// --- the sequence -------------------------------------------------------

test('R25 a complete init walks all six steps and ends clean', async () => {
  const deps = depsIn(scratch())
  const exitCode = await runInit(deps)

  const report = deps.output.join('')
  assert.equal(exitCode, 0)
  for (const title of ['Configuration', 'Credentials', 'GitLab', 'Notion', 'Target schema', 'Source']) {
    assert.match(report, new RegExp(title))
  }
  assert.match(report, /Everything checks out/)
})

test('R26 a failing step aborts: the later ones never run', async () => {
  const deps = depsIn(scratch(), { env: { NOTION_TOKEN: 'ntn_x' } })
  const exitCode = await runInit(deps)

  const report = deps.output.join('')
  assert.equal(exitCode, 1)
  assert.match(report, /Step 2 failed/)
  // Steps 3-6 build on the token, so reporting them too would mislead.
  assert.equal(/GitLab:/.test(report), false)
  assert.equal(/Notion:/.test(report), false)
})

test('R25 step 1 creating a config ends the run — nothing after it runs', async () => {
  const deps = depsIn(scratch(null))
  const exitCode = await runInit(deps)

  assert.equal(exitCode, 0)
  const report = deps.output.join('')
  assert.match(report, /Created/)
  assert.equal(/Credentials/.test(report), false)
})

test('R27 a 401 from GitLab is a token problem and says so', async () => {
  const deps = depsIn(scratch(), {}, failing(401))
  const exitCode = await runInit(deps)

  assert.equal(exitCode, 1)
  const report = deps.output.join('')
  assert.match(report, /Step 3 failed/)
  assert.match(report, /rejected the token/)
  assert.match(report, /read_api/)
})

test('R27 a 403 is a rights problem, not a token problem', async () => {
  const deps = depsIn(scratch(), {}, failing(403))
  const exitCode = await runInit(deps)

  const report = deps.output.join('')
  assert.equal(exitCode, 1)
  assert.match(report, /Step 3 failed/)
  assert.match(report, /may not read "acme\/product"/)
})

test('R27 an unshared Notion database names BOTH causes and the click path', async () => {
  const deps = depsIn(scratch(), {
    notionOf: () =>
      ({
        databases: {
          retrieve: async () => {
            throw new Error('Could not find database with ID: 0000. object_not_found')
          },
        },
      }) as unknown as Client,
  })

  const exitCode = await runInit(deps)
  const report = deps.output.join('')

  assert.equal(exitCode, 1)
  assert.match(report, /Step 4 failed/)
  // The two look identical from outside, and only one is about the id.
  assert.match(report, /the id is wrong/)
  assert.match(report, /not shared with the integration/)
  assert.match(report, /Connections/)
})

test('step 5 reports which columns existed and whether items get rows', async () => {
  const deps = depsIn(scratch())
  await runInit(deps)

  const report = deps.output.join('')
  assert.match(report, /4 of 4 configured columns existed/)
  assert.match(report, /"Level" is there — bundles AND items get rows/)
})

test('R25 step 5 CREATES a missing column instead of complaining about it', async () => {
  created.length = 0
  const properties = { ...SCHEMA.properties } as Record<string, unknown>
  delete properties['Status']

  const deps = depsIn(scratch(), { notionOf: () => notionStub({}, properties as typeof SCHEMA.properties) })
  const exitCode = await runInit(deps)

  assert.equal(exitCode, 0)
  assert.match(deps.output.join(''), /created: "Status"/)
  // A select column, as section 6 asks for.
  assert.deepEqual(Object.keys(created[0]!), ['Status'])
  assert.ok('select' in (created[0]!['Status'] as object))
})

test('a column that already exists is never touched — the target is someone else\'s table', async () => {
  created.length = 0
  const deps = depsIn(scratch())
  await runInit(deps)

  // Everything was there, so nothing was written at all.
  assert.deepEqual(created, [])
})

test('an unknown role in [columns] is refused rather than guessed at', async () => {
  const config = CONFIG.replace('type = "Level"', 'workstream = "Workstream"')
  const deps = depsIn(scratch(config))

  const exitCode = await runInit(deps)
  assert.equal(exitCode, 1)
  const report = deps.output.join('')
  assert.match(report, /Step 5 failed/)
  assert.match(report, /"workstream", which this tool does not know/)
  assert.match(report, /Known roles:/)
})

test('EC5 a target with no type column CONFIGURED writes bundles only', async () => {
  // Not the same as a missing column: without the entry in [columns] there
  // is nothing to create, and the levels cannot be told apart.
  const config = CONFIG.replace('type = "Level"\n', '')
  const deps = depsIn(scratch(config))

  await runInit(deps)
  assert.match(deps.output.join(''), /only bundles get rows/)
})

test('R25 even a mandatory column is created rather than demanded of the user', async () => {
  created.length = 0
  const properties = { ...SCHEMA.properties } as Record<string, unknown>
  delete properties['GitLab ID']

  const deps = depsIn(scratch(), { notionOf: () => notionStub({}, properties as typeof SCHEMA.properties) })
  const exitCode = await runInit(deps)

  // Setting the target up is what init is FOR (R25 step 5).
  assert.equal(exitCode, 0)
  assert.match(deps.output.join(''), /created: "GitLab ID"/)
})

test('step 6 reports an empty source as a gap, naming the subgroups switch', async () => {
  const deps = depsIn(scratch(), {}, gitlab(NO_EPICS))
  const exitCode = await runInit(deps)

  assert.equal(exitCode, 1)
  const report = deps.output.join('')
  assert.match(report, /Step 6 failed/)
  assert.match(report, /returns no bundles/)
  assert.match(report, /subgroups = true/)
})

test('R28 init writes nothing but the config: no PATH, no install, no cron', async () => {
  const dir = scratch()
  const deps = depsIn(dir)
  await runInit(deps)

  // The directory holds exactly what it held before.
  const { readdirSync } = await import('node:fs')
  assert.deepEqual(readdirSync(dir), ['roadmapper.toml'])
})

// --- Stage6-2: both stage sources side by side --------------------------

import { createSurveySource } from '../src/source/gitlab/survey.js'
import { compareSources } from '../src/init/compare.js'
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

/** The measured case from the spec: a status field present and 100 % filled
 *  with the default value, while the labels carry the real state. */
const MEASURED = {
  data: {
    group: {
      statuses: [
        { name: 'To do', category: 'to_do' },
        { name: 'In progress', category: 'in_progress' },
        { name: 'Done', category: 'done' },
      ],
      labels: {
        nodes: [
          { title: 'Flow::ToRefine' },
          { title: 'Flow::Verifying' },
          { title: 'Flow::Blocked' },
          { title: 'Rank::1' },
        ],
      },
      workItems: {
        nodes: [
          ...Array.from({ length: 6 }, () => ({
            widgets: [
              { status: { name: 'To do', category: 'to_do' } },
              { labels: { nodes: [{ title: 'Flow::ToRefine' }] } },
            ],
          })),
          {
            widgets: [
              { status: { name: 'To do', category: 'to_do' } },
              { labels: { nodes: [{ title: 'Flow::Verifying' }] } },
            ],
          },
          {
            widgets: [
              { status: { name: 'To do', category: 'to_do' } },
              { labels: { nodes: [{ title: 'Flow::Blocked' }] } },
            ],
          },
          { widgets: [{ status: { name: 'To do', category: 'to_do' } }, { labels: { nodes: [] } }] },
        ],
      },
    },
  },
}

test('R27b the survey reads both sources and the sample', async () => {
  const survey = await createSurveySource('gitlab.example.invalid', 'glpat-x', gitlab(MEASURED)).survey('acme/product')

  assert.equal(survey.defined.length, 3)
  assert.deepEqual(survey.defined[1], { name: 'In progress', category: 'active' })
  assert.deepEqual([...survey.prefixes].sort(), ['Rank', 'Workflow'])
  assert.equal(survey.sample.issues, 9)
  // The status field is filled on all nine — with one value.
  assert.deepEqual(survey.sample.byStatus, [{ value: 'To do', count: 9 }])
  // The labels spread across three.
  assert.equal(survey.sample.byLabel.length, 3)
})

test('R27b the comparison names "label" when the status field sits on ONE value', () => {
  const survey = {
    defined: [{ name: 'To do', category: 'todo' as const }],
    prefixes: ['Workflow'],
    sample: {
      issues: 9,
      byStatus: [{ value: 'To do', count: 9 }],
      byLabel: [
        { value: 'Flow::ToRefine', count: 6 },
        { value: 'Flow::Verifying', count: 1 },
      ],
    },
    complaints: [],
  }

  const text = compareSources(survey, cfg)

  assert.match(text, /Sampled 9 open issues/)
  assert.match(text, /9x To do\s+\(all on one value\)/)
  assert.match(text, /"label" fits this group/)
  assert.match(text, /sits entirely on "To do"/)
  // It advises, it does not decide.
  assert.match(text, /only after the status field carries your workflow/)
})

test('R27b the comparison names "status" when no issue carries a scoped label', () => {
  const survey = {
    defined: [{ name: 'In review', category: 'active' as const }],
    prefixes: [],
    sample: { issues: 5, byStatus: [{ value: 'In review', count: 3 }, { value: 'Done', count: 2 }], byLabel: [] },
    complaints: [],
  }

  assert.match(compareSources(survey, cfg), /"status" fits this group/)
})

test('R27a no matching label names the prefixes the group actually carries', () => {
  const survey = {
    defined: [],
    prefixes: ['Stage', 'Rank', 'team'],
    sample: {
      issues: 4,
      byStatus: [],
      byLabel: [{ value: 'Stage::InProgress', count: 3 }, { value: 'Rank::1', count: 1 }],
    },
    complaints: [],
  }

  const text = compareSources(survey, cfg)

  // The configured prefix is Workflow, the group carries others.
  assert.match(text, /No label matches "Workflow"/)
  assert.match(text, /Scoped labels found in the group: Stage, Rank, team/)
  assert.match(text, /Adjust \[status\], or drop the state column/)
  // Naming what IS there is not suggesting content (ADR-0006).
  assert.equal(/set stage_source/.test(text), false)
})

test('a sample of nothing says so instead of advising on air', () => {
  const survey = { defined: [], prefixes: [], sample: { issues: 0, byStatus: [], byLabel: [] }, complaints: [] }
  const text = compareSources(survey, cfg)

  assert.match(text, /No open issues to sample/)
  assert.equal(/fits this group/.test(text), false)
})

test('an instance without the status field says that, rather than showing zero', () => {
  const survey = {
    defined: [],
    prefixes: ['Workflow'],
    sample: { issues: 3, byStatus: [], byLabel: [{ value: 'Flow::Doing', count: 3 }] },
    complaints: [],
  }

  assert.match(compareSources(survey, cfg), /Status field: not available on this instance/)
})

test('the comparison reaches init, after the checks passed', async () => {
  const deps = depsIn(scratch(), {
    surveyOf: () => createSurveySource('gitlab.example.invalid', 'glpat-x', gitlab(MEASURED)),
  })

  const exitCode = await runInit(deps)
  const report = deps.output.join('')

  assert.equal(exitCode, 0)
  assert.match(report, /Everything checks out/)
  assert.match(report, /Sampled 9 open issues/)
})

test('a survey that fails does not fail an otherwise healthy init', async () => {
  const deps = depsIn(scratch(), {
    surveyOf: () => createSurveySource('gitlab.example.invalid', 'glpat-x', failing(500)),
  })

  // The advice is worth having, not worth blocking on.
  assert.equal(await runInit(deps), 0)
  assert.match(deps.output.join(''), /Everything checks out/)
})

// --- Stage6-3: every message names the click path -----------------------

import {
  notionNotVisible,
  notionReadOnly,
  notionTokenRefused,
  gitlabTokenRefused,
  gitlabGroupForbidden,
  noEpics,
  statusFieldMissing,
  groupMilestoneGap,
} from '../src/messages.js'
import { outcomeOf } from '../src/report/outcome.js'
import { StatusFieldMissing } from '../src/source/gitlab/translate.js'

test('R27 the not-visible message names BOTH causes and the sharing click path', () => {
  const text = notionNotVisible('0000-1111', 'object_not_found')

  // The two are indistinguishable from outside, so both are named — and the
  // common one last, where it is read.
  assert.match(text, /the id is wrong/)
  assert.match(text, /not shared with the integration/)
  assert.match(text, /··· → Connections → add your integration/)
  assert.match(text, /object_not_found/)
})

test('R27 the read-only message names the edit-rights click path', () => {
  assert.match(notionReadOnly(), /Connections → your integration → Can edit/)
})

test('R27 the read-only message is written ONCE and used in both places', () => {
  // Same situation, two moments: init sees it as a check, the run sees it
  // when every row failed. A message that drifts between two copies is worse
  // than one that is merely terse.
  const failures = rowsFor(3).map((r) => ({ key: r.key, reason: '403 restricted_resource' }))
  const outcome = outcomeOf(rowsFor(3), { created: 0, updated: 0, duplicates: [], failures, unusable: [] }, [])

  assert.ok(outcome.problems.join('\n').includes(notionReadOnly()))
})

test('R27 the GitLab messages name the scope and the group', () => {
  assert.match(gitlabTokenRefused('gitlab.example.invalid'), /gitlab\.example\.invalid → Settings → Access tokens/)
  assert.match(gitlabTokenRefused('x'), /read_api/)
  assert.match(gitlabGroupForbidden('acme/product'), /may not read "acme\/product"/)
  assert.match(notionTokenRefused(), /notion\.so\/profile\/integrations/)
})

test('R27 no epics names bundle = "milestone" as the way out — epics are Premium', () => {
  const text = noEpics('acme/product', false)

  assert.match(text, /subgroups = true/)
  assert.match(text, /GitLab Premium feature/)
  assert.match(text, /bundle = "milestone"/)
})

test('EC7b the status-field message names 17.11 AND the label fallback', () => {
  const text = statusFieldMissing()

  assert.match(text, /17\.11/)
  assert.match(text, /stage_source = "label"/)
  // Never a silent switch: that would be a guess about a configuration a
  // human wrote deliberately.
  assert.equal(new StatusFieldMissing().message, text)
})

test('section 17 the group-milestone gap is named, and says what goes WRONG', () => {
  const text = groupMilestoneGap(['acme/product/app', 'acme/product/api'])

  assert.match(text, /group milestones are not supported/)
  assert.match(text, /acme\/product\/app, acme\/product\/api/)
  // Worse than missing: the query reaches through and returns foreign items,
  // so the bundles hold too MANY rather than none.
  assert.match(text, /reaches through/)
  assert.match(text, /more items than they should/)
})

test('init prints the group-milestone note when milestones are configured', async () => {
  const config = CONFIG.replace('bundle = "epic"', 'bundle = "milestone"').replace(
    'group = "acme/product"',
    'projects = ["acme/product/app"]',
  )
  const dir = scratch(config)
  const deps = depsIn(dir)

  await runInit(deps)
  assert.match(deps.output.join(''), /group milestones are not supported/)
})

/** Minimal rows for the outcome check above. */
function rowsFor(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    level: 'bundle' as const,
    key: `acme/product&${i + 1}`,
    number: i + 1,
    name: 'x',
    state: 'In progress',
    closed: false,
    progress: null,
    url: 'https://gitlab.example.invalid/x',
    due: null,
    activity: new Date('2026-08-01T00:00:00Z'),
    health: null,
    description: '',
    items: [],
    bundle: null,
  }))
}

test('the state column is created WITH the board values, not as an empty select', async () => {
  // Measured against a real database: an empty select passes every stub but
  // makes the very next run stop at its own pre-check, telling the user to
  // add options the tool already knows.
  created.length = 0
  const properties = { ...SCHEMA.properties } as Record<string, unknown>
  delete properties['Status']

  const deps = depsIn(scratch(), { notionOf: () => notionStub({}, properties as typeof SCHEMA.properties) })
  await runInit(deps)

  const status = created[0]!['Status'] as { select: { options: { name: string }[] } }
  const names = status.select.options.map((o) => o.name)

  // Every target value from [status], plus closed and default.
  assert.ok(names.includes('In progress'), names.join(','))
  assert.ok(names.includes('Released'))
  assert.ok(names.includes('Backlog'))
})
