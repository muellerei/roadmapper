# Fetch, compute, write — and no GitLab field beyond the first

The program is split in three: `src/source/gitlab/` talks to GitLab and returns
bundles, `src/core/` counts and maps them, `src/output/notion/` writes. No
GitLab field name may appear outside `src/source/gitlab/` — not `iid`, not
`webUrl`, not `widgets`. Responses are translated at the edge, never
passed through and unpacked later.

## Consequences

Two things this buys, both concrete. `src/core/` is testable without a
network, a token or a live GitLab — "milestone with 4 issues, 2 closed →
50%" is four lines of invented data. And GitLab's Work Items API is still
marked experimental: when the schema moves, one file changes.

The rule is easy to break by accident. A response object passed one stage
further looks harmless and quietly turns the boundary into decoration.
