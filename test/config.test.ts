import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPathOf, readConfig, ConfigFileMissing } from '../src/config/read.js'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'roadmapper-config-'))
}

test('AK47 without --config it reads roadmapper.toml in the working directory', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'roadmapper.toml'), '[gitlab]\nhost = "gitlab.example.invalid"\n')

  assert.equal(configPathOf(undefined, dir), join(dir, 'roadmapper.toml'))
  const raw = readConfig(configPathOf(undefined, dir))
  assert.deepEqual(raw, { gitlab: { host: 'gitlab.example.invalid' } })
})

test('AK47 --config names the file that is read', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'roadmapper.toml'), '[gitlab]\nhost = "wrong.invalid"\n')
  writeFileSync(join(dir, 'other.toml'), '[gitlab]\nhost = "right.invalid"\n')

  const raw = readConfig(configPathOf('other.toml', dir)) as { gitlab: { host: string } }
  assert.equal(raw.gitlab.host, 'right.invalid')
})

test('AK47 a named but missing file aborts and names the absolute path', () => {
  const dir = scratch()
  // The default exists — the run must NOT silently fall back to it.
  writeFileSync(join(dir, 'roadmapper.toml'), '[gitlab]\nhost = "fallback.invalid"\n')

  const path = configPathOf('produktiv.toml', dir)
  assert.throws(
    () => readConfig(path),
    (e: unknown) => {
      assert.ok(e instanceof ConfigFileMissing)
      assert.equal(e.path, join(dir, 'produktiv.toml'))
      assert.match(e.message, /Config file not found: \//)
      assert.match(e.message, /relative paths resolve against the working directory/)
      return true
    },
  )
})

test('AK47a a relative path resolves against the working directory', () => {
  const one = scratch()
  const two = scratch()
  writeFileSync(join(one, 'shared.toml'), '[gitlab]\nhost = "one.invalid"\n')
  writeFileSync(join(two, 'shared.toml'), '[gitlab]\nhost = "two.invalid"\n')

  const fromOne = readConfig(configPathOf('shared.toml', one)) as { gitlab: { host: string } }
  const fromTwo = readConfig(configPathOf('shared.toml', two)) as { gitlab: { host: string } }

  assert.equal(fromOne.gitlab.host, 'one.invalid')
  assert.equal(fromTwo.gitlab.host, 'two.invalid')
})

test('AK47a an absolute path is taken as it stands', () => {
  const dir = scratch()
  const absolute = join(dir, 'absolute.toml')
  writeFileSync(absolute, '[gitlab]\nhost = "absolute.invalid"\n')

  assert.equal(configPathOf(absolute, '/some/other/place'), absolute)
})

test('a parent directory is never searched', () => {
  const parent = scratch()
  const child = join(parent, 'nested')
  mkdirSync(child)
  writeFileSync(join(parent, 'roadmapper.toml'), '[gitlab]\nhost = "parent.invalid"\n')

  assert.throws(() => readConfig(configPathOf(undefined, child)), ConfigFileMissing)
})

test('a broken TOML file fails as a content problem, naming the file', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'roadmapper.toml'), '[gitlab\nhost = "unclosed"\n')

  assert.throws(
    () => readConfig(configPathOf(undefined, dir)),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.ok(!(e instanceof ConfigFileMissing), 'a parse error is not a missing file')
      assert.match(e.message, /roadmapper\.toml/)
      return true
    },
  )
})

test('the example config in the repo root parses', () => {
  const raw = readConfig(configPathOf('roadmapper.example.toml', process.cwd()))
  assert.equal(typeof raw, 'object')
  assert.ok(raw !== null)
})

test('AK47b a run without a config never creates one', () => {
  const dir = scratch()
  assert.throws(() => readConfig(configPathOf(undefined, dir)), ConfigFileMissing)
  assert.equal(existsSync(join(dir, 'roadmapper.toml')), false)
})

test('AK47b the missing-default message points at init', () => {
  const dir = scratch()
  assert.throws(
    () => readConfig(configPathOf(undefined, dir)),
    (e: unknown) => {
      assert.ok(e instanceof ConfigFileMissing)
      assert.match(e.message, /roadmapper init/)
      return true
    },
  )
})

test('AK47b a named missing file does NOT point at init — it is a typo, not a setup gap', () => {
  const dir = scratch()
  assert.throws(
    () => readConfig(configPathOf('produktiv.toml', dir)),
    (e: unknown) => {
      assert.ok(e instanceof ConfigFileMissing)
      assert.ok(!/roadmapper init/.test(e.message), e.message)
      return true
    },
  )
})

test('the example file that init copies is readable from the repo', () => {
  const example = readFileSync('roadmapper.example.toml', 'utf8')
  assert.match(example, /\[gitlab\]/)
})

// --- Stage2-2: validation (R29) -----------------------------------------

import { validateBlockedAgainstSource, validateConfig, ConfigInvalid } from '../src/config/validate.js'
import { parse } from 'smol-toml'

/** A config that passes every check, so each test below can break exactly
 *  one thing and prove that this one thing is what gets rejected. */
const SOUND = `
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
"Flow::Blocked" = "Blocked"
default = "Backlog"
closed = "Released"
active = ["In progress"]
blocked = ["Blocked"]

[columns]
key = "GitLab ID"
name = "Feature"
`

const withConfig = (toml: string) => validateConfig(parse(toml))
const rejects = (toml: string, expected: RegExp) =>
  assert.throws(
    () => withConfig(toml),
    (e: unknown) => {
      assert.ok(e instanceof ConfigInvalid, `expected ConfigInvalid, got ${String(e)}`)
      assert.match(e.message, expected)
      return true
    },
  )

test('the sound config validates and produces a CoreConfig', () => {
  const cfg = withConfig(SOUND)
  assert.equal(cfg.core.host, 'gitlab.example.invalid')
  assert.equal(cfg.core.keyIs, 'id')
  assert.equal(cfg.core.stageSource, 'label')
  assert.equal(cfg.core.closed, 'Released')
  assert.equal(cfg.core.default, 'Backlog')
  assert.deepEqual(cfg.core.active, ['In progress'])
  assert.equal(cfg.core.statusMap.get('Flow::Doing'), 'In progress')
  // The reserved keys are not label mappings.
  assert.equal(cfg.core.statusMap.has('default'), false)
  assert.equal(cfg.core.statusMap.has('closed'), false)
})

test('AK21 a typo in active is rejected, naming the unknown AND the available values', () => {
  rejects(
    SOUND.replace('active = ["In progress"]', 'active = ["In Progress"]'),
    /"In Progress".*not a value in \[status\][\s\S]*Available:.*"In progress"/,
  )
})

test('AK21 the same check guards blocked', () => {
  rejects(SOUND.replace('blocked = ["Blocked"]', 'blocked = ["blocked"]'), /status\.blocked names "blocked"/)
})

test('AK22 a config without columns.key is rejected', () => {
  rejects(SOUND.replace('key = "GitLab ID"\n', ''), /columns\.key is missing/)
})

test('AK22 a config without columns.name is rejected', () => {
  rejects(SOUND.replace('name = "Feature"\n', ''), /columns\.name is missing/)
})

/**
 * Two roles on one column name. Perfectly valid TOML, and the row it produces
 * carries one of the two values — the writer builds a flat record per row, so
 * the later assignment wins.
 *
 * Where the KEY is the one overwritten, the target holds a row the next run
 * cannot find: it creates the row again, every night, and nothing reports it.
 * Measured against the writer before this check existed: the key never reached
 * the target at all.
 */
test('two roles naming one column are rejected, naming both roles', () => {
  rejects(
    SOUND.replace('name = "Feature"', 'name = "GitLab ID"'),
    /columns\.key and columns\.name both name "GitLab ID"/,
  )
})

test('the same check catches an optional role colliding with a mandatory one', () => {
  rejects(
    `${SOUND}url = "Feature"\n`,
    /columns\.name and columns\.url both name "Feature"/,
  )
})

test('distinct column names pass', () => {
  const config = withConfig(`${SOUND}url = "Link"\n`)
  assert.equal(config.notion.columns['url'], 'Link')
  assert.equal(config.notion.columns['key'], 'GitLab ID')
})

test('AK7i a third stage_source is rejected, not reset to the default', () => {
  rejects(SOUND.replace('stage_source = "label"', 'stage_source = "beides"'), /"beides".*"label" or "status"/)
})

test('AK43a closed equal to default is rejected, naming both ways out', () => {
  rejects(SOUND.replace('closed = "Released"', 'closed = "Backlog"'), /both "Backlog"[\s\S]*change status\.default/)
})

test('AK43a a missing closed falls back to default and is therefore rejected', () => {
  rejects(SOUND.replace('closed = "Released"\n', ''), /status\.closed and status\.default are both "Backlog"/)
})

test('AK49 a host carrying a scheme is rejected', () => {
  rejects(SOUND.replace('host = "gitlab.example.invalid"', 'host = "https://gitlab.com"'), /bare hostname/)
})

test('AK49 a host carrying a trailing slash is rejected', () => {
  rejects(SOUND.replace('host = "gitlab.example.invalid"', 'host = "gitlab.com/"'), /bare hostname/)
})

test('AK49 a bare hostname is accepted', () => {
  assert.equal(withConfig(SOUND.replace('host = "gitlab.example.invalid"', 'host = "gitlab.com"')).core.host, 'gitlab.com')
})

test('R7b keys carrying two prefixes are rejected, naming both', () => {
  rejects(
    SOUND.replace('"Flow::Blocked" = "Blocked"', '"Rank::1" = "Blocked"'),
    /more than one prefix[\s\S]*"Workflow"[\s\S]*"Rank"/,
  )
})

test('R7b one prefix across all keys is accepted', () => {
  assert.equal(withConfig(SOUND).core.statusMap.size, 2)
})

test('active and blocked may not overlap', () => {
  rejects(
    SOUND.replace('blocked = ["Blocked"]', 'blocked = ["Blocked", "In progress"]'),
    /both name "In progress"/,
  )
})

test('a third key_is is rejected — a silent default would produce duplicates', () => {
  rejects(SOUND.replace('key_is = "id"', 'key_is = "beides"'), /notion\.key_is is "beides".*"id" or "url"/)
})

test('a missing notion.database is rejected', () => {
  rejects(SOUND.replace('database = "00000000-0000-0000-0000-000000000000"\n', ''), /notion\.database is missing/)
})

test('bundle = "epic" without a group is rejected', () => {
  rejects(SOUND.replace('group = "acme/product"\n', ''), /gitlab\.group is missing/)
})

test('bundle = "milestone" with an empty projects list is rejected', () => {
  rejects(
    SOUND.replace('bundle = "epic"', 'bundle = "milestone"').replace('group = "acme/product"', 'projects = []'),
    /gitlab\.projects is empty/,
  )
})

test('under stage_source = "status" blocked is not checked against [status] WHILE READING THE FILE', () => {
  // There the values are the board's status NAMES, which only the source can
  // supply. The check is not skipped, it moves: validateBlockedAgainstSource
  // runs it after the first read and before the first write (tested below).
  const cfg = withConfig(
    SOUND.replace('stage_source = "label"', 'stage_source = "status"')
      .replace('active = ["In progress"]\n', '')
      .replace('blocked = ["Blocked"]', 'blocked = ["Some board status"]'),
  )
  assert.deepEqual(cfg.core.blocked, ['Some board status'])
})

test('the example config in the repo validates', () => {
  const cfg = validateConfig(readConfig(configPathOf('roadmapper.example.toml', process.cwd())))
  assert.equal(typeof cfg.core.host, 'string')
  assert.notEqual(cfg.core.closed, cfg.core.default)
})

test('R29 blocked IS checked under stage_source = "status", against the delivered names', () => {
  // The half of R29 that needs the source. It matters most here: with
  // "status" the blocked list is the ONLY source for "blocked at all",
  // because GitLab's categories have none.
  const cfg = withConfig(
    SOUND.replace('stage_source = "label"', 'stage_source = "status"')
      .replace('active = ["In progress"]\n', '')
      .replace('blocked = ["Blocked"]', 'blocked = ["Blockiert"]'),
  ).core

  assert.throws(
    () => validateBlockedAgainstSource(cfg, ['In review', 'Blocked', 'To do']),
    (e: unknown) => {
      assert.ok(e instanceof ConfigInvalid)
      assert.match(e.message, /"Blockiert", which no item in the source carries/)
      assert.match(e.message, /Found in the source: "In review", "Blocked", "To do"/)
      return true
    },
  )
})

test('R29 a blocked value the source does deliver passes', () => {
  const cfg = withConfig(
    SOUND.replace('stage_source = "label"', 'stage_source = "status"').replace('active = ["In progress"]\n', ''),
  ).core

  validateBlockedAgainstSource(cfg, ['Blocked', 'In review'])
})

test('R29 under stage_source = "label" this check does not apply', () => {
  // There the values are [status] targets, already checked while reading the
  // file — holding them against status names would reject a sound config.
  const cfg = withConfig(SOUND).core
  validateBlockedAgainstSource(cfg, ['something else entirely'])
})

test('R29 an empty blocked list has nothing to check', () => {
  const cfg = withConfig(
    SOUND.replace('stage_source = "label"', 'stage_source = "status"')
      .replace('active = ["In progress"]\n', '')
      .replace('blocked = ["Blocked"]\n', ''),
  ).core

  validateBlockedAgainstSource(cfg, [])
})

test('R7b a [status] table of FLAT labels is accepted — they count as one prefix', () => {
  // This was rejected before: the validation returned the label itself as
  // its prefix, so two flat labels looked like two prefixes. R7b says
  // "flache Labels ohne :: zaehlen als eines".
  const flat = SOUND.replace('"Flow::Doing" = "In progress"', '"wip" = "In progress"').replace(
    '"Flow::Blocked" = "Blocked"',
    '"review" = "Blocked"',
  )

  const cfg = withConfig(flat)
  assert.equal(cfg.core.statusMap.get('wip'), 'In progress')
  assert.equal(cfg.core.statusMap.get('review'), 'Blocked')
})

test('R7b mixing a flat label with a scoped one is still two prefixes', () => {
  const mixed = SOUND.replace('"Flow::Blocked" = "Blocked"', '"review" = "Blocked"')
  rejects(mixed, /more than one prefix/)
})
