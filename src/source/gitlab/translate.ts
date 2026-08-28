import { lastActivityOf } from '../../core/activity.js'
import { bundleKeyOf, itemKeyOf } from '../../core/key.js'
import { prefixOf } from '../../core/label.js'
import { healthOf } from '../../core/health.js'
import { progressOf } from '../../core/progress.js'
import type { Bundle, CoreConfig, Health, HealthCount, Item, Stage, StatusCategory } from '../../core/types.js'
import { statusFieldMissing } from '../../messages.js'

/**
 * The translation at the edge (ADR-0003). Neither table is configurable:
 * this is not a user decision, it is what GitLab's words mean in ours.
 *
 * TWO MEASURED TRAPS live here, and both compile cleanly while never firing:
 *
 * 1. CASE. GitLab's schema reports this enum in CAPITALS (TRIAGE, TO_DO,
 *    IN_PROGRESS, DONE, CANCELED) but the WIRE carries it lowercase —
 *    "triage", "in_progress" (measured 2026-08-24 against gitlab-org/gitlab).
 *    A switch written from the schema hits no branch: every item would fall
 *    silently to the default value, and the report would read
 *    "state 30/30 filled — 30x Backlog", which looks like an unmaintained
 *    field rather than a type error.
 * 2. SPELLING. GitLab writes "canceled" with one L; the core value is
 *    'cancelled' with two. Same class of trap, one letter deep.
 */
const CATEGORIES: ReadonlyMap<string, StatusCategory> = new Map([
  ['triage', 'triage'],
  ['to_do', 'todo'],
  ['in_progress', 'active'],
  ['done', 'done'],
  ['canceled', 'cancelled'], // one L in, two L out
])

/**
 * Which work item types are BUNDLES. A positive list, and the direction is
 * the whole point (R3d).
 *
 * A NEGATIVE test (`!== 'Issue'`) reads as the safer one and is not: GitLab
 * allows `Epic`, `Issue` and `Ticket` as direct children of an epic, so a
 * ticket would take the bundle branch, be keyed by `bundleKeyOf` as
 * `path&number` — and collide with a real epic of that number, one row
 * overwriting the other (section 5). Falling to ITEM costs a mislabelled
 * row; falling to BUNDLE costs data.
 */
const BUNDLE_TYPES: ReadonlySet<string> = new Set(['Epic'])

/** The types known to be items. Listed although the code only needs
 *  BUNDLE_TYPES: it is what makes an UNKNOWN type distinguishable from a
 *  known one, so a type GitLab adds later is reported rather than passed off
 *  as an item in silence (R3b, R3d). */
const ITEM_TYPES: ReadonlySet<string> = new Set(['Issue', 'Ticket'])

/** Without this table `needsAttention` would be the ONE raw API identifier
 *  landing in a target column, while every other value passes a mapping. */
const HEALTHS: ReadonlyMap<string, Health> = new Map([
  ['onTrack', 'ok'],
  ['needsAttention', 'attention'],
  ['atRisk', 'risk'],
])

/** A value GitLab sent that no table knows. Reported rather than passed
 *  through: when GitLab extends an enum it must surface, not disguise itself
 *  as an unmaintained field. */
export class UnknownGitLabValue extends Error {
  readonly field: string
  readonly value: string

  constructor(field: string, value: string, known: readonly string[]) {
    super(
      `GitLab sent an unknown ${field}: "${value}".\n` +
        `Known values: ${known.map((k) => `"${k}"`).join(', ')}.\n` +
        `This is most likely a GitLab version that extended the enum — the field is left empty.`,
    )
    this.name = 'UnknownGitLabValue'
    this.field = field
    this.value = value
  }
}

/** The instance does not carry the status field although the configuration
 *  chose it. Not switched to labels silently: that would be a guess about a
 *  configuration a human wrote deliberately (EC7b). */
export class StatusFieldMissing extends Error {
  constructor() {
    super(statusFieldMissing())
    this.name = 'StatusFieldMissing'
  }
}

/** An item URL that carries no project path. The key is built from it, and
 *  without a path every item of that number would share one Notion row. */
export class UnusableItemUrl extends Error {
  constructor(url: string) {
    super(
      `GitLab gave an item a URL no project path can be read from: ${JSON.stringify(url)}.\n` +
        `The key is built from that path, so the item cannot be identified across runs.`,
    )
    this.name = 'UnusableItemUrl'
  }
}

/** What could not be translated, collected for the closing report. */
export type Complaint = { message: string }

export function categoryOf(wire: string, complaints: Complaint[]): StatusCategory | null {
  const known = CATEGORIES.get(wire)
  if (known !== undefined) return known
  complaints.push({ message: new UnknownGitLabValue('status category', wire, [...CATEGORIES.keys()]).message })
  return null
}

export function healthValueOf(wire: string, complaints: Complaint[]): Health | null {
  const known = HEALTHS.get(wire)
  if (known !== undefined) return known
  complaints.push({ message: new UnknownGitLabValue('health status', wire, [...HEALTHS.keys()]).message })
  return null
}

/** The rolled-up (health, count) pairs, translated. */
export function healthCountsOf(
  rolled: readonly { healthStatus: string; count: number }[],
  complaints: Complaint[],
): HealthCount[] {
  const out: HealthCount[] = []
  for (const entry of rolled) {
    const health = healthValueOf(entry.healthStatus, complaints)
    if (health !== null) out.push({ health, count: entry.count })
  }
  return out
}

/** The Issue entry of the rollup — the pair progress is counted from (R3).
 *  null when GitLab supplied none, so the caller reports the gap rather than
 *  writing 0/0 (ADR-0015). */
export function issueCountsOf(
  rolled: readonly { workItemType: { name: string }; countsByState: { all: number; closed: number } }[] | null,
): { all: number; closed: number } | null {
  const issues = rolled?.find((entry) => entry.workItemType.name === 'Issue')
  return issues === undefined ? null : issues.countsByState
}

/** The scoped-label prefixes of one level: the part before the LAST `::`.
 *  GitLab knows multi-level scopes like `AST::Ruleset::FN`, and the scope it
 *  holds exclusively there is `AST::Ruleset`, not `AST` (R7a, measured in
 *  gitlab-org). Collected WITHOUT the trailing separator — appending it is
 *  the report's rendering decision, the same split as everywhere else. */
function collectPrefixes(labels: readonly string[], prefixes: Set<string>): void {
  for (const label of labels) {
    const prefix = prefixOf(label)
    // A flat label contributes no prefix — there is nothing to name.
    if (prefix !== '') prefixes.add(prefix)
  }
}

function labelsOf(widgets: readonly WireWidget[]): string[] {
  return widgets.flatMap((w) => w.labels?.nodes ?? []).map((l) => l.title)
}

/**
 * The stage of one work item, from labels and status that the CALLER has
 * already extracted.
 *
 * Takes the two values rather than a wire node, because the two queries put
 * them in different places: an epic's labels arrive on a widget, a
 * milestone's issue carries them flat (`labels.nodes`). The EXTRACTION is
 * therefore each caller's, while the RULE below — which label wins, when the
 * status field is missing, how a category travels — is the same for both and
 * lives here once. Two copies of it drifted apart in the predecessor, which
 * is the same defect `src/core/label.ts` records for `prefixOf`.
 */
export function stageFrom(
  labels: readonly string[],
  status: { name: string; category: string } | undefined,
  cfg: CoreConfig,
  prefixes: Set<string>,
  complaints: Complaint[],
): Stage {
  // Prefixes first: the report names what the source HOLDS, and a run that
  // stops on a missing status field has still seen these labels.
  collectPrefixes(labels, prefixes)
  if (cfg.stageSource === 'status' && status === undefined) throw new StatusFieldMissing()

  return {
    category: status === undefined ? null : categoryOf(status.category, complaints),
    // The DISPLAY NAME travels as text; the meaning is carried by the
    // category alone (R6a).
    categoryName: status?.name ?? null,
    // GitLab returns a scoped label as ONE string, and it is passed on WHOLE:
    // the [status] table is keyed by the full label (R7). The first scoped
    // label wins; a board keeping two prefixes is rejected by config
    // validation (R7b), so there is nothing to choose between here.
    label: labels.find((label) => label.includes('::')) ?? labels[0] ?? null,
  }
}

/** The stage of an epic or of a child work item, whose labels and status both
 *  sit on widgets. */
function stageOf(
  widgets: readonly WireWidget[],
  cfg: CoreConfig,
  prefixes: Set<string>,
  complaints: Complaint[],
): Stage {
  const status = widgets.find((w) => w.status !== undefined)?.status
  return stageFrom(labelsOf(widgets), status, cfg, prefixes, complaints)
}

/** The shapes GitLab actually sends. They stay in this file: no response
 *  object leaves the source (R8). */
type WireWidget = {
  dueDate?: string | null
  hasChildren?: boolean
  /** Both rollups arrive on their widgets, not on the node (measured). */
  rolledUpCountsByType?: { workItemType: { name: string }; countsByState: { all: number; closed: number } }[] | null
  rolledUpHealthStatus?: { healthStatus: string; count: number }[] | null
  labels?: { nodes: { title: string }[] }
  status?: { name: string; category: string }
  children?: { nodes: WireNode[] }
}

type WireNode = {
  iid: string
  /** Not optional: the query selects it on every level, so a missing value
   *  would be a broken query rather than a case in the data (R3d). */
  workItemType: { name: string }
  /** The bundle's own namespace. Absent on issues, which are keyed by their
   *  project path instead. */
  namespace?: { fullPath: string } | null
  title: string
  description: string | null
  state: string
  webUrl: string
  updatedAt: string
  rolledUpCountsByType?: { workItemType: { name: string }; countsByState: { all: number; closed: number } }[] | null
  rolledUpHealthStatus?: { healthStatus: string; count: number }[] | null
  widgets?: WireWidget[]
}

export type Translation = {
  bundles: Bundle[]
  prefixes: string[]
  truncated: string[]
  complaints: Complaint[]
}

/**
 * Turn a page of work items into bundles.
 *
 * The bundles leave here COMPLETE: key, progress, lastActivity and health
 * are already filled (section 4b). That is why this file imports from
 * `src/core/` — the direction of the boundary, not a breach of it: the core
 * does not know the source, the source may use the core.
 */
export function translateEpics(nodes: readonly unknown[], groupPath: string, cfg: CoreConfig): Translation {
  const prefixes = new Set<string>()
  const truncated: string[] = []
  const complaints: Complaint[] = []

  const bundles = (nodes as WireNode[]).map((node) => bundleFrom(node, groupPath, cfg, prefixes, truncated, complaints))

  return { bundles, prefixes: [...prefixes], truncated, complaints }
}

/** The query goes bundle -> child bundle -> items, so bundles come back on
 *  levels 0 and 1 and level 1 is where the answer stops (R3c). */
const LAST_QUERIED_LEVEL = 1

function bundleFrom(
  node: WireNode,
  path: string,
  cfg: CoreConfig,
  prefixes: Set<string>,
  truncated: string[],
  complaints: Complaint[],
  depth = 0,
): Bundle {
  const widgets = node.widgets ?? []
  const number = Number(node.iid)
  // The bundle's OWN path, falling back to the configured group only when
  // GitLab did not supply one. Epic numbers restart per namespace, so using
  // the configured group for a subgroup epic would collide (section 5).
  const own = node.namespace?.fullPath ?? path
  const key = bundleKeyOf({ path: own, number, kind: 'epic', sourcePath: null }, cfg)

  // Classified ONCE per child, not once per list: isBundle reports an
  // unknown type, and asking twice would report it twice.
  const sorted = { bundles: [] as WireNode[], items: [] as WireNode[] }
  for (const child of childNodes(widgets)) {
    if (isBundle(child, complaints)) sorted.bundles.push(child)
    else sorted.items.push(child)
  }

  const children = sorted.bundles.map((child) =>
    bundleFrom(child, path, cfg, prefixes, truncated, complaints, depth + 1),
  )

  // One unusable item does not cost the bundle its other rows — a broken
  // single item must not stop the run (section 12). It is dropped and named,
  // never given a made-up key.
  const items: Item[] = []
  for (const child of sorted.items) {
    try {
      items.push(itemFrom(child, key, cfg, prefixes, complaints))
    } catch (error) {
      if (!(error instanceof UnusableItemUrl)) throw error
      complain(complaints, error.message)
    }
  }

  // Truncation is read off hasChildren on the LAST QUERIED LEVEL, that field
  // ALONE (R3c). Which level is last is a property of the QUERY, not of the
  // answer — this query fetches bundle -> child bundle -> items, so the child
  // level is where it stops, and `depth` says where we are.
  //
  // No extra condition, and least of all one on the children list: where the
  // list was queried it is never empty when hasChildren is true, and where it
  // was not queried it is absent rather than empty. Measured across 145 child
  // nodes: the conjunction fired ZERO times while hasChildren alone fired
  // nine — testing the list as well would have disabled this signal in
  // silence, which is the very thing the rule exists against.
  //
  // Only the STATE stops here. Progress and health roll up without limit, so
  // the report says exactly that rather than casting doubt on the numbers.
  if (depth === LAST_QUERIED_LEVEL && widgets.some((w) => w.hasChildren === true)) {
    truncated.push(key)
  }

  // A bundle's own labels count towards the prefixes too — the report needs
  // to name what EXISTS, and epics carry scoped labels just as issues do.
  collectPrefixes(labelsOf(widgets), prefixes)

  const counts = issueCountsOf(widgets.find((w) => w.rolledUpCountsByType != null)?.rolledUpCountsByType ?? null)
  const bundle: Bundle = {
    key,
    number,
    name: node.title,
    description: node.description ?? '',
    closed: node.state === 'CLOSED',
    due: dateOf(widgets.find((w) => w.dueDate !== undefined)?.dueDate ?? null),
    url: node.webUrl,
    // null when the count could not be obtained — never 0/0 (ADR-0015).
    progress: counts === null ? null : progressOf(counts.all, counts.closed),
    lastActivity: new Date(node.updatedAt),
    health: healthOf(
      null,
      healthCountsOf(widgets.find((w) => w.rolledUpHealthStatus != null)?.rolledUpHealthStatus ?? [], complaints),
    ),
    items,
    children,
  }

  // lastActivity must include the tree below it, or an epic whose work only
  // happens in its children looks still (AK11). The rule lives in core and is
  // called here rather than rebuilt (R12).
  bundle.lastActivity = lastActivityOf(bundle)

  return bundle
}

/** The child nodes hanging off the hierarchy widget, wherever GitLab put
 *  them in the widget list. */
function childNodes(widgets: readonly WireWidget[]): WireNode[] {
  return widgets.flatMap((w) => w.children?.nodes ?? [])
}

/**
 * Is this child a bundle, or an item? Decided on the type GitLab states
 * (R3d) — this file is the translation at the edge, so it reads GitLab's own
 * word instead of guessing at one.
 *
 * THE MEASURED TRAP, and it cost a whole run: the first build asked whether
 * the node CARRIES `rolledUpCountsByType`, on the theory that only an epic
 * does. The query selects `...bundleWidgets` on the child level too, GraphQL
 * returns every field it was asked for, and GitLab answers an ISSUE with a
 * FILLED array (`[{workItemType:{name:'Issue'},countsByState:{all:0,…}}]`,
 * measured 2026-08-25 against gitlab.com). The predicate was therefore true
 * for every child: every issue became a bundle, no item row was ever written,
 * and nothing failed — the run reported success over a board holding tickets
 * that claimed to be epics. Testing the VALUE instead of the presence does
 * not help; the array is not empty.
 *
 * An unknown type is reported, not swallowed (R3b): it becomes an item —
 * the safe side, see BUNDLE_TYPES — and says so in the closing report.
 */
function isBundle(node: WireNode, complaints: Complaint[]): boolean {
  const type = node.workItemType.name
  if (BUNDLE_TYPES.has(type)) return true
  if (!ITEM_TYPES.has(type)) complain(complaints, new UnknownGitLabValue('work item type', type, [...BUNDLE_TYPES, ...ITEM_TYPES]).message)
  return false
}

/** Add a complaint unless the same sentence is already there.
 *
 *  An unknown TYPE arrives once per child, and a group can answer with
 *  thousands: measured 1000 identical sentences, 179 KB, out of a single
 *  epic. The report is the tool's most important output precisely because it
 *  does not arrive every night (section 12) — a wall of repetition trains the
 *  reader to skip it, which is the one thing that design cannot afford. The
 *  unknown type is worth saying; saying it a thousand times is not. */
export function complain(complaints: Complaint[], message: string): void {
  if (!complaints.some((c) => c.message === message)) complaints.push({ message })
}

function itemFrom(
  node: WireNode,
  bundleKey: string,
  cfg: CoreConfig,
  prefixes: Set<string>,
  complaints: Complaint[],
): Item {
  const widgets = node.widgets ?? []
  // The project path comes out of the item's own URL: the number counts per
  // project, so the path has to be the item's, not the group's.
  const projectPath = projectPathOf(node.webUrl)
  const number = Number(node.iid)

  return {
    key: itemKeyOf(projectPath, number, cfg),
    number,
    title: node.title,
    // Empty string when there is none, never null (EC11).
    description: node.description ?? '',
    closed: node.state === 'CLOSED',
    stage: stageOf(widgets, cfg, prefixes, complaints),
    url: node.webUrl,
    bundle: bundleKey,
    updatedAt: new Date(node.updatedAt),
    health: null,
  }
}

/** `https://host/acme/product/app/-/issues/42` -> `acme/product/app`.
 *
 *  The path is HALF THE KEY, and an empty one is the expensive failure: every
 *  item of that number would collapse onto `#42` across all projects, one row
 *  overwriting the next, and the run would report success (section 5). GitLab
 *  has always answered `/<path>/-/<kind>/<number>` here, so this should not
 *  happen — which is exactly why it is checked rather than assumed. Reported
 *  as an unusable answer, not repaired: there is nothing to fall back to that
 *  would not invent a key.
 *
 *  Exported because BOTH sources need it, and for the same reason: a
 *  milestone's issue list can hold issues from sibling projects (a project
 *  query reaches through to a group milestone of the same name — see
 *  `groupMilestoneGap`), so keying them by the CONFIGURED project would
 *  collapse two different tickets onto one row there as well. One rule, one
 *  implementation — two copies of it are what `prefixOf` in
 *  `src/core/label.ts` records as a real defect. */
export function projectPathOf(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    throw new UnusableItemUrl(url)
  }
  const cut = path.indexOf('/-/')
  const project = (cut === -1 ? path : path.slice(0, cut)).replace(/^\/+/, '')
  if (project === '') throw new UnusableItemUrl(url)
  return project
}

function dateOf(value: string | null): Date | null {
  return value === null ? null : new Date(value)
}
