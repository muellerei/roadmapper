# Epics and milestones are the only bundle kinds

Management talks in units bigger than an issue and smaller than a
project. GitLab offers four constructs that could carry such a unit; we
support two: epics and milestones. Milestone is the one that works on
every GitLab tier, epic is the richer one that needs Premium.

## Considered Options

**Labels** (`Feature::X`) were rejected: one issue can carry several, so
no total adds up, and a label holds no date. Both weaknesses would have
to be carried by every downstream stage forever.

**Parent issues** were rejected: young in GitLab, shaped differently in
GitHub, and a due date only sometimes.

## Consequences

A project with neither epics nor milestones gets no board. The tool says
what is missing instead of drawing something out of nothing — that report
is itself useful, because it shows how far the tracker is from carrying a
roadmap.
