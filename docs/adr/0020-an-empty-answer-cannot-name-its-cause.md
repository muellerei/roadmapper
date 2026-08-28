# An empty answer cannot name its own cause

A run that finds no bundles exits 0 and says where to look. It does not
exit non-zero, not even when the likely cause is that the instance cannot
carry epics at all.

## The row that could not be built

The specification's error table (spec section 12, working material) held
two rows that describe the same observation:

    the source returns no bundle              name the gap        exit 0
    bundle = "epic", the instance has none    abort with the      exit != 0
    (edition)                                 milestone way out

Implementing the second one is not a matter of effort. Epics are a GitLab
Premium feature, and a Free instance does not refuse the query — it
answers `workItems(types: [EPIC])` with an empty list, exactly as a
Premium group with no epics does. The two observations are identical on
the wire, so no code can decide which row applies.

Asking the instance about its edition would need a second query on a run
that has just established there is nothing to sync, and it would still be
a guess about intent: a group can be empty for a dozen reasons that have
nothing to do with the licence.

## What replaces it

The advice the row wanted is worth having, so it is a **sentence in the
report** rather than an exit code. An empty run configured for epics names
all the causes it cannot distinguish between — the subgroup switch, and
the Premium feature with `bundle = "milestone"` as the way out — and
leaves the reading to the human, who knows which instance they are on.

The same text already served `init`, where it belongs even more: setting
up is where an unusable configuration should surface, while the tool has
somebody's attention. It is now used in both places from one function, so
the two cannot drift.

## Why the exit code stays 0

ADR-0014 fixed what a non-zero exit means: **the run did not happen.** An
empty group does not meet that — the run happened, it read the source, and
it found nothing to write. The tool is meant for cron, and a nightly
failure mail for a group that is simply empty trains its reader to ignore
the mails. Then the one mail reporting a real abort goes under — which is
the failure this whole distinction exists to prevent.

The distinction holds throughout: a 403 on the *configured* group aborts,
because there the refusal IS the finding. An empty answer is not a
refusal.

## What this costs

Somebody running against a Free instance sees a report rather than a
failure, and has to read it. That is the accepted price. The alternative —
exit 1 whenever an epic run comes back empty — would fire on every
correctly configured group that happens to have finished all its epics,
and it would fire every night.
