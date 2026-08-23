# The table is a view, so every page body is replaced on every run

The tool owns the page content of every row it writes — bundle and item
alike — and rewrites it on each run. There is no level whose body is
spared, and no setting to spare one.

This extends ADR-0001 from columns to page content. A card moved in
Notion does not stick; a paragraph typed into a synced page body does not
either. Saying that for columns and quietly promising the opposite for
bodies would be two claims about one table, and nothing on the surface
tells the two apart.

Notes belong in a Notion **comment** — the built-in place for them, which
this tool never touches — or in the GitLab issue, where they reach
everyone who reads the source rather than only whoever opens the board.

## Considered Options

**Sparing the item body** (write it once at creation, never again) is
what the predecessor did, and it protected real notes. It was rejected
for a public tool: the copy then goes stale the moment someone edits the
issue in GitLab, and a stale body looks exactly like a current one. The
predecessor could carry that because its author was its only user.

**An owned region inside the page** — the tool replaces a marked block
range and leaves the rest — was researched against the API (2026-08-23)
and rejected on cost and fragility. Notion has no primitive for it:
blocks are deleted one request at a time, so a 30-row run costs roughly
300 requests, two to four minutes at Notion's ~3 requests per second.
There is no field on a block for a machine marker, so the region boundary
would have to be visible text that any reader can delete or move. It
would also need a delete path, which ADR-0001's predecessor deliberately
avoided, and the API documents neither what happens to comments attached
to a deleted block nor whether nested children are trashed with it.

**A configuration switch** was rejected under ADR-0006. Whether GitLab
content outranks Notion content is a statement about ownership, not about
how to read the source. Set wrong it deletes notes during a run that
reports success — the same kind of setting refused for rate limits.

## Consequences

One rule for three levels, no branch in the writer, and nothing on a page
can be stale. The delete path shrinks to the blocks the tool wrote, so
the failure mode of a wrong key stays "an orphan row is left behind"
rather than "someone's notes are gone".

The promise has to be stated where people meet the table, not only here:
the README, the header of the Notion page, and the setup step. Somebody
will type into a body and lose it, and the only honest defence is having
said so first — in the same place they were invited to look.

Comments carry a limitation worth naming: they hang off a page, so a row
that is deleted by hand takes its comments with it. That is a property of
Notion, not of this tool, but it belongs in the same paragraph that
recommends them.
