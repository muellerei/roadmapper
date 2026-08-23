# Progress counts issues in the tree, capped at two levels

> **The depth cap is superseded by ADR-0015.** GitLab returns the rolled-up
> counts itself, so no nested query and no cap are needed. Everything else
> below still holds. The reasoning is kept because the recursion limit it
> describes is real and will be met again by anyone querying `children`
> directly.


An epic may contain epics. Progress counts the issues below it, not its
direct children: an epic holding one open sub-epic that is itself 40/50
done reads as 80%, not 0%. The number sits in a management view, where a
misleading figure costs more than an expensive query.

## Consequences

Depth stops at two levels of children — not our choice. GitLab rejects a
third outright (verified 2026-08-23):

    Recursive query - too many of fields
    {"widgets"=>3, "children"=>3} detected in single branch

Not the complexity limit of 250 but a separate recursion guard. Going
deeper would need one more query per level. Where the cap bites, the tool
names it rather than reporting a quiet undercount.
