import type { CoreConfig } from './types.js'

/** What the key of a bundle is built from. An object, not a parameter list:
 *  five positions in a row, three of them string, and swapping `kind`
 *  against `sourcePath` would compile cleanly. */
export type BundleRef = {
  /** The bundle's OWN path, not the configured group. With subgroups
   *  enabled, epic numbers collide across subgroups — using the configured
   *  group would produce one key for two epics. */
  path: string
  number: number
  kind: 'epic' | 'milestone'
  /** The path segment for the URL form, supplied by the source. null for
   *  epics, whose URL is built from `path` and `number` instead. */
  sourcePath: string | null
}

/**
 * The one place a key is composed, for both forms of `keyIs`. Composing
 * them in several places is exactly the mistake section 5 describes.
 *
 * Three rules, each from a real defect of the predecessor:
 *   1. the path is part of it — the number counts per project, #10 exists
 *      everywhere, and without the path the second project overwrites the
 *      rows of the first
 *   2. the separators differ — `&` is GitLab's own notation for epics;
 *      without the difference epic 1 overwrites item 1
 *   3. milestones need a third character — `%` is not allowed in paths and
 *      is therefore collision-free
 *
 * The URL form is BUILT here, never taken from the API. Measured: the same
 * epic comes back with two different URL forms depending on the query path
 * (`/-/epics/` one way, `/-/work_items/` the other). Passing that through
 * would hang the key on a GitLab rendering decision. The classic forms are
 * chosen because they have existed for years, and with `keyIs = "url"` the
 * URL IS the key: changing the form would orphan every existing row.
 */
export function bundleKeyOf(ref: BundleRef, cfg: CoreConfig): string {
  if (cfg.keyIs === 'url') {
    return ref.kind === 'epic'
      ? `${origin(cfg)}/groups/${ref.path}/-/epics/${ref.number}`
      : `${origin(cfg)}${ref.sourcePath ?? ''}`
  }
  const separator = ref.kind === 'epic' ? '&' : '%'
  return `${ref.path}${separator}${ref.number}`
}

/** The key of one item, in whichever form `keyIs` asks for. */
export function itemKeyOf(projectPath: string, number: number, cfg: CoreConfig): string {
  return cfg.keyIs === 'url'
    ? `${origin(cfg)}/${projectPath}/-/issues/${number}`
    : `${projectPath}#${number}`
}

/** A trailing slash on the host is rejected by config validation (R29), but
 *  the key is the place with the most assumption in it, so it is stripped
 *  here as well rather than trusted. */
function origin(cfg: CoreConfig): string {
  return `https://${cfg.host.replace(/\/+$/, '')}`
}
