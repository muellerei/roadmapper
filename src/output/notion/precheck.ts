import { quote } from '../../messages.js'
import type { CoreConfig, Health } from '../../core/types.js'
import type { TargetSchema } from './schema.js'

/** The target cannot take what this run would write. Raised BEFORE the first
 *  row, so nothing is half-written. */
export class TargetMismatch extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetMismatch'
  }
}

/** The two levels of section 6, and the health values — both fixed sets the
 *  target has to offer as select options. */
const LEVELS = ['Bundle', 'Item'] as const
const HEALTHS: readonly Health[] = ['ok', 'attention', 'risk']

/**
 * Does the target offer the values this run would write?
 *
 * Notion is loud, not silent: an unknown select value comes back as 400 with
 * the list of permitted values. But loud is not the same as harmless — the
 * 400 arrives MID-RUN, with part of the table already written. This check
 * moves that failure to the start.
 *
 * `sourceStates` carries the status names the source delivers, and is only
 * needed under `stageSource = 'status'`, where the values written are the
 * board's own display names. Under 'label' the values are already in the
 * configuration, so the check is cheaper and the source need not be read.
 */
export function precheckTarget(
  schema: TargetSchema,
  cfg: CoreConfig,
  columns: Readonly<Record<string, string>>,
  sourceStates: readonly string[] = [],
): void {
  const stateColumn = columns['state']
  if (stateColumn !== undefined && isSelect(schema, stateColumn)) {
    // Checked under BOTH settings. An earlier reading held that the question
    // does not arise under 'label', because a human writes target values
    // fitting their own board — but that is an assumption about the user,
    // not a check: someone entering "In progress" while the column carries
    // "In Progress" gets the 400 mid-run.
    const wanted =
      cfg.stageSource === 'status'
        ? [...new Set([...sourceStates, cfg.closed, cfg.default])]
        : [...new Set([...cfg.statusMap.values(), cfg.closed, cfg.default])]

    const hint =
      cfg.stageSource === 'status'
        ? `GitLab statuses found: ${sourceStates.join(', ') || '(none)'}.\nAdd them in Notion, or switch to stage_source = "label".`
        : `These are the values on the right of [status], plus closed and default.\nAdd them in Notion, or change [status].`

    demand(schema, stateColumn, wanted, hint)
  }

  const typeColumn = columns['type']
  if (typeColumn !== undefined && isSelect(schema, typeColumn)) {
    // A foreign table whose level column offers Epic/Issue would break on the
    // first write — and only then, although the schema has been known since
    // the schema read.
    demand(schema, typeColumn, LEVELS, `The two levels are written verbatim as "Bundle" and "Item".`)
  }

  const healthColumn = columns['health']
  if (healthColumn !== undefined && isSelect(schema, healthColumn)) {
    demand(schema, healthColumn, HEALTHS, `Add them in Notion, or drop health from [columns].`)
  }
}

/**
 * The key column of the existing rows must carry the form `keyIs` produces.
 * A value of the OTHER form means `key_is` was changed after the fact — and
 * writing on would add a second row beside every existing one instead of
 * updating it.
 *
 * `existingKeys` is a sample of what the key column holds; an empty target
 * has nothing to contradict, so nothing is checked.
 */
export function precheckKeyForm(existingKeys: readonly string[], cfg: CoreConfig): void {
  const looksLikeUrl = (key: string) => key.startsWith('https://') || key.startsWith('http://')
  const wrong = existingKeys.filter((key) => looksLikeUrl(key) !== (cfg.keyIs === 'url'))
  if (wrong.length === 0) return

  const shown = wrong.slice(0, 3).map((k) => `  ${k}`).join('\n')
  throw new TargetMismatch(
    `The key column already holds ${wrong.length} row(s) in the other key form, ` +
      `while key_is = "${cfg.keyIs}":\n${shown}\n` +
      `key_is was changed after these rows were written. Writing on would add a second\n` +
      `row beside every existing one.\n` +
      `Either set key_is back, or clear the key column once by hand.`,
  )
}

function isSelect(schema: TargetSchema, column: string): boolean {
  const type = schema.types.get(column)
  return type === 'select' || type === 'status'
}

/** Complain naming what is missing AND what the column offers — the report
 *  passes those on instead of saying "did not work". */
function demand(schema: TargetSchema, column: string, wanted: readonly string[], hint: string): void {
  const offered = schema.options.get(column) ?? []
  const missing = wanted.filter((value) => !offered.includes(value))
  if (missing.length === 0) return

  throw new TargetMismatch(
    `Column ${quote(column)} is a select and does not offer: ${missing.map(quote).join(', ')}.\n` +
      `It offers: ${offered.map(quote).join(', ') || '(no options)'}.\n${hint}`,
  )
}
