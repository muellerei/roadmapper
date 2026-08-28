# Context

The vocabulary of this project. One term, one meaning — in code, in docs,
in conversation.

## Bundle

A named group of issues that management can talk about as one thing: it
has a name, a state, a share of work done, and often a date.

A bundle is the middle level. An issue is too small for a roadmap, a
project too large.

Two GitLab constructs can act as a bundle, and the tool supports exactly
these two:

- an **epic** — its child work items are the issues
- a **milestone** — the issues assigned to it

Which one a given installation uses is configuration, not code. Once
fetched, a bundle carries no trace of where it came from.

Labels and parent issues are deliberately *not* bundles. A label lets one
issue sit in several bundles at once, which breaks any total, and carries
no date.

## Item

One issue inside a bundle. Carries a title, a state, a link back to
GitLab, and whatever else a column mapping asks for.

The tool writes items to Notion alongside their bundles, so that a view
can show either level. It does not invent a hierarchy Notion would have
to maintain: the bundle a item belongs to is a field on the item.

## Source

The part that talks to GitLab and returns bundles.

There is one source per bundle kind (`epic`, `milestone`). A source owns
everything GitLab-shaped: the GraphQL query, pagination, complexity
limits, and the translation into bundles and items.

**Nothing outside a source may name a GitLab field.** No `iid`, no
`webUrl`, no `widgets`. The moment such a name appears elsewhere, the
boundary is decoration.

**Inside a source those same names are the point.** The stage owns them
and reads them as values — `workItemType.name === 'Epic'` is the rule
working, not a breach of it. The ban is on carrying one source's
vocabulary into the middle, never on using it at the edge; a source that
avoids its own vocabulary stops translating and starts guessing
(ADR-0003).

## Key

The value that identifies a Notion row across runs, so a second run
updates the row instead of adding another.

The key is derived from GitLab and written into a column the tool owns.
Editing it by hand breaks the link and produces duplicates.

**It carries the item's own project path, never the configured one.** A
number counts per project — `#42` exists everywhere — so the path is what
tells two tickets apart. Both sources read it from the item itself: an
issue reached through a group milestone belongs to a sibling project, and
keying it by the project that was configured would collapse two different
tickets onto one row, each run overwriting the other.

## Progress

How much of a bundle is done, derived by counting its items — closed
against total.

Progress is always *derived*, never carried. There is no configuration
that supplies it, and no human column that overrides it. A bundle whose
issues are untracked has no progress, and the tool says so rather than
guessing.

**Nested bundles count through.** An epic may contain epics. Progress
counts the issues in the tree, not the direct children: an epic holding
one open sub-epic that is itself 40/50 done reads as 80%, not 0%. The
number stands in a management view, and a misleading number there is
worse than an expensive query.

There is no depth cap. GitLab returns the counts for a whole subtree in
one field — descendants per type and state — so nesting goes as deep as
GitLab itself allows (ADR-0015). Where the count cannot be obtained, the
tool says so rather than reporting a quiet undercount.

## Derived

The property that makes this tool worth having: everything it writes
comes from GitLab and can be recomputed from GitLab.

A derived view cannot disagree with its source. When it looks wrong, the
labels are wrong — and that is the useful failure, because it points at
the thing everyone reads instead of at a copy.

The opposite is a *maintained* view: a board someone keeps by hand, which
starts drifting the day after it is written.

## Owned column

A Notion column the tool writes on every run. Listed in the column
mapping.

Everything else in the table is a **human column**: the tool never reads
or writes it. That is where people keep what GitLab does not know —
workstream, owners, comments. The distinction is what makes it safe to
run the tool repeatedly against a table people also work in.

The distinction covers columns only. **Page content is always owned**:
the body of every synced row is rewritten on each run, on every level
(ADR-0009). What a human writes there does not survive; a Notion comment
does, and the tool never touches those.

**One role, one column.** Each entry in the mapping claims a column of its
own; two roles naming the same one is rejected before the first request. A
column holds one value, so the second role would overwrite the first —
and where that is the key, the next run stops recognising its own rows and
creates them again (R29).

**A column of the wrong type is not owned.** Ownership follows the
mapping *and* the schema: if the named column cannot hold what the role
writes — `progress` into a text column, say — the tool leaves it alone and
names it in the report, rather than sending a value Notion will reject
(EC6).

## State

The value a bundle or an item shows in the board's status column. Always
*derived*, never carried: for an item from its stage, for a bundle from the
states of its children.

The words are the board's own, not the tool's. What `In progress` is called
comes from the configuration, because only the team knows what their board
says.

## Stage

Which work step an item is in, as the source found it. Two things can carry
it — GitLab's own status field, or a scoped label like `Flow::Doing` — and
an item may carry both.

A stage is what the source *reports*. A state is what the board *shows*.

## Stage source

Which of the two carries the stage: `label` or `status`. Exactly one wins,
and the other is never read as a fallback (ADR-0017).

Take what you actually *maintain*, not what happens to be there. A board
advanced through labels leaves the status field on its default value, and
reading that field would put every row on `To do` while the labels knew
better.

## Verdict

What one child contributes to its bundle's state: a value plus three flags —
done, active, blocked. One shape for items and for child bundles alike, so
the derivation treats both the same way.

The flags travel with the value because they cannot be recovered from it: a
finished item under the status stage source carries its display name, not
the closed value.

## Activity

The newest change anywhere in a bundle — its own, its items', its children's.
A date, never a judgement: the tool writes no "still for six weeks", because
when standstill becomes a problem is known only to the team (ADR-0016).

## Health

A human's assessment of how a bundle is doing, rolled up from its
descendants. The one column carrying a *judgement* rather than a derivation
— and the only optional one whose emptiness means "nobody maintains this"
rather than "nothing to report".

It is not a fallback for activity, and activity is not one for it: the two
answer different questions.

## Children

The child bundles of a bundle — sub-epics under an epic. Separate from
items, because the two follow different rules: an item carries a stage, a
child bundle carries a derived state.

Milestones never have children.

## Number

The number GitLab counts per project, shown as `#12`. For **display only** —
identity is the key's job, because `#10` exists in every project.

## One way

GitLab is the source of truth; Notion is the view. Nothing travels back.

A consequence worth stating plainly: moving a card in Notion does not
stick. The next run resets it, because the state is derived — from the
workflow label or from GitLab's status field, whichever the **stage
source** names. That is the design, not a defect — a view that can drift is a second
place to maintain, which is the problem this tool exists to remove.
