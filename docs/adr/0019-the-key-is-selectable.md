# The key is selectable, and the tool builds the URL itself

`[notion].key_is` chooses what a row is identified by:

    "id"    acme/product&7                        short, tells epic from item
    "url"   https://…/groups/acme/product/-/epics/7   a link at the same time

Both are equally stable: they survive a rename in GitLab and break only when
a group moves.

## Why there is a choice at all

Somebody else's Notion table rarely carries an ID column. A URL column is the
smaller favour to ask of its owner — it is useful to their readers, one click
into the original, while an ID looks like database internals. The same column
can then carry both roles, key and link.

`key_is` and `[columns].key` are two different things: the first says *what*
is written, the second *which column* takes it. Pointing both at the same
column is how one column carries both roles, and the repetition is
deliberate — a rule you have to know is worse than a repetition you can see.

## The tool BUILDS the URL, and never takes the API's

Measured 2026-08-24: `webUrl` returns two different forms for the **same**
epic depending on the query path — `/-/epics/23365` through `epics`,
`/-/work_items/23365` through `workItems`.

Passing that through would hang the key on a GitLab rendering decision that
can keep changing with the work-items migration. So the tool composes the URL
from parts it knows: the configured host, the bundle's own path, its number.

The classic forms are chosen (`/-/epics/`, `/-/issues/`) because they have
existed for years, while `/-/work_items/` belongs to an API marked
experimental. All forms are reachable (HTTP 200, checked).

**Do not "modernise" this.** With `key_is = "url"` the URL *is* the key:
changing the form orphans every existing row, and the next run creates a
duplicate beside each one.

Milestones supply only a path without a host, so their URL is composed from
that path and `[gitlab].host` — again from two known parts rather than
guessed.

## Three properties the key must have

Each comes from a real defect of the predecessor:

1. **The path is part of it.** Numbers count per project; `#10` exists
   everywhere. Without the path the second project overwrites the first
   project's rows.
2. **The separators differ.** `&` is GitLab's own notation for epics; without
   the difference epic 1 overwrites item 1.
3. **Milestones need a third character.** `%` is not allowed in GitLab paths
   and is therefore collision-free — with `&` a milestone would clash with an
   epic of the same number in the same group.

## Never change it afterwards

Existing rows then carry the old key and are not found on the next run. The
tool checks for this before writing: a key column holding the other form
aborts the run rather than adding a second row beside every existing one.

## Never delete

If a bundle disappears from GitLab, its row stays. A delete path would have
turned the first wrong key into data loss, and the key is the place with the
most assumption in it.
