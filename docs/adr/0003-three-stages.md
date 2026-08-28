# Fetch, compute, write — each stage owns its own vocabulary

The program is split in three: `src/source/gitlab/` talks to GitLab and returns
bundles, `src/core/` counts and maps them, `src/output/notion/` writes. No
GitLab field name may appear outside `src/source/gitlab/` — not `iid`, not
`webUrl`, not `widgets`. Responses are translated at the edge, never
passed through and unpacked later.

**The rule is about the wrong stage, not about the names.** What must stay
out of `src/core/` is the *vocabulary* of any one source, so a second source
fits beside the first. Inside `src/source/gitlab/` GitLab's words are not
merely tolerated, they are the point: translating them into ours is what the
stage is for. Reading a field GitLab hands over — `workItemType.name ===
'Epic'` — is this rule working, not a breach of it. The same holds for Notion
terms inside `src/output/notion/`.

Substituting a heuristic for a field the API states outright is the failure
this ADR exists to prevent, one layer in. It has happened once, and only a run
against the real API found it: the child classification asked whether a node
*carried* a rollup widget instead of reading its type, the query turned out to
select that widget for both kinds, and every issue was filed as an epic — no
item row was written and nothing failed (R3d). A stage that avoids its own source's vocabulary
stops translating and starts guessing.

## Consequences

Two things this buys, both concrete. `src/core/` is testable without a
network, a token or a live GitLab — "milestone with 4 issues, 2 closed →
50%" is four lines of invented data. And GitLab's Work Items API is still
marked experimental: when the schema moves, one file changes.

The rule is easy to break by accident. A response object passed one stage
further looks harmless and quietly turns the boundary into decoration.
