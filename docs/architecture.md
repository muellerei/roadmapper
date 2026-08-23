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
    │ ── ADR-0003: no GitLab field name may appear below ──        │
    └───────────────────────┬──────────────────────────────────────┘
                            │   bundle { name, state, progress, date }
                            │   item   { title, state, url, bundle }
                            │   ← target-neutral: no column names,
                            │     no property types, no page ids
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

The seam on the right is why `progress` crosses as counted numbers rather
than as the string `"3/8 done"`. A sentence is a rendering decision, and
a renderer that receives one has to parse it back to draw a bar.

## What one run does

    roadmapper.toml ──┐
    GITLAB_TOKEN      │  config says HOW to read the source,
    NOTION_TOKEN  ────┤  never WHAT the project contains (ADR-0006)
                      ▼
    1  read the target schema
       GET /v1/data_sources/{id}    Notion-Version: 2025-09-03
       │
       │  Notion documents neither an error nor a silent drop for an
       │  unknown column, so the tool checks rather than trusting it.
       │
       ├─ target has the type column  →  write bundles AND items
       └─ target lacks it             →  write bundles only
          (a table that cannot tell the levels apart carries one)

    2  fetch from GitLab           one source, per configured kind
       │                           paginated, complexity ≤ 250
       ▼
    3  compute                     progress counts the issue tree,
       │                           at any depth (ADR-0015)
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
| Config says how, never what | ADR-0006 |
| Notion over REST via the SDK, self-throttled | ADR-0005 |

The vocabulary itself — bundle, item, source, key, progress, owned
column — is defined in `CONTEXT.md`. Terms in the diagrams above use it
exactly; a synonym in code is a defect even when it reads better.
