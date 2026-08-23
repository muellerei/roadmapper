# GraphQL for all GitLab reads, including milestones

GitLab is deprecating the REST epics route (`/groups/:id/epics`, gone in
17.0) in favour of the Work Items GraphQL API. Milestones are unaffected
and could stay on REST, but we read everything through GraphQL: one
protocol, one auth path, one pagination style, one set of tests.

## Consequences

The two bundle kinds still fetch differently, because `Milestone` has no
`issues` field in GraphQL. An epic returns its children inline via
`WorkItemWidgetHierarchy`; a milestone needs a second query against
`Project.issues(milestoneTitle:)`. `Milestone.stats` supplies
open/closed counts directly when only progress is needed.

The Work Items API is marked experimental, with GA planned before 19.0.
That is a known risk with no alternative — the old path is dying.
Contained by ADR-0003.
