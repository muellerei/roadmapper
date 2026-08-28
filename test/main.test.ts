import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, UsageError } from '../src/cli.js'
import { main, type Environment } from '../src/main.js'
import { ConfigFileMissing } from '../src/config/read.js'
import { ConfigInvalid } from '../src/config/validate.js'

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
`

function scratch(config: string | null = CONFIG, name = 'roadmapper.toml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'roadmapper-main-'))
  if (config !== null) writeFileSync(join(dir, name), config)
  return dir
}

function environmentIn(cwd: string, env: Record<string, string | undefined> = {}): Environment & { output: string[]; errors: string[] } {
  const output: string[] = []
  const errors: string[] = []
  return {
    cwd,
    env: { GITLAB_TOKEN: 'glpat-invented', NOTION_TOKEN: 'ntn_invented', ...env },
    out: (text) => void output.push(text),
    err: (text) => void errors.push(text),
    output,
    errors,
  }
}

// --- the argument parser ------------------------------------------------

test('R23 the two subcommands are dispatched apart', () => {
  assert.deepEqual(parseArgs([]), { command: 'run', config: undefined })
  assert.deepEqual(parseArgs(['init']), { command: 'init', config: undefined })
})

test('AK47 --config is honoured by BOTH subcommands', () => {
  assert.deepEqual(parseArgs(['--config', 'produktiv.toml']), { command: 'run', config: 'produktiv.toml' })
  assert.deepEqual(parseArgs(['init', '--config', 'neu.toml']), { command: 'init', config: 'neu.toml' })
  // The = form too, because people write both.
  assert.deepEqual(parseArgs(['--config=produktiv.toml']), { command: 'run', config: 'produktiv.toml' })
})

test('--config without a value is a usage error, not a silent default', () => {
  assert.throws(() => parseArgs(['--config']), UsageError)
  assert.throws(() => parseArgs(['--config=']), UsageError)
})

test('an unknown argument is refused rather than ignored', () => {
  assert.throws(() => parseArgs(['--verbose']), (e: unknown) => {
    assert.ok(e instanceof UsageError)
    assert.match(e.message, /--verbose/)
    // The message shows what IS accepted.
    assert.match(e.message, /roadmapper init/)
    return true
  })
})

// --- the wiring ---------------------------------------------------------

test('R24 a missing token is reported BEFORE any network call', async () => {
  const dir = scratch()
  const environment = environmentIn(dir, { GITLAB_TOKEN: undefined })

  await assert.rejects(
    () => main([], environment),
    (e: unknown) => {
      assert.ok(e instanceof ConfigInvalid)
      assert.match(e.message, /GITLAB_TOKEN is not set/)
      assert.match(e.message, /from the environment, not from the config file/)
      return true
    },
  )
})

test('R24 the Notion token is required too', async () => {
  const dir = scratch()
  await assert.rejects(() => main([], environmentIn(dir, { NOTION_TOKEN: '' })), /NOTION_TOKEN is not set/)
})

test('AK47 a missing config aborts, naming the absolute path', async () => {
  const dir = scratch(null)
  await assert.rejects(
    () => main([], environmentIn(dir)),
    (e: unknown) => {
      assert.ok(e instanceof ConfigFileMissing)
      assert.equal(e.path, join(dir, 'roadmapper.toml'))
      return true
    },
  )
})

test('AK47 --config picks the named file, resolved against the working directory', async () => {
  const dir = scratch(CONFIG.replace('gitlab.example.invalid', 'named.invalid'), 'produktiv.toml')
  // The named file is read: its host reaches the source, which fails on the
  // network — proving the config was taken, not the default.
  await assert.rejects(() => main(['--config', 'produktiv.toml'], environmentIn(dir)), (e: unknown) => {
    assert.ok(!(e instanceof ConfigFileMissing), 'the named file was found')
    return true
  })
})

test('an invalid config is refused before anything else happens', async () => {
  const dir = scratch(CONFIG.replace('closed = "Released"', 'closed = "Backlog"'))
  await assert.rejects(() => main([], environmentIn(dir)), ConfigInvalid)
})

test('the source is chosen by [gitlab].bundle', async () => {
  // Both kinds now reach their own source: the epic query asks for
  // workItems, the milestone query for milestones. The call fails on the
  // network either way — what it asked for is the point.
  const asked: string[] = []
  const http = async (_url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)).query)
    throw new TypeError('fetch failed')
  }

  const epics = scratch()
  await assert.rejects(() => main([], { ...environmentIn(epics), http }))
  assert.match(asked[0]!, /workItems/)

  asked.length = 0
  const milestones = scratch(
    CONFIG.replace('bundle = "epic"', 'bundle = "milestone"').replace(
      'group = "acme/product"',
      'projects = ["acme/product/app"]',
    ),
  )
  await assert.rejects(() => main([], { ...environmentIn(milestones), http }))
  assert.match(asked[0]!, /milestones\(/)
})

test('init asks the source [gitlab].bundle names, not always the epic one', async () => {
  // The run path branches on the bundle kind; init did not, and asked for
  // epics of a group a milestone configuration never sets — GitLab got
  // `group: ""` and the step failed with a message about epics and
  // subgroups, neither of which the user had configured.
  const asked: string[] = []
  const http = async (_url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)).query)
    throw new TypeError('fetch failed')
  }

  const milestones = scratch(
    CONFIG.replace('bundle = "epic"', 'bundle = "milestone"').replace(
      'group = "acme/product"',
      'projects = ["acme/product/app"]',
    ),
  )
  const environment = { ...environmentIn(milestones), http }
  await main(['init'], environment)

  assert.ok(asked.length > 0, 'init must reach GitLab at step 3')
  assert.match(asked[0]!, /milestones\(/)
  assert.doesNotMatch(asked[0]!, /workItems/)
})

test('init is dispatched to its own path, not to the run', async () => {
  const dir = scratch()
  const environment = environmentIn(dir)

  // No stubs here, so init fails at step 3 when it tries to reach GitLab —
  // which is already proof it took the init path and got past steps 1 and 2.
  const exitCode = await main(['init'], environment)

  assert.equal(exitCode, 1)
  const report = environment.output.join('')
  assert.match(report, /Configuration/)
  assert.match(report, /Credentials/)
})

test('R22 the module holds no mutable state between imports', async () => {
  const one = await import('../src/main.js')
  const two = await import('../src/main.js')
  // Same module instance, and nothing on it that a run could mutate.
  assert.equal(one.main, two.main)
  assert.deepEqual(Object.keys(one).sort(), ['Environment', 'cli', 'main'].filter((k) => k in one).sort())
})

test('--help is not an error: it prints the usage and exits 0', async () => {
  const dir = scratch(null)
  const environment = environmentIn(dir)

  assert.equal(await main(['--help'], environment), 0)
  assert.match(environment.output.join(''), /Usage:/)
  assert.deepEqual(environment.errors, [])
  // And it does not need a config file to work.
  assert.equal(await main(['-h'], environment), 0)
})

test('the packaged entry point is reachable and executable', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    bin: Record<string, string>
    main: string
    files: string[]
  }

  // npm installs a bin as a SYMLINK, so main.ts compares RESOLVED paths —
  // comparing them raw makes the installed command do nothing at all, which
  // is the one way every user starts it. This test guards the paths that
  // make that reachable in the first place.
  const entry = pkg.bin['roadmapper']!
  assert.equal(entry, './dist/src/main.js', 'bin must point at the built layout, which keeps src/')
  assert.equal(pkg.main, entry)

  const built = readFileSync(entry.slice(2), 'utf8')
  assert.match(built, /^#!\/usr\/bin\/env node/, 'a bin needs a shebang')

  // The compiled tests must not ship.
  assert.ok(pkg.files.includes('dist/src/'))
  assert.equal(pkg.files.includes('dist/'), false)
})
