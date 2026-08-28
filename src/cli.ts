/** What the command line said. Parsed on its own so a test can drive it
 *  without spawning a process. */
export type Invocation = {
  command: 'run' | 'init' | 'help'
  /** The file named by `--config`, or undefined for `roadmapper.toml` in the
   *  working directory. Kept as WRITTEN: resolving it is the config reader's
   *  job, and the difference matters — a file explicitly named is never
   *  created silently (R24a). */
  config: string | undefined
}

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage:
  roadmapper [--config <file>]        derive the roadmap and write it to Notion
  roadmapper init [--config <file>]   check the prerequisites and set up

Without --config, roadmapper.toml in the working directory is used.
A relative path resolves against the working directory — for cron, give an
absolute one.

Credentials come from the environment: GITLAB_TOKEN and NOTION_TOKEN.`

/** Two subcommands, one optional flag (R23). Hand-parsed: a parser
 *  dependency for two shapes would be the third dependency the spec asks a
 *  reason for. */
export function parseArgs(argv: readonly string[]): Invocation {
  const args = [...argv]
  if (args[0] === '--help' || args[0] === '-h') return { command: 'help', config: undefined }

  const command = args[0] === 'init' ? 'init' : 'run'
  if (command === 'init') args.shift()

  let config: string | undefined
  while (args.length > 0) {
    const arg = args.shift()!
    if (arg === '--config') {
      const value = args.shift()
      if (value === undefined) throw new UsageError('--config needs a file name.')
      config = value
      continue
    }
    if (arg.startsWith('--config=')) {
      config = arg.slice('--config='.length)
      if (config === '') throw new UsageError('--config needs a file name.')
      continue
    }
    // Asked-for help is not an error: it prints and exits 0.
    if (arg === '--help' || arg === '-h') return { command: 'help', config: undefined }
    throw new UsageError(`Unknown argument: ${arg}`)
  }

  return { command, config }
}
