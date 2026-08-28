import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parse } from 'smol-toml'

/**
 * The config file named by `--config`, or `roadmapper.toml`, was not there.
 *
 * A type of its own because reading and validating fail differently: a
 * missing file is a path problem, a wrong value is a content problem. The
 * caller decides the exit code and whether to mention `init` — this only
 * reports what it found.
 */
export class ConfigFileMissing extends Error {
  readonly path: string

  constructor(path: string, hint: string) {
    super(`Config file not found: ${path}\n(relative paths resolve against the working directory)${hint}`)
    this.name = 'ConfigFileMissing'
    this.path = path
  }
}

/**
 * Where the config file is, resolved.
 *
 * A relative path resolves against the WORKING DIRECTORY, like any other
 * command-line tool. The tool does not resolve against the location of the
 * program file and does not search parent directories: both would be a
 * search nobody sees, and with two similarly named targets (test.toml,
 * produktiv.toml) that is the worst possible property.
 *
 * `base` is a parameter rather than a `process.cwd()` read inside, so the
 * function stays pure and a test can prove the resolution honestly
 * (ADR-0010: dependencies are parameters).
 */
export function configPathOf(named: string | undefined, base: string): string {
  const path = named ?? 'roadmapper.toml'
  return isAbsolute(path) ? path : resolve(base, path)
}

/**
 * Read and parse the file. Returns the RAW shape — validating it against
 * section 10 is a separate step, because no function in `src/core/` may ever
 * meet a raw config file.
 *
 * The not-found message names the resolved absolute path, so it is visible
 * where the tool looked. For cron that is the whole point: the case the
 * `--config` parameter exists for is at the same time the case with the
 * least obvious working directory.
 */
export function readConfig(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      // Only the DEFAULT file points at `init`. A file the user named is a
      // typo, not a missing setup — and it is never created silently either:
      // whoever writes `--config produktiv.toml` with a typo wants an error,
      // not an empty file beside the real one (R24a).
      const hint = path.endsWith('roadmapper.toml') ? '\nRun `roadmapper init` to create one.' : ''
      throw new ConfigFileMissing(path, hint)
    }
    throw cause
  }

  try {
    return parse(text)
  } catch (cause) {
    throw new Error(`Config file is not valid TOML: ${path}`, { cause })
  }
}
