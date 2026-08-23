# Source and output are roles, and the tool is called roadmapper

    src/source/gitlab/   epic, milestone
    src/core/            bundles, items, progress
    src/output/notion/   the table

The directory names the role; the technology sits one level down. The
package is `roadmapper`, not `gitlab-notion-roadmapper`.

This supersedes the naming assumed in ADR-0003, ADR-0008 and ADR-0010,
which spoke of `src/gitlab/` and `src/notion/`. The boundaries those ADRs
draw are unchanged — only where they run: no GitLab field name outside
`src/source/gitlab/`, no Notion term outside `src/output/notion/`.

## Considered Options

**Keeping technology names** was the earlier position, and it rested on a
premise that turned out to be false: that each role has exactly one
possible filling. Both halves were checked against the APIs on
2026-08-23.

GitHub can fill the source role. Its milestones map almost onto GitLab's
— name, state, `dueOn`, and a closed count, with total issues needing one
extra field instead of a stats object. Sub-issues carry a counted
progress the tool would otherwise compute (`subIssuesSummary { total
completed percentCompleted }`) and nest eight levels where GitLab stops
at two; what they lack is a date, so an epic equivalent would have to
pull one from a second place. Projects V2 is not a bundle at all: no
date, no progress aggregate, state only open-or-closed.

The output role has more than one real candidate: an HTML page, a daily
mail, an archive file. They differ in more than format — a Notion write
is idempotent, a mail is not — which is itself an argument for a role
that can hold differently-built members.

Cockburn's rewrite from technology names to purpose names happened when a
team's second and third adapter arrived. Both roles here now have a
demonstrated second, so the condition holds. Fowler's objection —
abstraction without a payer is "presumed guilty" — was what carried the
earlier decision, and it no longer applies.

**Naming the roles without nesting** (`src/source/gitlab-epic.ts`) was
rejected because rclone and restic both nest, and for the same reason:
the technologies below a role share their own quirks. Pagination,
complexity limits and the 403 on foreign subgroups belong to GitLab, not
to sourcing.

## Consequences

The rule stays checkable, one level deeper: a file under
`src/source/gitlab/` may name GitLab fields, one under `src/source/`
itself may not. A reviewer still reads the path to know what is allowed.

`roadmapper` says what the tool does and outlives what it talks to. What
it gives up is discoverability — nobody searches for "roadmapper", and
the earlier name matched the search that finds the gap. The README and
the package description carry that instead: a name identifies a thing,
a description answers a search.

The scope does not widen with the names. Two bundle kinds stay two
(ADR-0002), and a bundle stays a named group of issues with counted
progress. Statistics over the backlog — open bugs, ticket counts — are
not bundles and would change what `src/core/` computes, not which output
receives it. That is a separate decision, and this ADR does not make it.
