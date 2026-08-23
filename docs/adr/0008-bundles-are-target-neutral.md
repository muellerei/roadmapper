# Bundles are target-neutral, so a second output can be added later

`src/core/` returns bundles and items shaped by the domain, never by the
target. ADR-0003 keeps GitLab field names inside `src/source/gitlab/`; this is
the same rule pointing the other way: **no Notion term may appear outside
`src/output/notion/`** — not a column name, not a property type, not a
`data_source_id`.

A second rule follows from it: an output stage never fetches. Every
output receives the same set of bundles from the same run. A second
output that reads GitLab itself is a second source of truth, which is the
failure this tool exists to remove.

Notion is the only target today, and HTML output still belongs to a
different tool. This ADR does not add a feature. It records what the
boundary has to look like for one to be addable at all.

## Considered Options

Shaping bundles for Notion directly was rejected, though nothing today
would notice. The cost lands later and elsewhere: a renderer would
receive rows already flattened into columns and would have to unpack them
back into a bundle to draw a progress bar. The stage that decided the
shape is not the stage that pays for it, which is why the rule has to be
written down rather than remembered.

The predecessor skill shows the second rule mattering in practice. Its
HTML renderer called the sync script *and* read GitLab again on its own,
so page and table could disagree while both looked freshly generated.

## Consequences

Column mapping lives in `src/output/notion/`, not in the config layer that
`src/core/` sees. A bundle carries `progress` as counted numbers, not as
`"3/8 fertig"` — the sentence is a rendering decision, and rendering
belongs to whoever writes.

The rule is invisible while there is one target. Nothing fails, no test
turns red, and a Notion detail in `src/core/` looks like a shortcut that
saved a line. That is exactly how the boundary in ADR-0003 erodes too,
and the same answer applies: the review question is whether the term
belongs to the domain or to the target.
