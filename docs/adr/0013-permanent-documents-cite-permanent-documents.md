# A permanent document may only cite a permanent document

The published documents — the README, `CONTEXT.md`, `docs/architecture.md`
and every ADR — carry their reasoning themselves. They may cite each
other. They may not cite working material.

Working material may cite them. Never the other way round.

## Why this is written down

The design this project grew out of lived in `docs/entwurf.md`, and five
permanent documents cited it: the README as the explanation of the
design, `architecture.md` for the three stages, ADR-0011 for where the
one-way property belongs, and two agent rule files.

A draft is provisional by definition — it gets superseded, corrected, or
withdrawn. Hanging permanent statements on one is a contradiction that
stays invisible until the file moves. It moved (to `local/`, being
working material), and the citations broke.

The breakage was the symptom. The fault was ADR-0011 saying "which is
where the entwurf already said the one-way property belongs" — an ADR
outsourcing its own reasoning to a document that was never meant to last.
Anyone reading that ADR in two years would have found a pointer instead
of an argument.

`CONTEXT.md` proved the citations were unnecessary all along: it states
GitLab's recursion limit — error message, verification date and all —
without referring to the draft at all. The information was already in the
permanent layer. The citation only looked harmless because nobody
followed it.

## Consequences

An ADR states its decision and its reasons in full. Where it depends on
another decision, it cites that ADR by number, because ADRs are permanent
and are never deleted — a superseded one keeps standing with a successor
naming it.

A reference to a file under `local/`, to a scratch document, to a chat
log or to any external note does not belong in a published document. If
the thought is worth keeping, it gets written into the permanent layer in
its own words; if it is not worth that, it is not worth citing.

This costs some duplication: the same finding may appear in an ADR and in
working material. That is the point. The published layer must survive the
deletion of everything else in the repository.
