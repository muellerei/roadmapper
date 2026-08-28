import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bodyOf } from '../src/output/notion/body.js'
import type { Row } from '../src/core/types.js'

function row(over: Partial<Row> = {}): Row {
  return {
    level: 'bundle',
    key: 'acme/product&7',
    number: 7,
    name: 'The bundle',
    state: 'In progress',
    closed: false,
    progress: { done: 12, total: 30, ratio: 0.4 },
    url: 'https://gitlab.example.invalid/groups/acme/product/-/epics/7',
    due: null,
    activity: new Date('2026-08-21T00:00:00Z'),
    health: null,
    description: 'What this is about.',
    items: [],
    ...over,
  }
}

function itemRow(number: number, name: string, closed: boolean): Row {
  return row({
    level: 'item',
    key: `acme/product/app#${number}`,
    number,
    name,
    closed,
    progress: null,
    url: `https://gitlab.example.invalid/acme/product/app/-/issues/${number}`,
    items: [],
  })
}

/** The plain text of a block, so a test can assert on what a reader sees
 *  rather than on the block shape. */
function textOf(block: any): string {
  const rich = block.paragraph?.rich_text ?? block.bulleted_list_item?.rich_text ?? []
  return rich.map((r: any) => r.text.content).join('')
}

const textsOf = (blocks: unknown[]) => blocks.map(textOf)

test('the link sits at the top, before anything else', () => {
  const blocks = bodyOf(row(), true) as any[]
  assert.equal(textOf(blocks[0]), 'Open in GitLab')
  assert.equal(blocks[0].paragraph.rich_text[0].text.link.url, row().url)
})

test('a bundle carries its progress as counted numbers, not as a percentage', () => {
  const texts = textsOf(bodyOf(row(), true))
  assert.ok(texts.some((t) => t.includes('Progress: 12 of 30 done')), texts.join(' | '))
})

test('a bundle with no progress carries no progress line', () => {
  const texts = textsOf(bodyOf(row({ progress: null }), true))
  assert.equal(texts.some((t) => t.includes('Progress:')), false)
})

test('the last-activity line appears only when the column is absent', () => {
  const withColumn = textsOf(bodyOf(row(), true))
  assert.equal(withColumn.some((t) => t.includes('Last activity')), false)

  const without = textsOf(bodyOf(row(), false))
  assert.ok(without.some((t) => t.includes('Last activity: 2026-08-21')), without.join(' | '))
})

test('closed items come first, and carry ✓ against ○', () => {
  const items = [itemRow(14, 'An open item', false), itemRow(12, 'A closed item', true)]
  const bullets = (bodyOf(row({ items }), true) as any[]).filter((b) => b.type === 'bulleted_list_item')

  assert.equal(bullets.length, 2)
  assert.match(textOf(bullets[0]), /^✓ #12 A closed item$/)
  assert.match(textOf(bullets[1]), /^○ #14 An open item$/)
})

test('an item number links to the item, not to the bundle', () => {
  const items = [itemRow(12, 'A closed item', true)]
  const bullet = (bodyOf(row({ items }), true) as any[]).find((b) => b.type === 'bulleted_list_item')
  assert.equal(
    bullet.bulleted_list_item.rich_text[1].text.link.url,
    'https://gitlab.example.invalid/acme/product/app/-/issues/12',
  )
})

test('the items are checkboxes for nobody — plain characters only', () => {
  const items = [itemRow(12, 'A closed item', true)]
  const blocks = bodyOf(row({ items }), true) as any[]
  // A tickable box invites a click, and the next run would reset it.
  assert.equal(blocks.some((b) => b.type === 'to_do'), false)
})

test('EC11 an empty description becomes a sentence, not whitespace', () => {
  const texts = textsOf(bodyOf(row({ description: '   ' }), true))
  assert.ok(texts.some((t) => t === 'No description in GitLab.'), texts.join(' | '))
})

test('AK40 a 3000-character description is shortened to 2000 with a note', () => {
  const long = 'x'.repeat(3000)
  const blocks = bodyOf(row({ description: long }), true) as any[]
  const body = textOf(blocks[blocks.length - 1]!)

  assert.ok(body.length <= 2000, `expected at most 2000 characters, got ${body.length}`)
  assert.match(body, /Shortened — read the full text in GitLab\.$/)
  // Shortened and SAID so — not cut off and concealed.
  assert.ok(body.startsWith('xxx'))
})

test('a description within the limit is left alone', () => {
  const text = 'y'.repeat(1999)
  const blocks = bodyOf(row({ description: text }), true) as any[]
  assert.equal(textOf(blocks[blocks.length - 1]!), text)
})

test('a divider separates the facts from the description', () => {
  const blocks = bodyOf(row(), true) as any[]
  const divider = blocks.findIndex((b) => b.type === 'divider')
  assert.ok(divider > 0)
  assert.equal(textOf(blocks[divider + 1]!), 'What this is about.')
})

test('an item body carries no progress line — progress is a statement about a set', () => {
  const texts = textsOf(bodyOf(itemRow(42, 'An item', false), true))
  assert.equal(texts.some((t) => t.includes('Progress:')), false)
})

test('the item number renders as #42 even when the key is a URL', () => {
  // Reproduced before the fix: the body showed the whole URL after the #,
  // because the number was parsed back out of the key.
  const item = row({
    level: 'item',
    key: 'https://gitlab.example.invalid/acme/product/app/-/issues/42',
    number: 42,
    name: 'A ticket',
    closed: false,
    progress: null,
    url: 'https://gitlab.example.invalid/acme/product/app/-/issues/42',
    items: [],
  })

  const bullet = (bodyOf(row({ items: [item] }), true) as any[]).find((b) => b.type === 'bulleted_list_item')
  assert.match(textOf(bullet), /^○ #42 A ticket$/)
})
