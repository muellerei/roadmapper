# The page size finds itself

GitLab gives a GraphQL query about thirty seconds. The epic query asks for
a page of bundles and, for each, its widgets and its child list — so what
the server actually pays for is the number of CHILDREN in one answer, not
the number of bundles the query named. Those two are only loosely
related: a group of thin bundles and a group of fat ones cost wildly
different amounts for the same page size.

The query therefore starts at ten bundles per page, and halves the page
and asks again whenever GitLab times out.

## Why not simply a good constant

There isn't one. Measured 2026-08-26 against a real group of 51 epics
(1091 children, median 10 per epic, four epics over 100):

    bundles/page    children in the answer    seconds    result
             3                        102        4.9     ok
             8                        181        9.4     ok
            12                        384       21.5     ok
            16                        558       30.1     on the wall
            18                          —       30.4     timeout
            20                        601       30.5     timeout

The wall sits around 450–550 children per answer. But the same request
varies by 40 % between attempts — six identical calls at a page of ten
ranged from 13.4 to 18.4 seconds — and a page of twenty that completed
three times out of three one day failed three of three the next, with the
query unchanged. A constant chosen from a measurement is a constant
chosen from one group on one afternoon.

Ten is the largest size that completed three of three across repeated
full runs (six requests, 58–68 s). Five is no faster despite eleven
requests, because the time is server work rather than round trips — so
starting smaller buys nothing, and ten leaves room to halve.

## Why halving, and why it stays down

A timeout is the one refusal a smaller question can answer. GitLab
reports it as HTTP 200 with `errors` whose messages begin `Timeout on `,
which is what distinguishes it from a refusal on the merits — a
misspelled field stays misspelled however little is asked for, and
retrying it would only delay the same error.

The retry resumes from the SAME cursor. The failed attempt fetched
nothing usable, so moving on would skip the bundles it was meant to read.

A size that worked is kept for the rest of the run rather than raised
again. Whatever made the first attempt too heavy — a loaded server, or
bundles that are simply fat — does not change within a run, and going
back up would spend another thirty seconds learning the same thing on the
next page. Observed live against the real group, starting deliberately at
forty:

    40 -> 20 -> 10 -> 10 -> 10 -> 10 -> 10 -> 10

Two failed attempts, then 51 bundles and 1300 children, complete.

## The partial answer is not used

A timed-out answer arrives with `data` present, `pageInfo` intact, and
null nodes scattered through it — measured, 8 of 40 nodes null, with
nothing naming which bundles they were. It is tempting, and wrong: a
roadmap with holes published as a complete one is the failure this whole
tool is written against. Only the cursor is kept.

## Where halving ends

At one bundle per page. Below that the finding has changed: it is no
longer "too many bundles at once" but "this one bundle is too large for
GitLab to answer about", and the message says so. Naming a page size
there would be an instruction the reader cannot follow — there is nothing
left to lower.

## Not configurable

A setting would exist to let someone lower the page size. It lowers
itself. An instance with a more generous budget pays a few extra requests
for a limit it does not have, which is a real cost — but a smaller one
than a switch nobody understands, and one that can be revisited if
somebody with such an instance ever measures the difference.

The CHILD page is unaffected and stays at 100: children are fetched to
the end (ADR-0022), and a smaller bite there drops them silently.
