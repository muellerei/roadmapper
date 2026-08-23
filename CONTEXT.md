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

## Key

The value that identifies a Notion row across runs, so a second run
updates the row instead of adding another.

The key is derived from GitLab and written into a column the tool owns.
Editing it by hand breaks the link and produces duplicates.

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

## One way

GitLab is the source of truth; Notion is the view. Nothing travels back.

A consequence worth stating plainly: moving a card in Notion does not
stick. The next run resets it, because the state comes from the label.
That is the design, not a defect — a view that can drift is a second
place to maintain, which is the problem this tool exists to remove.
