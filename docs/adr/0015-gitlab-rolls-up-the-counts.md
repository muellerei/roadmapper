# GitLab rolls up the counts, so the depth cap is gone

Progress still counts issues in the tree, closed against total, derived and
never carried — ADR-0007 decided that and it stands. What changes is how
the number is obtained, and with it the two-level cap that ADR-0007
presented as unavoidable.

`WorkItemWidgetHierarchy.rolledUpCountsByType` returns, for one work item,
the number of descendants per type and state:

    rolledUpCountsByType {
      workItemType { name }
      countsByState { all closed opened }
    }

Taking the `Issue` entry gives closed-against-all for the whole subtree in
a single field. No nested `children`, no recursion, no cap.

## Verified, not assumed

Against `gitlab-org` on 2026-08-23. Epic 23356 has eight issues and two
sub-epics as direct children. Its rolled-up count reports ten issues, one
closed. Fetching the sub-epics separately accounts for the difference:
sub-epic 235 rolls up two issues, one closed. Eight direct plus two nested
equals the ten GitLab reports — the count crosses the epic boundary.

The recursion limit that produced the old cap is real and unrelated to
this: `RECURSION_THRESHOLD = 2` in GitLab's `recursion_analyzer.rb` trips
on the third repetition of `widgets`/`children` in one branch, separate
from the complexity limit of 250. ADR-0007 was right about the wall. It
was wrong that the wall had to be climbed.

## Consequences

`src/core/` receives a pair of numbers, not a tree to walk. Nested epics
count through at any depth GitLab itself permits — seven levels on
Ultimate — instead of two.

**The field is an experiment**, introduced in GitLab 17.3, and may change.
That is not a new risk: ADR-0004 already accepts the Work Items API as
experimental with no alternative, and this field belongs to it. A
self-managed instance older than 17.3 does not have it, which is a floor
worth naming in the requirements rather than working around.

Where the count cannot be obtained, the tool says so. It does not fall
back to counting direct children, because a number that silently means
something narrower than it claims is worse than no number (ADR-0007).

Supersedes ADR-0007 on the depth cap only. Everything else that ADR
decided — progress is counted, never carried, and a misleading figure in a
management view costs more than an expensive query — is unchanged.
