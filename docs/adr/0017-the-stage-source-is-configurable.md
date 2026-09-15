# The stage source is configurable, and exactly one wins

Supersedes, in one point: [ADR-0001](0001-one-way-only.md)

An item can carry its work step in two places:

- **GitLab's own status field** (`stage.category`), which needs no
  configuration — `'active'` means active because GitLab defines it so.
- **A scoped label** (`Flow::Doing`), mapped through the `[status]` table.

`[gitlab].stage_source` says which one is read. The other is **not** read as
a fallback, ever. Where the chosen source carries nothing, the state is the
default value, and the closing report says how full that source was.

## Why not a fixed ranking

A fixed "status field first" would be wrong for teams who advance their
workflow through labels and never touch the status field. Measured against a
real working group on 2026-08-24:

| | status field | scoped workflow labels |
|---|---|---|
| defined | 5 (GitLab defaults, untouched) | 10, each described |
| across 9 open issues | **9× `To do`** | 8× spread over three steps, 1× unlabelled |

The status field is present and 100 % filled — with the default value nobody
ever set. With a fixed ranking every Notion row would have read `To do`
while the source knew better.

**Maintained beats present**, and which of the two is maintained the tool
cannot know. That is a statement about how to read the source, so it belongs
in the configuration (ADR-0006).

The counter-proposal — take the status field only when it is *not* on its
default value — was rejected: that would be a guess about foreign
workflows. A team whose tickets genuinely all sit in the backlog would be
switched to the other source without being told.

## Reading both at once is excluded

Two places for the same statement can contradict each other, and then the
tool would have to guess. That is the second truth this tool exists to
remove (ADR-0001).

## What this supersedes

[ADR-0001](0001-one-way-only.md) says the state comes from the label. That
was true when it was written and is now too narrow: the state comes from the
label **or** from GitLab's status field, whichever `stage_source` names.

**The consequence ADR-0001 draws stays correct in full**: moving a card in
Notion does not stick, because the next run resets it. Only its derivation
has widened.

The same half-sentence appears in
[ADR-0006](0006-config-says-how-not-what.md), whose opening line describes
the configuration as mapping "labels to states". ADR-0006's substance — the
configuration says *how* to read, never *what* is in the source — is
untouched and stands. That phrasing is simply older than `stage_source`; a
separate superseding ADR for one half-sentence would be disproportionate,
so it is recorded here.
