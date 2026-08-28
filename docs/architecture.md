# Architecture

Where each term is allowed to live, and what crosses between stages.

ADR-0003 splits the program into three stages. This file shows the
*boundaries* between them instead: which names each directory is allowed
to use, and what shape the data has when it moves between them. Those are the
rules that erode silently, because breaking one compiles, passes, and
looks like a shortcut that saved a line.

## No GitLab field outside src/source/gitlab/, no Notion term outside src/output/notion/

    ┌─ GitLab ─────────────────────────────────────────────────────┐
    │ GraphQL · iid · webUrl · widgets · workItems · nodes         │
    └───────────────────────┬──────────────────────────────────────┘
                            │
    ┌─ src/source/gitlab/ ──┴──────────────────────────────────────┐
    │ ONE SOURCE PER BUNDLE KIND: epic, milestone                  │
    │                                                              │
    │ owns   the query, pagination (100/page, cursor),             │
    │        complexity (≤250), the 403 on foreign subgroups       │
    │ emits  bundles and items — nothing GitLab-shaped             │
    │                                                              │
    │ ── ADR-0003: no GitLab field name below — above, they are ── │
    │ ──           owned, and read as values                    ── │
    └───────────────────────┬──────────────────────────────────────┘
                            │   Bundle { key, number, name, description,
                            │            closed, due, url, progress,
                            │            lastActivity, health,
                            │            items, children }
                            │   Item   { key, number, title, description,
                            │            closed, stage, url, bundle,
                            │            updatedAt, health }
                            │   ← target-neutral: no column names,
                            │     no property types, no page ids
                            │   ← complete on exit: key, progress,
                            │     lastActivity and health already filled
                            ▼
    ┌─ src/core/ ──────────────────────────────────────────────────┐
    │ counts · groups · maps labels to states                      │
    │                                                              │
    │ knows  no network, no API, no token, no target               │
    │ names  neither a GitLab field nor a Notion column            │
    │                                                              │
    │ ── ADR-0008: no Notion term may appear here ──               │
    └───────────────────────┬──────────────────────────────────────┘
                            │   same bundles and items,
                            │   handed to every output unchanged
      ┌─────────────────────┴──────────┐
      ▼                                ▼
    ┌─ src/output/notion/ ──────┐    ┌─ src/output/…  ──────────────┐
    │ data_source_id            │    │ output/html/, output/mail/   │
    │ properties, blocks        │    │ — possible, not built        │
    │ Notion-Version header     │    │ (ADR-0008, ADR-0011)         │
    │ ~3 req/s, 429 backoff     │    │                              │
    │                           │    │ NEVER fetches a source       │
    │ formats "3/8 done"        │    │ itself — that would be       │
    │ from counted numbers      │    │ a second truth               │
    └───────────────────────────┘    └──────────────────────────────┘

Both rules point the same way: a stage may name what is *above* it only
if it sits at the edge. `src/core/` sits at neither edge, so it names
neither side — which is what makes "milestone with 4 issues, 2 closed →
50%" four lines of invented data instead of an integration test.

## The three directories that are not stages

Four more directories exist, and none of them is a fourth stage. They sit
*around* the pipeline rather than in it, which is why the diagram above
does not show them as boxes in the flow:

    src/config/   reads the TOML and checks it (R29), before anything
                  else runs. Hands `src/core/` a CoreConfig that is
                  already validated — no function in core ever meets a
                  raw config file.

    src/report/   turns a finished run into what the reader sees: the
                  fill rate per column and the closing outcome. Reads
                  rows and results, computes nothing the stages did not
                  already decide.

    src/init/     the `roadmapper init` command. Checks the three
                  prerequisites in a fixed order and adds missing
                  columns. Uses the source and the target, but wires
                  neither: both arrive as parameters from `main.ts`.

    src/cli.ts    two subcommands and one flag, hand-parsed.
    src/main.ts   the wiring, and the only place that does any.

`src/report/` is the one place where the shape of an output leaks
outwards: `outcomeOf` takes a `WriteResult` from `src/output/notion/`. A
second output would meet it there and nowhere else. It is the known cost
of one report rather than one per target, and the narrowest crossing in
the program — every other value it receives is a structural type it
declares itself.

The seam on the right is why `progress` crosses as counted numbers rather
than as the string `"3/8 done"`. A sentence is a rendering decision, and
a renderer that receives one has to parse it back to draw a bar.

## What one run does

    roadmapper.toml ──┐
    GITLAB_TOKEN      │  config says HOW to read the source,
    NOTION_TOKEN  ────┤  never WHAT the project contains (ADR-0006)
                      ▼
    0  check the configuration        R29, before a single request:
       │                              every value known, one column per
       │                              role, closed distinct from default
       ▼
    1  read the target schema
       GET /v1/data_sources/{id}    Notion-Version: 2025-09-03
       │
       │  Notion documents neither an error nor a silent drop for an
       │  unknown column, so the tool checks rather than trusting it.
       │
       ├─ target has the type column  →  write bundles AND items
       ├─ target lacks it             →  write bundles only
       │  (a table that cannot tell the levels apart carries one)
       │
       └─ a column of the wrong TYPE  →  leave that column out, write
          (EC6, e.g. Progress as text)   the rest, name it in the report
                                         — an abort halfway through is
                                         worse than an omission

    2  fetch from GitLab           one source, per configured kind
       │                           paginated, complexity ≤ 250
       ▼
    3  compute                     progress counts the issue tree,
       │                           at any depth (ADR-0015) —
       │                           but the STATE stops after one
       │                           child level (R3c), and the report
       │                           names the bundles it truncates
       ▼
    4  write, one row at a time
       │
       │  query by key ─┬─ hit   → update the owned columns
       │                └─ miss  → create the row
       │                              │
       │                              ▼
       └───────────────────────  then replace the page body,
                                 every row, every run (ADR-0009)
                                 — the table is a view

    throttled to ~3 requests/second; on 429 wait out Retry-After,
    then back off with jitter. Never configurable (ADR-0005).

A run is idempotent: the key decides update-or-create, so an interrupted
run is repaired by the next one. Nothing is ever deleted — a row whose
bundle disappeared from GitLab stays, because the first wrong key would
otherwise have cost data.

## Where the rules are written down

| Boundary | Recorded in |
|---|---|
| Three stages, no GitLab field below the first | ADR-0003 |
| Bundles target-neutral, no Notion term in core, outputs never fetch | ADR-0008 |
| Page bodies always replaced, the table is a view | ADR-0009 |
| Progress counted from the tree, at any depth | ADR-0015 |
| The state stops one child level down, and says so | R3c (spec) |
| Movement is a date, never a verdict | ADR-0016 |
| The stage source is configurable, exactly one wins | ADR-0017 |
| Ambiguous lists decided by configuration order | ADR-0018 |
| The key is selectable, and the tool builds the URL | ADR-0019 |
| An empty answer cannot name its cause, so it stays exit 0 | ADR-0020 |
| A column of the wrong type is skipped, not written into | ADR-0021 |
| A cut child list is fetched, not reported | ADR-0022 |
| The bundle page size halves itself on a timeout | ADR-0023 |
| Config says how, never what | ADR-0006 |
| Notion over REST via the SDK, self-throttled | ADR-0005 |

The vocabulary itself — bundle, item, source, key, progress, state, stage,
stage source, verdict, activity, health, children, number, owned column —
is defined in `CONTEXT.md`. Terms in the diagrams above use it
exactly; a synonym in code is a defect even when it reads better.
