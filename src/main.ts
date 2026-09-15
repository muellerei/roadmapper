#!/usr/bin/env node
import { Client } from '@notionhq/client'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Http } from './source/gitlab/client.js'
import { parseArgs, USAGE, UsageError } from './cli.js'
import { configPathOf, readConfig, ConfigFileMissing } from './config/read.js'
import {
  validateBlockedAgainstSource,
  validateConfig,
  ConfigInvalid,
  type ValidatedConfig,
} from './config/validate.js'
import { rowsOf } from './core/rows.js'
import type { SourceResult } from './core/types.js'
import { createEpicSource } from './source/gitlab/epics.js'
import { createSurveySource } from './source/gitlab/survey.js'
import { createMilestoneSource } from './source/gitlab/milestones.js'
import { createNotionTarget } from './output/notion/target.js'
import { emptyOutcome, outcomeOf, type Outcome } from './report/outcome.js'
import { fillOf, renderFill } from './report/fill.js'
import { runInit } from './init/run.js'

/**
 * The wiring, at exactly one place and readable top to bottom (R22,
 * ADR-0010). No DI container, no module-level mutable state, no singleton
 * reading `process.env` deep in a call.
 *
 * Nothing here derives anything. When something needs writing in this file
 * that is not wiring, it belongs in a stage module instead — the report, the
 * error behaviour and the checks each have their own place.
 */
export type Environment = {
  env: Readonly<Record<string, string | undefined>>
  /** The working directory a relative --config resolves against (R24). A
   *  parameter rather than a process.cwd() read inside, so a test can prove
   *  the resolution honestly. */
  cwd: string
  out: (text: string) => void
  err: (text: string) => void
  /** The two doors to the outside, injectable so a test can drive a whole
   *  run without a network (ADR-0010). Both default to the real thing. */
  http?: Http
  notion?: Client
  /** What the retrier waits with. A test advances its own clock instead of
   *  spending real seconds. */
  sleep?: (ms: number) => Promise<void>
}

export async function main(argv: readonly string[], environment: Environment): Promise<number> {
  const { env, cwd } = environment
  const invocation = parseArgs(argv)

  if (invocation.command === 'help') {
    environment.out(`${USAGE}\n`)
    return 0
  }

  const path = configPathOf(invocation.config, cwd)

  if (invocation.command === 'init') {
    // init reads the config ITSELF, step by step: it must be able to create
    // one when there is none, and to report a missing token before a broken
    // config file (R25).
    return runInit({
      env,
      configPath: path,
      configWasNamed: invocation.config !== undefined,
      // The example ships WITH the package (see "files" in package.json), so
      // it is resolved against this module rather than against the working
      // directory — the config path is the one thing that follows the user's
      // cwd (R24), the template is not.
      examplePath: examplePath(),
      load: () => validateConfig(readConfig(path)),
      // The SAME branch the run takes (readSource below), so init cannot
      // check a different source than the one that will do the work.
      readSource: (config) => readSource(config, required(env, 'GITLAB_TOKEN'), environment.http),
      surveyOf: (config) => createSurveySource(config.core.host, required(env, 'GITLAB_TOKEN'), environment.http),
      notionOf: () => environment.notion ?? new Client({ auth: required(env, 'NOTION_TOKEN') }),
      out: environment.out,
    })
  }

  const config = validateConfig(readConfig(path))

  // Credentials come from the environment and nowhere else: no file beside
  // the command is searched for, at any depth. Cron has no working directory
  // worth trusting, and a credentials file found by looking around is a
  // lookup nobody can see.
  const gitlabToken = required(env, 'GITLAB_TOKEN')
  const notionToken = required(env, 'NOTION_TOKEN')

  return run(config, gitlabToken, notionToken, environment)
}

async function run(
  config: ValidatedConfig,
  gitlabToken: string,
  notionToken: string,
  environment: Environment,
): Promise<number> {
  const { out, err } = environment
  const target = createNotionTarget(
    environment.notion ?? new Client({ auth: notionToken }),
    config.notion.columns,
    environment.sleep,
  )

  const result = await readSource(config, gitlabToken, environment.http)

  if (result.bundles.length === 0) {
    // A run without bundles writes nothing and names the gap rather than
    // reporting success over an empty table (AK20).
    return report(
      emptyOutcome(result.prefixes, result.complaints, {
        bundle: config.gitlab.bundle,
        group: config.gitlab.group ?? '',
        subgroups: config.gitlab.subgroups,
      }),
      out,
      err,
    )
  }

  const rows = rowsOf(result, config.core, { includeClosed: config.gitlab.includeClosed })
  // The status names the source actually delivered — the select pre-check
  // needs them under stage_source = "status".
  const states = [...new Set(rows.filter((r) => r.level === 'item').map((r) => r.state))]

  // The half of R29 that needs the source: under stage_source = "status" the
  // blocked values are the board's own status names. Still before the first
  // write.
  validateBlockedAgainstSource(config.core, states)

  const written = await target.write(config.notion.database, rows, config.core, states)

  // The fill rate is the most important message of the tool (section 12):
  // every decision above is right on its own, and their sum can still be an
  // empty board without a single error path firing.
  const carried = new Set(written.schema.types.keys())
  // `carried` is every column the target HAS; `unusable` is the ones EC6 left
  // out for their type. Both are needed, because only their difference tells
  // "written" from "exists" — see fillOf.
  out(renderFill(fillOf(rows, config.core, config.notion.columns, carried, result.prefixes, written.unusable)))

  return report(
    outcomeOf(rows, written, result.truncated, result.complaints, written.skippedItems),
    out,
    err,
  )
}

/** One place decides what reaches the streams, so the exit code and what the
 *  user reads can never disagree. */
function report(outcome: Outcome, out: (text: string) => void, err: (text: string) => void): number {
  if (outcome.summary !== '') out(outcome.summary)
  for (const problem of outcome.problems) err(`${problem}\n`)
  return outcome.exitCode
}

/**
 * One source per bundle kind, chosen by configuration and never by code
 * guessing (CONTEXT.md).
 *
 * Building and reading sit together because the two sources ask for
 * different things — epics for a group and the subgroups switch, milestones
 * for a project list. Splitting that across two functions would mean
 * branching on the kind twice.
 */
async function readSource(
  config: ValidatedConfig,
  token: string,
  http: Http | undefined,
): Promise<SourceResult & { complaints: { message: string }[] }> {
  const filters = { excludeTitles: config.gitlab.excludeTitles, includeClosed: config.gitlab.includeClosed }

  if (config.gitlab.bundle === 'milestone') {
    const source = createMilestoneSource(config.core.host, token, config.core, http)
    return source.read({ projects: config.gitlab.projects, ...filters })
  }

  const source = createEpicSource(config.core.host, token, config.core, http)
  return source.read({ group: config.gitlab.group ?? '', subgroups: config.gitlab.subgroups, ...filters })
}

/**
 * Where the shipped example config lives.
 *
 * It travels WITH the package (see "files" in package.json), so it is
 * resolved against this module rather than against the working directory —
 * the config path follows the user's cwd (R24), the template does not. This
 * file compiles to dist/src/main.js, so the package root is two levels up.
 */
function examplePath(): string {
  return fileURLToPath(new URL('../../roadmapper.example.toml', import.meta.url))
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new ConfigInvalid(
      `${name} is not set.\n` +
        `Credentials come from the environment, not from the config file:\n` +
        `  export ${name}=...`,
    )
  }
  return value
}

/** The entry point. Kept apart from `main` so tests drive the logic without
 *  a process exit. */
export async function cli(argv: readonly string[]): Promise<number> {
  const environment: Environment = {
    env: process.env,
    cwd: process.cwd(),
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  }

  try {
    return await main(argv, environment)
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigFileMissing || error instanceof ConfigInvalid) {
      environment.err(`${error.message}\n`)
      return 1
    }
    environment.err(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

// The executable entry point. `bin` in package.json points at the built
// version of this file.
//
// The paths are compared RESOLVED: npm installs a bin as a SYMLINK, so
// process.argv[1] is the link while import.meta.url is the real file.
// Comparing them raw makes the installed command do nothing at all — which
// is the one way every user starts it.
if (process.argv[1] !== undefined) {
  const started = realpathSync(process.argv[1])
  if (fileURLToPath(import.meta.url) === started) {
    process.exitCode = await cli(process.argv.slice(2))
  }
}
