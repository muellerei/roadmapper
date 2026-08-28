import { quote } from '../messages.js'
import { prefixesOf } from '../core/label.js'
import type { CoreConfig } from '../core/types.js'

/**
 * The configuration is wrong, and the run stops before writing anything.
 *
 * Every message names the offending value AND the ones available to choose
 * from. That is the difference between a check that helps and one that only
 * says no: the values are the user's own, quoted verbatim in whatever
 * language their board speaks.
 */
export class ConfigInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigInvalid'
  }
}

/** Everything the run needs, split by who reads it. `core` goes to
 *  `src/core/`; the rest never does. */
export type ValidatedConfig = {
  core: CoreConfig
  gitlab: {
    bundle: 'epic' | 'milestone'
    group: string | null
    projects: readonly string[]
    subgroups: boolean
    includeClosed: boolean
    excludeTitles: readonly string[]
  }
  notion: {
    database: string
    columns: Readonly<Record<string, string>>
  }
}

/** Reserved keys in `[status]`: everything else there is a label mapping. */
const RESERVED = new Set(['default', 'closed', 'active', 'blocked'])

/**
 * Check the parsed config against section 10, before the first write.
 *
 * The single most valuable check in the tool is the one on `active` and
 * `blocked`: a typo like "In Progress" instead of "In progress" is
 * syntactically perfect TOML, and without this check every bundle would fall
 * silently to `default` while the run reported success. A quietly meaningless
 * board is worse than a run that refuses to start.
 */
export function validateConfig(raw: unknown): ValidatedConfig {
  const root = asTable(raw, 'the config file')
  const gitlab = asTable(root['gitlab'], '[gitlab]')
  const notion = asTable(root['notion'], '[notion]')
  const status = asTable(root['status'] ?? {}, '[status]')
  const columns = asTable(root['columns'] ?? {}, '[columns]')

  // --- [gitlab] ---------------------------------------------------------

  const bundle = oneOf(gitlab['bundle'], ['epic', 'milestone'], 'gitlab.bundle')

  // The field belonging to the chosen kind must be there and non-empty.
  let group: string | null = null
  let projects: string[] = []
  if (bundle === 'epic') {
    group = nonEmptyString(gitlab['group'], 'gitlab.group', 'it names the group the epics live in')
  } else {
    projects = stringArray(gitlab['projects'], 'gitlab.projects')
    if (projects.length === 0) {
      throw new ConfigInvalid('gitlab.projects is empty, but bundle = "milestone" reads milestones from projects.')
    }
  }

  // The endpoint of the query is built from the host (R2b), not only the
  // display URL — so this holds ALWAYS, not just with key_is = "url".
  const host = nonEmptyString(gitlab['host'], 'gitlab.host', 'the query endpoint is built from it')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host) || host.includes('/')) {
    throw new ConfigInvalid(
      `gitlab.host must be a bare hostname, not "${host}".\n` +
        `Write it without a scheme, a path or a trailing slash, e.g. "gitlab.com".`,
    )
  }

  const stageSource = oneOf(gitlab['stage_source'] ?? 'label', ['label', 'status'], 'gitlab.stage_source')

  // --- [notion] ---------------------------------------------------------

  const database = nonEmptyString(notion['database'], 'notion.database', 'it names the database to write to')
  // A third value is rejected, never reset to the default: the key decides
  // create-or-update, and a silent default would produce a duplicate beside
  // every existing row.
  const keyIs = oneOf(notion['key_is'] ?? 'id', ['id', 'url'], 'notion.key_is')

  // --- [columns] --------------------------------------------------------

  const columnMap: Record<string, string> = {}
  for (const [key, value] of Object.entries(columns)) {
    columnMap[key] = nonEmptyString(value, `columns.${key}`, 'a column name cannot be empty')
  }
  for (const required of ['key', 'name']) {
    if (columnMap[required] === undefined) {
      throw new ConfigInvalid(`columns.${required} is missing. Both columns.key and columns.name are mandatory.`)
    }
  }

  // Each role needs a column of its own. Two roles on one name is perfectly
  // valid TOML and destroys a row silently: the writer builds one flat record
  // per row, so the later assignment wins and the earlier value never reaches
  // the target. Where the KEY is the one overwritten, the next run cannot find
  // its own rows and creates them again — one more copy of every row, every
  // night, with nothing reporting it. Nothing is ever deleted (R21), so the
  // table only ever grows.
  //
  // Checked here rather than against the target: it is a property of the file
  // alone, and R29 puts those before the first request.
  const byName = new Map<string, string[]>()
  for (const [role, name] of Object.entries(columnMap)) {
    const seen = byName.get(name)
    if (seen === undefined) byName.set(name, [role])
    else seen.push(role)
  }
  const shared = [...byName.entries()].filter(([, roles]) => roles.length > 1)
  if (shared.length > 0) {
    const named = shared
      .map(([name, roles]) => `  ${roles.map((r) => `columns.${r}`).join(' and ')} both name ${quote(name)}`)
      .join('\n')
    throw new ConfigInvalid(
      `Two roles share one column:\n${named}\n` +
        `Every role needs a column of its own — one column can hold one value, so the\n` +
        `other role's value is lost. Give each role its own column name.`,
    )
  }

  // --- [status] ---------------------------------------------------------

  const statusMap = new Map<string, string>()
  for (const [label, target] of Object.entries(status)) {
    if (RESERVED.has(label)) continue
    statusMap.set(label, nonEmptyString(target, `status."${label}"`, 'it is the value written to the board'))
  }

  // At most ONE prefix across the keys (R7b). An item can carry
  // Flow::Doing AND Rank::1, and the label list has no guaranteed order —
  // the cell would flicker between runs. A flat label without :: counts as
  // one prefix of its own.
  // Flat labels all map to the empty prefix, so a table of them counts as
  // ONE prefix — which is what R7b says.
  const prefixes = prefixesOf(statusMap.keys())
  if (prefixes.length > 1) {
    throw new ConfigInvalid(
      `The keys in [status] carry more than one prefix: ${prefixes.map((p) => quote(p === '' ? '(no prefix)' : p)).join(', ')}.\n` +
        `An item can carry one label from each prefix, and their order is not guaranteed — ` +
        `the state would flicker between runs. Keep one prefix.`,
    )
  }

  const fallback = nonEmptyString(status['default'] ?? 'Backlog', 'status.default', 'it is the fallback state')
  // When `closed` is missing, `default` applies — and then the two carry the
  // same value, so a bundle's verdict cannot tell "done" from "nothing
  // known". A child bundle with no children of its own falls to `default`,
  // would count as done, and its parent would report `closed`: a project
  // without a single work item reading as finished.
  const closed = nonEmptyString(status['closed'] ?? fallback, 'status.closed', 'it is the state of a closed bundle')
  if (closed === fallback) {
    throw new ConfigInvalid(
      `status.closed and status.default are both ${quote(closed)}.\n` +
        `They must differ, or a bundle with no work items at all would read as finished.\n` +
        `Either set status.closed, or change status.default.`,
    )
  }

  const active = stringArray(status['active'] ?? [], 'status.active')
  const blocked = stringArray(status['blocked'] ?? [], 'status.blocked')

  // What these are checked against depends on the stage source. Under
  // "status" the values are the board's status NAMES, which only the source
  // can supply, so that half runs in validateBlockedAgainstSource() below —
  // after the first read, still before the first write. `active` is not read
  // under that setting and is therefore not checked at all.
  if (stageSource === 'label') {
    const known = [...new Set(statusMap.values())]
    for (const [name, values] of [
      ['active', active],
      ['blocked', blocked],
    ] as const) {
      for (const value of values) {
        if (!known.includes(value)) {
          throw new ConfigInvalid(
            `status.${name} names ${quote(value)}, which is not a value in [status].\n` +
              `Available: ${known.map(quote).join(', ') || '(none)'}.`,
          )
        }
      }
    }
  }

  const overlap = active.filter((v) => blocked.includes(v))
  if (overlap.length > 0) {
    throw new ConfigInvalid(
      `status.active and status.blocked both name ${overlap.map(quote).join(', ')}.\n` +
        `A state means one or the other, never both.`,
    )
  }

  return {
    core: { host, keyIs, stageSource, statusMap, active, blocked, closed, default: fallback },
    gitlab: {
      bundle,
      group,
      projects,
      subgroups: asBoolean(gitlab['subgroups'] ?? false, 'gitlab.subgroups'),
      includeClosed: asBoolean(gitlab['include_closed'] ?? false, 'gitlab.include_closed'),
      excludeTitles: stringArray(gitlab['exclude_titles'] ?? [], 'gitlab.exclude_titles'),
    },
    notion: { database, columns: columnMap },
  }
}

function asTable(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigInvalid(`${what} is missing or is not a table.`)
  }
  return value as Record<string, unknown>
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigInvalid(`${what} must be true or false.`)
  return value
}

function nonEmptyString(value: unknown, what: string, why: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigInvalid(`${what} is missing or empty — ${why}.`)
  }
  return value
}

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigInvalid(`${what} must be a list of strings.`)
  }
  return value as string[]
}

/** A third value is REJECTED, never reset to the default — otherwise the
 *  result would quietly rest on a different source than intended. */
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, what: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ConfigInvalid(
      `${what} is ${typeof value === 'string' ? quote(value) : 'missing'}. ` +
        `Allowed: ${allowed.map(quote).join(' or ')}.`,
    )
  }
  return value
}

/**
 * The one R29 check that cannot happen while reading the file.
 *
 * Under `stage_source = "status"` the values in `blocked` are the board's
 * own status NAMES, and only the source knows those — so this runs after the
 * first read, still before the first write, exactly like the select
 * pre-check it shares its input with.
 *
 * It matters most precisely here: with `"status"` the `blocked` list is the
 * ONLY source for "blocked at all", because GitLab's categories have none
 * (measured — the status literally named "Blocked" has category
 * in_progress). A typo would therefore not merely mislabel a bundle; no
 * bundle would ever read as blocked, and nothing would say so.
 *
 * `active` is not checked: it is not read under this setting (section 10).
 */
export function validateBlockedAgainstSource(cfg: CoreConfig, delivered: readonly string[]): void {
  if (cfg.stageSource !== 'status' || cfg.blocked.length === 0) return

  const unknown = cfg.blocked.filter((value) => !delivered.includes(value))
  if (unknown.length === 0) return

  throw new ConfigInvalid(
    `status.blocked names ${unknown.map(quote).join(', ')}, which no item in the source carries.\n` +
      `With stage_source = "status" these are the status NAMES your board uses.\n` +
      `Found in the source: ${delivered.map(quote).join(', ') || '(none)'}.`,
  )
}
