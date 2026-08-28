import { copyFileSync, existsSync } from 'node:fs'

/** One step of the sequence, as the caller reports it. */
export type StepResult = {
  step: number
  title: string
  /** What to tell the user. Every failing message names the CLICK PATH, not
   *  just the state (R27). */
  message: string
  /** True when the sequence stops here on purpose rather than on failure —
   *  step 1 creating a config is a success that still ends the run. */
  done?: boolean
}

/** Raised when a step fails. The sequence aborts on the first one (R26). */
export class InitFailed extends Error {
  readonly step: number

  constructor(step: number, message: string) {
    super(message)
    this.name = 'InitFailed'
    this.step = step
  }
}

/**
 * Step 1 — is there a config?
 *
 * Creating one is `init`'s job, and only `init`'s: a RUN that silently wrote
 * an example config and then synced against invented values would be the
 * opposite of predictable.
 *
 * A file named explicitly with `--config` is NEVER created (R24a): whoever
 * types `--config produktiv.toml` with a typo wants an error, not an empty
 * file beside the real one.
 */
export function configStep(path: string, wasNamed: boolean, examplePath: string): StepResult {
  if (existsSync(path)) {
    return { step: 1, title: 'Configuration', message: `Using ${path}` }
  }

  if (wasNamed) {
    throw new InitFailed(
      1,
      `Config file not found: ${path}\n` +
        `A file named with --config is never created — check the spelling.\n` +
        `To create the default one, run \`roadmapper init\` without --config.`,
    )
  }

  if (!existsSync(examplePath)) {
    throw new InitFailed(1, `No config at ${path}, and the example at ${examplePath} is missing too.`)
  }

  copyFileSync(examplePath, path)
  return {
    step: 1,
    title: 'Configuration',
    done: true,
    message:
      `Created ${path} from the example.\n` +
      `Edit it — at least [gitlab].host, [gitlab].group and [notion].database —\n` +
      `then run \`roadmapper init\` again.`,
  }
}

/**
 * Step 2 — are the tokens set?
 *
 * Before any network call, so a missing token is never reported as an
 * authentication failure against a server that was never asked.
 */
export function tokenStep(env: Readonly<Record<string, string | undefined>>): StepResult {
  const missing = (['GITLAB_TOKEN', 'NOTION_TOKEN'] as const).filter(
    (name) => (env[name] ?? '').trim() === '',
  )

  if (missing.length > 0) {
    throw new InitFailed(
      2,
      `Not set: ${missing.join(', ')}.\n` +
        `Credentials come from the environment, never from the config file:\n` +
        `  export GITLAB_TOKEN=glpat-...   (GitLab → Settings → Access tokens, scope read_api)\n` +
        `  export NOTION_TOKEN=ntn_...     (notion.so/profile/integrations → your integration)`,
    )
  }

  return { step: 2, title: 'Credentials', message: 'GITLAB_TOKEN and NOTION_TOKEN are set.' }
}
