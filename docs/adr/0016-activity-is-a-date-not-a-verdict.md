# Movement is a date, never a verdict

The board answers three questions, and the second one is "is this moving?".
The tool answers it with `lastActivity` — the newest `updatedAt` among a
bundle, its items and its children — and with nothing else.

## What it does not do

It does not say "still for six weeks". It does not colour a row red after a
threshold. It does not carry a `stale` flag.

When a standstill becomes a problem is known only to the team, and it
differs per bundle: a research epic that has not moved in a month is
healthy, a release blocker that has not moved in three days is not. A
threshold in the tool would be a claim about foreign projects — the same
reason ADR-0006 keeps project content out of the configuration.

Notion filters on "older than X" itself. Whoever wants the judgement makes
it in the view, where it belongs and where it can differ per column.

## Why children count

The date reaches through the whole tree. An epic whose work happens only in
its sub-epics would otherwise carry just its own timestamp and look still
while people are working in it — the same mistake the state derivation
avoids by counting child bundles (spec section 9).

## The known price, deliberately accepted

**A comment counts as movement.** GitLab's `updatedAt` changes when someone
writes a comment, not only when the work changes.

That is the right way round: for a ticket being discussed, "is moving" is
the truer statement than standstill. It is a known imprecision, not a
defect — do not filter `updatedAt` down to "real" changes, and do not
report it as a bug.

## Why it is not `health`

`health` and `lastActivity` answer DIFFERENT questions, and one is not a
fallback for the other. "Moved three days ago" says nothing about whether
something is stuck; a blocked ticket under active discussion moves daily.

A column holding sometimes one and sometimes the other could be neither
filtered nor read. So when `health` is unmaintained, that column stays
empty rather than borrowing this one (spec section 8).
