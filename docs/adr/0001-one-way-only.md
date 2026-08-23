# One way only: GitLab is the source, Notion is the view

A management board kept by hand next to the issue tracker drifts from the
day it is written. We derive the board from GitLab instead, and nothing
travels back: no state, no dates, no progress.

## Consequences

Moving a card in Notion does not stick. The next run resets it, because
the state comes from the label. This is the design, not a defect — a view
that can drift is a second place to maintain, which is the problem this
tool removes. Expect this to be reported as a bug; it is in the README
for that reason.
