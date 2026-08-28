# A column of the wrong type is skipped, not written into

The tool reads the target schema before writing. Where a configured
column exists but carries a type the role cannot be written into, that
column is left out for the whole run and named in the report. The other
columns are written normally.

## What made this a decision rather than an oversight

Notion is loud about this, not silent: sending `{ number: 0.4 }` into a
text column comes back as a 400 naming the problem. So the naive reading
is that no check is needed — the API already complains.

It complains **per row**, and every row writes the same columns. One
column of the wrong type therefore fails every row, and a run where every
row failed is reported as "the run did not happen" with exit 1 (ADR-0014).
A table that is one column short would present itself as a total outage.

Put shortly: *an abort halfway through is worse than an omission at the
start.*

This is not hypothetical. The tool this one replaces wrote `"3/8 done"`
into `Progress` as **text**. Anyone migrating from it has a table whose
`Progress` column exists, is named correctly, and has the wrong type.

## Which types count as right

More than one per role, and that is the reason the table lives in the
writer rather than being derived from what `init` creates:

    key                      rich_text, url
    name                     title
    state, type, health      select, status
    progress                 number
    url                      url
    due, activity            date

`init` creates exactly one shape per role; this list is what the writer
can *handle*, which is a different question. `key` accepts a URL column
because `key_is = "url"` asks for one; the three select-like roles accept
Notion's `status` type because the writer branches on it already.

**`key` deliberately does not accept `title`.** The key is read back out
of the target on the next run, and only `url` and `rich_text` are read.
A key in the title column would be written and then never found again —
which is the duplicate-row failure the key exists to prevent, arrived at
from the other direction.

## Why skipping and not aborting

Aborting would move the failure to the start, which is half of what is
wanted. But it would also refuse to write a board that is otherwise
correct, over one column the reader may not even use. Skipping keeps the
run useful and turns the column into what it actually is: a gap, named in
the report next to the other gaps, alongside the fill rate that says the
column is empty.

The check therefore lives at the same place as `health` being optional —
a role whose column is missing costs nothing, and a role whose column
cannot hold it costs that column and a sentence.

## What this does not do

It does not change the column. `init` only ever adds columns and never
retypes an existing one, for the same reason: the target is usually
somebody else's table. Fixing the type is a human decision, made in
Notion, and the report says so.
