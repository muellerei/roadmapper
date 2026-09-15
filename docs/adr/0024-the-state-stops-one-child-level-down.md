# The state stops one child level down, and the run says so

A bundle's state is derived from its items and its direct child bundles.
A child bundle contributes its own state as one verdict; what lies
*beneath* that child is not descended into. The nesting is read exactly
one level deep, and every bundle that reaches deeper is named in the
closing report.

## Why this is written down

The rule was decided while building and lived only in the working
material, cited as `R3c` from `docs/architecture.md`, `src/core/types.ts`
and the report. ADR-0013 forbids exactly that: a permanent document
pointing at a document that is not permanent. Anyone asking *why* the
state stops here found a marker instead of an argument, and the marker
led to a file that is not in the repository.

The rule itself is unchanged. What follows is the reasoning it always
had, written where it survives.

## Why one level

**Progress does not need it.** The count comes from
`rolledUpCountsByType`, which GitLab totals over the whole subtree
regardless of how deep it goes (ADR-0015). The number a board is read for
is therefore complete at any depth. Only the answer to "which step is it
in" stops.

**A deeper walk costs a request per bundle.** Children arrive with the
bundle; grandchildren do not. Descending a second level means one more
round trip per child bundle, on every run, for every bundle — to refine a
value that is already correct for the overwhelming majority.

**The gain shrinks with depth while the cost does not.** A state is a
summary of a summary. The first level answers "is anything moving in
here"; the second changes that answer only when an entire child bundle
is itself a pure container whose own items live one level further down.
The price is paid on every bundle, the benefit arrives on few.

## Why it is reported rather than silent

A truncated state is a *wrong* value, not a missing one: a bundle whose
work all sits two levels down reads as untouched while people are working
in it. That is the failure ADR-0016 names for activity dates and ADR-0022
for cut child lists — a run that reports success while one column quietly
says the opposite of the truth.

So the bundles that nest deeper are listed by name in the closing report,
together with the note that their progress is unaffected. The reader can
then judge the one column that stopped, instead of trusting a board that
looks complete.

This follows ADR-0020's rule for the empty answer: the run stays exit 0,
because a bundle nesting deeper than the state follows is not a broken
run. It is a limit, and a limit that names itself is not a defect.

## Considered Options

**Descending the whole tree** was rejected on the cost above. It also has
no natural stop: nothing in GitLab prevents a tenth level, so the walk
would need a cap anyway — and a cap is what this is, chosen deliberately
rather than discovered at an awkward depth.

**Truncating silently** was rejected because the value is wrong rather
than absent. See above.

**Making the depth configurable** was rejected under ADR-0006. How deep
the state is derived is a statement about what the board means, not about
how to read the source — and set wrong it produces a plausible-looking
board with no error anywhere.
