# A cut child list is fetched, not reported

GitLab caps a `children` connection at 100 per page and offers no way to
raise it. A bundle with more descendants than that arrives cut short, and
the answer carries no sign of it: a full page looks exactly like a
complete one. `pageInfo { hasNextPage }` is the only field that tells them
apart, and the query has to ask for it — nothing else in the response
does.

The tool fetches the remainder. It addresses the work item by its global
`id`, carries the cursor of the previous page, and appends the tail before
anything is translated.

## What the cut costs

Measured 2026-08-26 against a real group of 51 epics. Four overflowed:

    epic A   100 of 205 children
    epic B   100 of 195
    epic C   100 of 105
    epic D   100 of 102

Three things are derived from that list, and all three were wrong on the
largest bundles:

- **Item rows.** 105 of epic A's items got no row of their own.
- **Child bundles.** A sub-bundle past position 100 is not translated at
  all — it and its whole subtree vanish, including its own row.
- **State and activity.** Both are derived from `[...items, ...children]`.
  An arbitrary 100 of 205 children decided whether the bundle read as
  active or blocked, and how recently it had moved.

The last is the one that matters most: those are the two columns the board
exists for. A bundle whose only running work sits past position 100 reads
as idle, and its "last activity" can be weeks too old — with no error, on
a run that reports success.

**Progress was never affected.** It comes from
`rolledUpCountsByType`, which GitLab totals over the whole subtree
independently of this list (ADR-0015). That decision, taken for a
different reason, kept the one number that would have been hardest to
notice as wrong.

## Why fetching rather than reporting

The alternative was to detect the overflow via `pageInfo` and name the cut
bundle in the closing report, the way depth truncation already is. It
would have been cheaper and follows an established pattern in this
codebase.

It was rejected because the two cases are not alike. Depth truncation
reports a limit of the QUERY against a tree that keeps going — the data is
reachable only by descending further, and the tool deliberately stops.
Here the data is one request away. "Configuration says how, never what"
asks the tool to name gaps in the SOURCE rather than fill them; a child
GitLab holds and will hand over on request is not a gap in the source. It
is data the tool declined to fetch.

Reporting "this bundle's state may be wrong" is not an acceptable
substitute for the right state when the right state costs one round trip.

## What it costs

The follow-up fires only where `pageInfo` reports an overflow. On the
measured group that was 4 bundles of 51, adding 5 requests to the run;
the other 47 cost nothing. A bundle fetched this way is walked again in
turn, because a sub-bundle with 150 items of its own overflows exactly as
its parent did.

## The constraint this creates

The child page size must stay at 100. Lowering it looks tempting when the
outer query is slow, and it silently drops children: measured at 20 per
page, the same group lost 533 of 1090 children, one epic reporting 20 of
its 77 items. Only the OUTER page size is free to change.

A follow-up reads a child through the same fragments as the main query.
Two copies of that selection would drift, and a bundle would then carry
two kinds of item depending on which page each arrived on.
