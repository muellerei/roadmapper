/**
 * The prefix of a scoped label: everything before the LAST `::`.
 *
 * GitLab knows multi-level scopes like `AST::Ruleset::FN`, and the scope it
 * holds exclusively there is `AST::Ruleset`, not `AST` (R7a, measured in
 * gitlab-org).
 *
 * A FLAT label without `::` has no prefix and yields the empty string. R7b
 * counts all flat labels as ONE prefix between them, which falls out of that
 * naturally: they all map to `''`, so a set of them has size one.
 *
 * This lives in one place because it was written six times and one copy had
 * already drifted — the `[status]` validation returned the label itself for a
 * flat label and therefore rejected a configuration R7b explicitly allows.
 * That is the same failure the forbidden-list check exists against: two
 * copies diverge, and the odd one reports the wrong thing.
 */
export function prefixOf(label: string): string {
  const cut = label.lastIndexOf('::')
  return cut === -1 ? '' : label.slice(0, cut)
}

/** The distinct prefixes of a set of labels, flat ones counting as one
 *  between them (R7b). */
export function prefixesOf(labels: Iterable<string>): string[] {
  return [...new Set([...labels].map(prefixOf))]
}
