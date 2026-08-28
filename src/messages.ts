/**
 * The messages that name a CLICK PATH rather than a state — kept in one
 * place because several of them are used twice, and a message that drifts
 * between two copies is worse than one that is merely terse.
 *
 * The reason they exist at all: a Notion database that is not shared returns
 * exactly the same `not found` as a wrong id. Whoever does not know that
 * looks the id up again instead of setting the sharing, and the message sent
 * them to the wrong place.
 *
 * These are program output and therefore English. Values inside them — a
 * user's database id, group path or column names — are data and are quoted
 * verbatim.
 */

/** The database answers `not found`, which has two causes that look
 *  identical from outside. Both are named, common one last. */
export function notionNotVisible(database: string, cause: string): string {
  return (
    `Notion cannot see the database ${database}.\n` +
    `That answer means one of two things, and they look identical from here:\n` +
    `  1. the id is wrong — it is the part of the database URL before the "?"\n` +
    `  2. the database is not shared with the integration — this is the common one:\n` +
    `     open the database in Notion → ··· → Connections → add your integration\n` +
    `Cause: ${cause}`
  )
}

/** The integration can read but not write. Used by `init` and by the run
 *  when every row failed — the same situation seen from two moments. */
export function notionReadOnly(): string {
  return (
    `When every row fails it is usually a rights problem, not a data problem:\n` +
    `open the database in Notion → ··· → Connections → your integration → Can edit.`
  )
}

/** The token itself was refused. */
export function notionTokenRefused(): string {
  return (
    `Notion rejected the token.\n` +
    `Create an internal integration at notion.so/profile/integrations,\n` +
    `then: export NOTION_TOKEN=ntn_...`
  )
}

/** GitLab refused the token — a 401, as opposed to a rights problem. */
export function gitlabTokenRefused(host: string): string {
  return (
    `GitLab rejected the token.\n` +
    `Create one at ${host} → Settings → Access tokens with scope read_api,\n` +
    `then: export GITLAB_TOKEN=glpat-...`
  )
}

/** GitLab accepted the token but refuses this group — a 403. */
export function gitlabGroupForbidden(group: string): string {
  return (
    `The token works but may not read "${group}".\n` +
    `Check that your account can see that group, and that the token has scope read_api.`
  )
}

/**
 * No epics came back. Epics are a GitLab PREMIUM feature, so on a Free
 * instance the query is not wrong — there simply are none, and hunting for a
 * configuration error would be the wrong search.
 */
export function noEpics(group: string, subgroups: boolean): string {
  return (
    `"${group}" returns no bundles.\n` +
    (subgroups
      ? `Subgroups are included, so this is the whole tree.\n`
      : `Only epics directly in that group are read — set subgroups = true to include them.\n`) +
    `If this instance has no epics at all: they are a GitLab Premium feature.\n` +
    `On a Free instance use bundle = "milestone" instead.`
  )
}

/** The milestone counterpart to `noEpics`: same question, other kind. It
 *  names the projects actually read, because that is where the answer is —
 *  a milestone lives in a project, and a project that carries none is the
 *  likeliest reason for an empty result. */
export function noMilestones(projects: readonly string[]): string {
  return (
    `No milestones in ${projects.map(quote).join(', ') || '(no projects configured)'}.\n` +
    `Milestones are read per project, and only OPEN ones unless include_closed = true.\n` +
    `If your milestones live on the group rather than in these projects, this version\n` +
    `does not read them.`
  )
}

/** The configured stage source does not exist on this instance (EC7b). Never
 *  switched to labels silently — that would be a guess about a configuration
 *  a human wrote deliberately. */
export function statusFieldMissing(): string {
  return (
    `stage_source = "status" is configured, but this GitLab instance returns no status field.\n` +
    `The status field needs GitLab 17.11 or newer.\n` +
    `Either upgrade the instance, or set stage_source = "label".`
  )
}

/**
 * The known gap around group milestones (spec section 17).
 *
 * Worse than merely missing: measured, `Project.issues(milestoneTitle:)`
 * reaches THROUGH to a group milestone of the same name and returns foreign
 * items. So a project whose group carries same-named milestones yields too
 * MANY items rather than none — and "No bundles found" would be misleading,
 * because the milestones do exist, one level up.
 */
export function groupMilestoneGap(projects: readonly string[]): string {
  return (
    `Note: group milestones are not supported in this version.\n` +
    `Milestones are read per project (${projects.join(', ')}), and a project query\n` +
    `reaches through to a GROUP milestone of the same name — which returns items\n` +
    `from sibling projects as well. If your milestones live on the group, the\n` +
    `bundles will hold more items than they should.`
  )
}

/**
 * A user's value inside a message: a column name, a status value, a config
 * entry. Quoted so the value's own spaces and emptiness stay visible — an
 * unquoted empty string reads as a missing word rather than as a value.
 *
 * Here rather than in each reporter: it was written six times, and a quoting
 * that drifts between copies makes two messages disagree about the same value.
 */
export function quote(value: string): string {
  return `"${value}"`
}
