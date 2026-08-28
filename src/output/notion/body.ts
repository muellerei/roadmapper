import type { Row } from '../../core/types.js'

/** Notion's own limit, from its documented request limits: 2000 characters
 *  per rich text. A longer description is SHORTENED with a note, never cut
 *  off and concealed — the link to the original sits at the top anyway. */
const RICH_TEXT_LIMIT = 2000

/** The note that replaces what was dropped, and the room it needs. */
const SHORTENED = '\n\n[…] Shortened — read the full text in GitLab.'

/**
 * The page body of one row, as Notion blocks.
 *
 * Replaced on EVERY run, at every level, without a switch (ADR-0009). Page
 * content is always owned: what a human writes there does not survive. A
 * Notion comment does, and the tool never touches those.
 *
 * `hasActivityColumn` decides whether the last-activity line appears — it is
 * there for tables that do not carry the column, so the information is not
 * lost entirely.
 */
export function bodyOf(row: Row, hasActivityColumn: boolean): unknown[] {
  const blocks: unknown[] = []

  // The link sits at the top although `url` is a column too: whoever expands
  // the row does not see the column at that moment.
  blocks.push(paragraph([link('Open in GitLab', row.url)]))

  const facts: unknown[] = []
  // Bundles only, and only when the count could be obtained — a bundle with
  // no progress says nothing rather than "0 of 0".
  if (row.level === 'bundle' && row.progress !== null) {
    facts.push(bold('Progress: '), plain(`${row.progress.done} of ${row.progress.total} done`))
  }
  if (!hasActivityColumn) {
    if (facts.length > 0) facts.push(plain('\n'))
    facts.push(bold('Last activity: '), plain(day(row.activity)))
  }
  if (facts.length > 0) blocks.push(paragraph(facts))

  // Closed first, because the question on expanding is "what is done".
  // Characters, not Notion checkboxes: a tickable box invites a click, and
  // the next run would reset it.
  const items = [...row.items].sort((a, b) => Number(b.closed) - Number(a.closed))
  for (const item of items) {
    blocks.push(
      bullet([plain(`${item.closed ? '✓' : '○'} `), link(`#${item.number}`, item.url), plain(` ${item.name}`)]),
    )
  }

  blocks.push({ object: 'block', type: 'divider', divider: {} })

  // A sentence, not whitespace (EC11).
  const description = row.description.trim()
  blocks.push(
    paragraph([plain(description === '' ? 'No description in GitLab.' : shorten(description))]),
  )

  return blocks
}

/** Shorten to Notion's limit, keeping room for the note that says so. */
function shorten(text: string): string {
  if (text.length <= RICH_TEXT_LIMIT) return text
  return text.slice(0, RICH_TEXT_LIMIT - SHORTENED.length) + SHORTENED
}

/** A date as Notion takes it: the calendar day, no time and no zone. Shared
 *  with the property writer so the body and the column cannot disagree about
 *  the same date. */
export function day(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function paragraph(rich: unknown[]): unknown {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: rich } }
}

function bullet(rich: unknown[]): unknown {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich } }
}

function plain(content: string): unknown {
  return { type: 'text', text: { content } }
}

function bold(content: string): unknown {
  return { type: 'text', text: { content }, annotations: { bold: true } }
}

function link(content: string, url: string): unknown {
  return { type: 'text', text: { content, link: { url } } }
}
