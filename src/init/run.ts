import type { Client } from '@notionhq/client'
import type { ValidatedConfig } from '../config/validate.js'
import type { SourceResult } from '../core/types.js'
import { readSchema, TargetUnreadable } from '../output/notion/schema.js'
import { createColumns, planColumns, stateOptions } from '../output/notion/columns.js'
import type { SurveySource } from '../source/gitlab/survey.js'
import { compareSources } from './compare.js'
import {
  gitlabGroupForbidden,
  gitlabTokenRefused,
  groupMilestoneGap,
  noEpics,
  noMilestones,
  notionNotVisible,
  notionTokenRefused,
  quote,
} from '../messages.js'
import { configStep, tokenStep, InitFailed, type StepResult } from './steps.js'

export type InitDependencies = {
  env: Readonly<Record<string, string | undefined>>
  configPath: string
  /** Whether the file was named with --config — it is then never created. */
  configWasNamed: boolean
  examplePath: string
  /** Built only after step 2, so a missing token is never reported as a
   *  failed connection. */
  load: () => ValidatedConfig
  /** Reads the source the configuration names — ALREADY BOUND to its kind.
   *  `init` asks "does the source return bundles?" (R25, step 6) and must
   *  not answer "which source" a second time: main.ts decides that once, for
   *  the run and for init alike. Handing an `EpicSource` here asked a
   *  milestone configuration for the epics of a group it never set, and
   *  GitLab was sent `group: ""`. */
  readSource: (config: ValidatedConfig) => Promise<SourceResult>
  /** Optional: without it init skips the side-by-side comparison rather than
   *  failing — the comparison is advice, not a prerequisite. */
  surveyOf?: (config: ValidatedConfig) => SurveySource
  notionOf: () => Client
  out: (text: string) => void
}

/**
 * `roadmapper init` — a fixed order, aborting on the FIRST failure (R25,
 * R26).
 *
 * Abort rather than collect, because the steps build on one another: three
 * findings at once would mislead, since two of them are consequences of the
 * first. A wrong token makes every later check fail, and reporting all four
 * would bury the one that matters.
 *
 * The user story this serves: a new user is told WHICH of the three
 * prerequisites is missing — GitLab token, Notion integration, database
 * sharing — instead of a `not found` that could mean anything (US5).
 *
 * `init` installs nothing, changes no PATH and writes no cron entry (R28).
 * The one thing it writes is a config file, in step 1, and only when none
 * was named.
 */
export async function runInit(deps: InitDependencies): Promise<number> {
  const steps: StepResult[] = []

  try {
    // 1 — configuration
    const config = configStep(deps.configPath, deps.configWasNamed, deps.examplePath)
    steps.push(config)
    if (config.done === true) return finish(steps, deps.out)

    // 2 — credentials, before any network call
    steps.push(tokenStep(deps.env))

    // The config is only read now: an invalid file would otherwise be
    // reported before the missing token that explains why nobody got that
    // far before.
    const validated = deps.load()

    // 3 — does the GitLab token carry? The answer is kept: step 6 asks the
    // same question of the same data, and querying twice would be a second
    // round trip for nothing.
    const read = await gitlabStep(deps.readSource, validated)
    steps.push(read.result)

    // 4 — does the Notion token carry, is the database reachable?
    const schema = await notionStep(deps.notionOf(), validated)
    steps.push(schema.result)

    // 5 — schema: which columns are there, add what is missing, and does the
    // target carry `type`?
    steps.push(await schemaStep(deps.notionOf(), schema, validated))

    // 6 — does the source return bundles?
    steps.push(bundleStep(read.bundles, validated))

    // The known gap of section 17, named where somebody can act on it. It is
    // not a failure — the run works — but "No bundles found" would be
    // misleading for a group whose milestones exist one level up.
    if (validated.gitlab.bundle === 'milestone') {
      deps.out(`\n${groupMilestoneGap(validated.gitlab.projects)}\n`)
    }

    // Not a step of its own: advice, printed after the checks passed. It
    // decides nothing and writes nothing (R27a, R27b, ADR-0006).
    await advise(deps, validated)

    return finish(steps, deps.out)
  } catch (error) {
    if (error instanceof InitFailed) {
      for (const step of steps) deps.out(render(step))
      deps.out(`\nStep ${error.step} failed.\n\n${error.message}\n`)
      return 1
    }
    throw error
  }
}

/** A step, with continuation lines indented under it so a multi-line message
 *  reads as one block rather than falling out of the list. */
function render(step: StepResult): string {
  const [first, ...rest] = step.message.split('\n')
  return [`  ok  ${step.title}: ${first}`, ...rest.map((line) => `      ${line}`)].join('\n') + '\n'
}

/**
 * Both stage sources side by side, so choosing `stage_source` rests on
 * numbers (R27b) — and, when no label matches, the prefixes the group
 * actually carries (R27a).
 *
 * Best effort by design: an instance that cannot answer this is not a reason
 * to fail an otherwise healthy init. The advice is worth having, not worth
 * blocking on.
 */
async function advise(deps: InitDependencies, config: ValidatedConfig): Promise<void> {
  if (deps.surveyOf === undefined) return

  try {
    const survey = await deps.surveyOf(config).survey(config.gitlab.group ?? '')
    deps.out(`\n${compareSources(survey, config.core)}\n`)
  } catch {
    // Silent: the checks above already said the run is sound.
  }
}

function finish(steps: readonly StepResult[], out: (text: string) => void): number {
  for (const step of steps) out(render(step))
  const last = steps[steps.length - 1]
  if (last?.done !== true) out('\nEverything checks out. Run `roadmapper` to sync.\n')
  return 0
}

/** Step 3 — the GitLab token. A 401 here is a token problem, a 403 a rights
 *  problem, and the two need different answers. */
async function gitlabStep(
  read: (config: ValidatedConfig) => Promise<SourceResult>,
  config: ValidatedConfig,
): Promise<{ result: StepResult; bundles: number }> {
  let bundles = 0
  try {
    bundles = (await read(config)).bundles.length
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new InitFailed(
      3,
      /401/.test(message)
        ? gitlabTokenRefused(config.core.host)
        : /403/.test(message)
          ? gitlabGroupForbidden(config.gitlab.group ?? '')
          : message,
    )
  }

  return {
    result: { step: 3, title: 'GitLab', message: `${config.core.host} answers, the token carries.` },
    bundles,
  }
}

/** Step 4 — the Notion token and the database. The two failures look alike
 *  from outside, and only one of them is about the id (R27). */
async function notionStep(
  client: Client,
  config: ValidatedConfig,
): Promise<{ result: StepResult; dataSourceId: string; columns: ReadonlySet<string> }> {
  try {
    const schema = await readSchema(client, config.notion.database)
    return {
      result: {
        step: 4,
        title: 'Notion',
        message: `Database reachable, data source resolved.`,
      },
      dataSourceId: schema.dataSourceId,
      columns: new Set(schema.types.keys()),
    }
  } catch (cause) {
    if (cause instanceof TargetUnreadable) throw new InitFailed(4, cause.message)

    const message = cause instanceof Error ? cause.message : String(cause)
    // A database that is not shared answers exactly like a wrong id. Whoever
    // does not know that goes looking for the id instead of setting the
    // connection — so the message names both, and the click path.
    throw new InitFailed(
      4,
      /not.?found|404/i.test(message)
        ? notionNotVisible(config.notion.database, message)
        : /unauthorized|401/i.test(message)
          ? notionTokenRefused()
          : message,
    )
  }
}

/** Step 5 — what the target actually carries. `type` decides whether items
 *  are written at all, and that follows from the SCHEMA, never from a
 *  setting (EC5, ADR-0006). */
async function schemaStep(
  client: Client,
  schema: { dataSourceId: string; columns: ReadonlySet<string> },
  config: ValidatedConfig,
): Promise<StepResult> {
  const plan = planColumns(config.notion.columns, schema.columns)

  if (plan.unknown.length > 0) {
    throw new InitFailed(
      5,
      `[columns] names ${plan.unknown.map(quote).join(', ')}, which this tool does not know.\n` +
        `Known roles: key, name, state, progress, url, due, type, activity, health.`,
    )
  }

  // Only ADD. An existing column is never retyped or renamed — the target is
  // usually somebody else's table.
  // The state column gets the board's own values straight away — otherwise
  // the next run stops at its own pre-check over options the tool knows.
  const created = await createColumns(client, schema.dataSourceId, plan.missing, stateOptions(config.core))

  const levels = config.notion.columns['type']
  const writesItems = levels !== undefined && (schema.columns.has(levels) || created.includes(levels))

  const lines = [
    `${plan.present.length} of ${plan.present.length + plan.missing.length} configured columns existed.`,
    created.length === 0 ? '' : `  created: ${created.map(quote).join(', ')}`,
    writesItems
      ? `  ${quote(levels!)} is there — bundles AND items get rows.`
      : `  no type column — only bundles get rows (a table that cannot tell the levels\n` +
        `  apart carries one kind, and on roadmap altitude that is the bundle level).`,
  ]

  return { step: 5, title: 'Target schema', message: lines.filter((l) => l !== '').join('\n') }
}

/** Step 6 — does the source return anything? An empty answer is not an error
 *  but a gap, and it is the last thing worth knowing before the first run. */
function bundleStep(bundles: number, config: ValidatedConfig): StepResult {
  if (bundles === 0) {
    // The epic advice only where it applies — the SAME rule the run path
    // follows (outcome.ts). It names subgroups and GitLab Premium, and a
    // milestone configuration has neither; sending its user after them was
    // the second half of asking the wrong source in the first place.
    throw new InitFailed(
      6,
      config.gitlab.bundle === 'epic'
        ? noEpics(config.gitlab.group ?? '', config.gitlab.subgroups)
        : noMilestones(config.gitlab.projects),
    )
  }

  return { step: 6, title: 'Source', message: `${bundles} bundle(s) found.` }
}

