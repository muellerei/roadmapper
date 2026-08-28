# When children disagree, the configuration order decides

`active` and `blocked` are lists: a board can have several states meaning
"it is running" or "it is stuck". Rows 4 and 5 of the state table put
**one** value in the column. So when the children that triggered the row
carry different ones, something has to choose.

The rule:

1. All triggering children carry the **same** value → that one. This is the
   normal case and always exact.
2. They carry **different** ones → the value the configuration names
   **first**.

Whoever writes `blocked = ["Blocked", "Waiting"]` has already said which one
wins when there is a choice. No extra entry, no rule anyone has to know.

## Why not the first child delivered

GitLab guarantees no order. The same data would produce different cells on
two runs, and the row would flicker without anything having changed — the
worst property for a view people are meant to trust.

## Array order is guaranteed; table order is not

This decision leans on TOML array order, and that is deliberate: an array is
an ordered sequence, and the order is part of the value. Measured with
`smol-toml` on 2026-08-24: `["Blocked", "Waiting", "Zeta", "Alpha"]` arrives
unchanged, not sorted.

**This does not contradict the closed-state decision.** There, "the last
value in `[status]`" was rejected, because that would depend on the key
order of a TOML **table** — which neither TOML nor any parser guarantees. A
reordered block would have changed the state silently, so `closed` became a
named entry instead.

Two different things: an array's order may be relied on, a table's key order
may not. A later reader who takes one for the other will reverse one
decision with the other's argument.

## What was rejected

- **The most frequent value** — not unique on a tie, so it needs the same
  rule on top anyway.
- **A collected value of its own** — a new configuration entry, and the
  Notion column would have to carry it as an option or the write fails.
- **Concatenating the values** — produces a value the board does not know.

## The empty triggering set

Row 5 has two triggers, and only `active` carries a value: `done` does not,
because finished children hold `closed`. When only the `done` trigger fires,
the triggering set is empty — and then the configuration's first value
applies as well, by the same rule, on the empty set.

Returning the default there was a real defect: a bundle with one finished
and one unlabelled ticket read as "not started", the inversion of its own
situation. Only an empty `active` list falls back to the default.
