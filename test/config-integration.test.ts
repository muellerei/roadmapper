import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPathOf, readConfig } from '../src/config/read.js'
import { validateConfig, ConfigInvalid } from '../src/config/validate.js'
import { stateOf } from '../src/core/state.js'
import type { Bundle, Item, Stage } from '../src/core/types.js'

/**
 * The group integration gate for stage 2. Reading and validating pass their
 * own tests; this proves the CHAIN — a TOML file on disk becomes a
 * CoreConfig that the stage 1 core functions actually accept.
 *
 * Nothing before this ran file -> parse -> validate -> core end to end.
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
"Flow::Doing" = "Wird bearbeitet"
"Flow::Blocked" = "Haengt"
default = "Nicht begonnen"
closed = "Abgeschlossen"
active = ["Wird bearbeitet"]
blocked = ["Haengt"]

[columns]
key = "GitLab ID"
name = "Feature"
`

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'roadmapper-integration-'))
}

function stage(over: Partial<Stage> = {}): Stage {
  return { category: null, categoryName: null, label: null, ...over }
}

function item(label: string | null, closed = false): Item {
  return {
    key: 'acme/product/app#1',
    number: 1,
    title: 'An issue',
    description: '',
    closed,
    stage: stage({ label }),
    url: 'https://gitlab.example.invalid/acme/product/app/-/issues/1',
    bundle: 'acme/product&1',
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    health: null,
  }
}

function bundle(items: Item[]): Bundle {
  return {
    key: 'acme/product&1',
    number: 1,
    name: 'A bundle',
    description: '',
    closed: false,
    due: null,
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/1',
    progress: null,
    lastActivity: new Date('2026-08-01T00:00:00Z'),
    health: null,
    items,
    children: [],
  }
}

test('a file on disk becomes a CoreConfig the core accepts', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'roadmapper.toml'), CONFIG)

  const cfg = validateConfig(readConfig(configPathOf(undefined, dir))).core

  // The values the board speaks come out of the file, not out of the code —
  // German here on purpose: they are DATA passing through, and the tool
  // never translates them.
  assert.equal(stateOf(bundle([item('Flow::Doing')]), cfg), 'Wird bearbeitet')
  assert.equal(stateOf(bundle([item('Flow::Blocked')]), cfg), 'Haengt')
  assert.equal(stateOf(bundle([item(null)]), cfg), 'Nicht begonnen')
  assert.equal(stateOf(bundle([item('Flow::Doing', true)]), cfg), 'Abgeschlossen')
  assert.equal(stateOf(bundle([]), cfg), 'Nicht begonnen')
})

test('statusMap arrives as a Map and the lists as arrays, exactly as CoreConfig asks', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'roadmapper.toml'), CONFIG)
  const cfg = validateConfig(readConfig(configPathOf(undefined, dir))).core

  assert.ok(cfg.statusMap instanceof Map)
  assert.equal(cfg.statusMap.get('Flow::Doing'), 'Wird bearbeitet')
  assert.ok(Array.isArray(cfg.active))
  assert.ok(Array.isArray(cfg.blocked))
})

test('a wrong-case value is rejected at validation and never reaches the core', () => {
  const dir = scratch()
  writeFileSync(join(dir, 'roadmapper.toml'), CONFIG.replace('active = ["Wird bearbeitet"]', 'active = ["Wird Bearbeitet"]'))

  assert.throws(
    () => validateConfig(readConfig(configPathOf(undefined, dir))),
    (e: unknown) => {
      assert.ok(e instanceof ConfigInvalid)
      assert.match(e.message, /"Wird Bearbeitet"/)
      assert.match(e.message, /"Wird bearbeitet"/)
      return true
    },
  )
})

test('the shipped example survives its own validation and drives the core', () => {
  const dir = scratch()
  const path = join(dir, 'roadmapper.toml')
  copyFileSync('roadmapper.example.toml', path)

  const cfg = validateConfig(readConfig(configPathOf(undefined, dir))).core

  assert.notEqual(cfg.closed, cfg.default)
  assert.equal(stateOf(bundle([item('Flow::Doing')]), cfg), 'In progress')
  assert.equal(stateOf(bundle([item('Flow::Blocked')]), cfg), 'Blocked')
})

test('the order in active decides when the triggering children disagree', () => {
  const dir = scratch()
  writeFileSync(
    join(dir, 'roadmapper.toml'),
    CONFIG.replace('"Flow::Blocked" = "Haengt"', '"Flow::Review" = "In Pruefung"\n"Flow::Blocked" = "Haengt"').replace(
      'active = ["Wird bearbeitet"]',
      'active = ["In Pruefung", "Wird bearbeitet"]',
    ),
  )
  const cfg = validateConfig(readConfig(configPathOf(undefined, dir))).core

  const mixed = bundle([item('Flow::Doing'), item('Flow::Review')])
  // Not the first child delivered — the value the configuration names first.
  assert.equal(stateOf(mixed, cfg), 'In Pruefung')
})
