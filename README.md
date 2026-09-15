# roadmapper

[![checks](https://github.com/muellerei/roadmapper/actions/workflows/checks.yml/badge.svg)](https://github.com/muellerei/roadmapper/actions/workflows/checks.yml)

Derive a Notion roadmap from GitLab epics and milestones. One way: GitLab
stays the source of truth, Notion is the view.

> **Status: in development.** The six stages are built and covered by
> tests; what is not yet verified against a live Notion workspace is noted
> under [Getting started](#getting-started). See [docs/adr/](docs/adr/) for
> the decisions and why they were made,
> [docs/architecture.md](docs/architecture.md) for the boundaries between
> the three stages, [CONTEXT.md](CONTEXT.md) for the vocabulary, and
> [CHANGELOG.md](CHANGELOG.md) for what changed and which defects caused it.

- One command, no daemon, no queue. Suitable for cron.
- Runs where you put it, on the schedule you choose.
- Configuration is a file you can read, copy and version.
- Two runtime dependencies. No LLM involved.
- Read-only on GitLab, one shared database on Notion, no personal data
  read at all — see [Data protection](#data-protection-and-how-to-check-it).

## Why

A management board is normally kept by hand next to the issue tracker,
and it starts drifting the day after it is written. The issues already
carry the same facts: what stage a thing is in, who has it, when it is
due, what blocks what.

A derived view cannot disagree with its source. When it looks wrong, the
labels are wrong — and that is the useful failure, because it points at
the thing everyone reads instead of at a copy.

This is not a ticket shuttle. It reads a hierarchy, counts progress from
the child issues, and writes both levels into one table, so a Notion view
can show management the epic level and anyone else the issues beneath it.

## Who this is for

The shape it fits: developers work in GitLab, and somebody outside GitLab
wants to know where things stand. Three situations it was built around —

- **The Monday morning board.** Someone spends the first hour of the week
  moving cards to match what the sprint actually did. A cron entry at six
  does the same job, and the hour is gone from the calendar rather than
  from the person.
- **A stakeholder who will not get a GitLab seat.** A department head, a
  customer, an external partner — they get a Notion page with the epic
  level and no tracker login, and what they see is what the issues say.
- **A board nobody trusts any more.** The usual end state of a hand-kept
  table: it disagrees with the tracker often enough that people check the
  tracker instead, and the board survives as a thing that has to be
  maintained anyway. Deriving it settles which of the two is right.

It is **not** for keeping two systems in step — that is ADR-0001, and
"one way" is the whole design. If people are meant to plan *in* Notion
and have GitLab follow, this is the wrong tool and no setting changes
that.

Size is not the deciding factor; structure is. The tool needs bundles —
epics or milestones — that someone actually maintains. A tracker where
issues sit loose with no epic and no milestone has nothing to aggregate,
and `roadmapper init` says so rather than drawing an empty board.

### Epics or milestones

The one choice worth making before installing anything:

|  | Epics | Milestones |
|---|---|---|
| GitLab tier | **Premium or higher** | any, including Free |
| Nesting | sub-epics, counted through the whole tree | flat — a milestone holds issues only |
| Dates | the epic's own due date | the milestone's due date |
| Health | rolled up from GitLab's health status | not available, the column stays empty |

Milestones are the honest fallback rather than a crippled mode: progress,
state, activity and dates all work. What you give up is the level above —
a milestone cannot contain another milestone, so a board of them is one
layer deep — and the health column, which GitLab does not carry there.

Configured in `roadmapper.toml` as `bundle = "epic"` or
`bundle = "milestone"`; the run reads one kind, never both (ADR-0002).

## What it does

- Reads **epics** or **milestones** from GitLab as bundles of issues
- Filters out bundles you never want on the roadmap (`exclude_titles`) —
  bots file the same ticket in every repository
- Counts progress from the issues in the tree, not from a field someone
  maintains
- Writes bundles and their issues into one Notion database
- Touches only the columns it owns — human columns (workstream, owners,
  comments) are never read or written
- Rewrites the page content of every row it syncs, on every run, so
  nothing on a page can go stale
- Runs as one command, suitable for cron. No LLM involved.

## What it does not do

- **Write back to GitLab.** Moving a card in Notion does not stick; the
  next run resets it, because the state is *derived* — from the workflow
  label or from GitLab's own status field, whichever `stage_source` names.
  That is the design, not a defect — a view that can drift is a second
  place to maintain.
- **Keep what you type into a synced page.** The table is a *view*: the
  page body of every row — bundle and issue alike — is rewritten on each
  run. Notes belong in a Notion **comment**, which the tool never touches,
  or in the GitLab issue, where everyone reading the source sees them.
- **Support labels or parent issues as bundles.** A label lets one issue
  sit in several bundles, which breaks any total, and carries no date.
- **Fill in missing data.** No configuration supplies due dates or
  progress. Where a project has neither epics nor milestones, the tool
  says so instead of drawing a board out of nothing.
- **Read group milestones.** Milestones are read per project. A project
  query reaches through to a *group* milestone of the same name and returns
  items from sibling projects as well — measured — so bundles would hold
  more items than they should. `roadmapper init` names this case when
  milestones are configured.
- **Set up your Notion views.** The tool fills one table. How that table
  is then read — a board grouped by state, a timeline on the due date, a
  filter hiding what has not moved in a fortnight — is arranged once in
  Notion by hand, and stays: a view survives every run, because the rows
  are updated rather than replaced. `roadmapper init` creates missing
  *columns*, never views.
- **Produce HTML.** Notion is the only target.

## Data protection, and how to check it

This is the section for whoever has to sign off on a tool before it
touches a tracker. It states properties rather than intentions, and each
one is verifiable from the source in a few minutes — an assurance you
cannot check is worth about as much as none.

**Where the data goes:** two places, both yours — your GitLab instance
and the Notion database you configured. Nothing else is contacted: no
telemetry, no update check, no third party in between.

**No personal data is read.** The GraphQL query asks for no assignee, no
author, no username, no email address and no avatar — not by filtering
them out afterwards, but by never selecting them, which is why
`src/core/` has no field that could hold one. A bundle carries a title, a
date, a state, counts and a URL; an item the same. Whoever is working on
something does not travel to Notion, because the question the board
answers is what is moving, not who is moving it.

What does travel is issue **titles and descriptions**, and a description
is free text somebody wrote — if your tracker puts customer names or
personal details into those fields, they reach the Notion page like any
other text. That is the one place to look before pointing this at a
workspace with a different audience than the tracker.

**No model sees your tickets.** This is a deterministic program: it reads
GraphQL, counts, and writes REST. Nothing is sent to an LLM, and no part
of the output is generated — which is also why a wrong board points at a
wrong label rather than at something that cannot be reproduced. The
decision behind it was about determinism under cron (ADR-0005); keeping
issue content out of a model is the consequence, and worth stating
plainly for anyone who has to answer that question before adopting a
tool.

It is checkable rather than promised: two runtime dependencies
(`@notionhq/client`, which declares no transitive dependencies of its
own, and a TOML parser), the URLs built in
[`src/source/gitlab/query.ts`](src/source/gitlab/query.ts) and
[`src/core/key.ts`](src/core/key.ts), and `api.notion.com` from the SDK.
Grepping for `https://` across `src/` finds all of them.

The tokens are read from the environment and never written to disk. The
tool stores nothing between runs either: no cache, no state file, no
database — every run asks GitLab again. The single file it ever writes is
the configuration `roadmapper init` copies from the example, and that one
holds no credentials by design.

### What it is allowed to do

Each side gets the narrowest thing that works, and the asymmetry is the
point:

- **GitLab: read-only.** The token needs scope `read_api` and nothing
  more. There is no mutation anywhere in the source stage — moving a card
  in Notion cannot write back, because there is no code that could.
- **Notion: one database.** An integration sees only what has been shared
  with it, so the write reaches the table you connected and nothing else
  in the workspace — and within that table, only the columns `[columns]`
  names.

That is a smaller grant than a person has. Anyone running this by hand is
signed in with their own account, which can reach every project they can
see and every page in the workspace; a scoped token is the same job with
most of the reach removed. It is also the difference between "I will not
touch that" and "I cannot".

### Why it can run again tomorrow

The run is idempotent: the key decides update-or-create, so running it
twice changes nothing the first run already did, and an interrupted run
is repaired by the next one rather than needing a cleanup. Nothing is
ever deleted — a row whose bundle disappeared from GitLab stays, because
the first wrong key would otherwise have cost data.

That is what makes it a cron job rather than a procedure. A board that is
refreshed by someone performing a sequence of steps is only as current as
the last time somebody had twenty minutes; one that runs at six every
morning is current because nobody has to remember it. The same property
is why a failed run is not a problem to untangle: run it again.

## Built with

TypeScript on Node ≥ 24. Two runtime dependencies: `@notionhq/client`
and a TOML parser.
GitLab is read over GraphQL, Notion written over REST — see
[docs/adr/](docs/adr/) for why.

## Requirements

- Node ≥ 24
- A GitLab token with scope `read_api`
- A Notion integration token, and the target database shared with it
- Epics need GitLab Premium; milestones work on any tier
- GitLab 17.3 or newer for epic progress — the rolled-up counts it rests
  on do not exist before that (ADR-0015). GitLab.com always qualifies.

## Getting started

    git clone https://github.com/muellerei/roadmapper.git
    cd roadmapper
    npm install
    npm run build
    npm link          # optional — puts `roadmapper` on your PATH

Then, in the directory you want to run from (without `npm link`, call
`node /path/to/roadmapper/dist/src/main.js` instead):

    export GITLAB_TOKEN=glpat-...     # GitLab → Settings → Access tokens, scope read_api
    export NOTION_TOKEN=ntn_...       # notion.so/profile/integrations

    roadmapper init                   # creates roadmapper.toml, then checks everything
    # edit roadmapper.toml
    roadmapper init                   # run it again — it checks, it does not guess
    roadmapper                        # the first sync

`roadmapper init` does most of the setup: it creates the configuration from
the example, checks both tokens, resolves the database, **creates the
columns you configured but the target does not carry**, and reports whether
the source returns bundles. It walks a fixed order and stops at the first
problem, because the later checks build on the earlier ones. It installs
nothing, changes no `PATH` and writes no cron entry.

### Tokens and `.env`

**No `.env` file is read.** The two tokens are looked up in the environment
of the process, and nowhere else — a file beside the command is not
searched for, at any depth. Cron is the case this tool is built for, and
cron has no working directory worth trusting: a credentials file found by
looking around is a lookup nobody can see.

Node reads one for you, if you want the file:

    node --env-file=.env /path/to/roadmapper/dist/src/main.js

That flag reaches the `node` binary, not the `roadmapper` shim `npm link`
puts on your `PATH`. To keep the short command, put the values into the
shell first:

    set -a; . ./.env; set +a       # exports every name the file sets
    roadmapper

Both are the same thing to the tool: by the time it starts, the tokens are
in the environment. Which of the two you use is a matter of taste — the
first keeps them to a single run, the second to a single shell.

### The database id

`[notion].database` takes the id, which is in the URL of the database
itself — open it as a full page and take the part after the workspace
name and before the `?`:

    https://www.notion.so/myspace/20c5f1e2ab1c80f7bd3ef1b2c3d4e5f6?v=...
                                  └──────────── the id ───────────┘

The id is passed to Notion as you write it — the tool neither reformats
it nor validates its shape, so copy it exactly. If the database sits
inside another page, open it full-page first (**Open as page** in its ···
menu): the URL of the surrounding page is a different id, and using it
produces the same "cannot see it" answer as a database that was never
shared.

### Sharing the database with the integration

An integration sees nothing until a database is shared with it — and an
unshared database answers exactly like a wrong id, which sends people
looking for the id instead:

> open the database in Notion → **···** → **Connections** → add your
> integration

If every row later fails to write, the integration can read but not write:
same path, then **Can edit**.

### The columns

`roadmapper init` creates missing ones with the right type. If you create
them by hand, these are the types it expects:

| `[columns]` key | Notion type | Holds |
|---|---|---|
| `key` | Text — or URL with `key_is = "url"` | the value a row is found by on the next run |
| `name` | Title | the bundle or issue title |
| `state` | Select or Status | the value from `[status]` |
| `progress` | **Number (Percent)** | the fraction, see below |
| `url` | URL | the link into GitLab |
| `due` | Date | the bundle's date, empty when GitLab has none |
| `type` | Select or Status | `Bundle` / `Item` — **without it, only bundles are written** |
| `activity` | Date | the newest change in the bundle |
| `health` | Select or Status | `ok` / `attention` / `risk` |

Only `key` and `name` are mandatory. Everything else falls out cleanly when
it is missing — which is what makes `health` usable: if nobody maintains
that field in GitLab, leave the column out and lose nothing.

**A column of the wrong type is left out, not written into.** If your
`Progress` column is a Text column — the shape the predecessor tool used,
where it wrote `"3/8 done"` — the run writes every other column, skips that
one, and names it in the report. It does not send a number into a text
field and let Notion reject every row halfway through.

**Each role needs a column of its own.** Two roles pointing at one column
name is rejected before the first request: a row can hold one value per
column, so the second role would silently overwrite the first — and if that
is the key, the next run no longer finds its own rows and creates them
again, every night.

**`progress` must be Number with Percent formatting.** The column takes the
fraction `0.4`, not `40`. Notion accepts both without complaint, and as a
plain number you see `0.63` where you expect `63 %` — measured, and the one
mistake here that looks like a bug in the tool.

### Not yet verified

The write path is covered by tests against a stubbed Notion client, and the
value shapes were confirmed against a real table (a percent column renders
`0.4` as 40 %, dates arrive as dates, select values are accepted). What has
**not** been exercised is a full run against a live workspace through an
integration token, and the self-throttling under real load.

## Configuration

Copy [`roadmapper.example.toml`](roadmapper.example.toml) to
`roadmapper.toml` and edit it. Tokens come from the environment
(`GITLAB_TOKEN`, `NOTION_TOKEN`), never from the file.

The configuration says *how* to read the source — which bundle kind, where
the work step comes from, which Notion column takes what. It never says
what is in the source.

### `--config <file>`

Both subcommands take it; without it, `roadmapper.toml` in the working
directory is used.

    roadmapper --config test.toml        # a rebuilt target schema
    roadmapper --config produktiv.toml   # the real target

**A relative path resolves against the working directory**, like any other
command-line tool. The tool does not resolve against its own location and
does not search parent directories: both would be a search nobody sees, and
with two similarly named targets that is the worst possible property.

**For cron, give an absolute path** — the case the parameter exists for is
also the case with the least obvious working directory:

    0 6 * * *  roadmapper --config /etc/roadmapper/produktiv.toml
    0 7 * * *  roadmapper --config /etc/roadmapper/test.toml

Which invocation creates a config, and which does not:

| | `roadmapper` | `roadmapper init` |
|---|---|---|
| `--config <file>` named, missing | abort, path in the message | **abort** — a named file is never created |
| no `--config`, `roadmapper.toml` missing | abort, points at `init` | creates it from the example and stops |

A file you named yourself is never created silently: whoever types
`--config produktiv.toml` with a typo wants an error, not an empty file
beside the real one.

## What a run tells you

Every run ends with a report, and it is the part worth reading. Each
decision this tool makes is defensible on its own — progress left empty
rather than guessed at, a date left empty rather than invented, a state
falling back to the default — and their *sum* can be an empty board while
no error fires at all. The report is what makes that visible:

    30 bundles, 210 items written.
      GitLab ID       30/30
      Feature         30/30
      Status           2/30    (from labels; 28x To do, 2x In progress)
      Progress        27/30
      Health           0/30    (field not maintained in GitLab)

    28 of 30 rows fell to "To do". Your [status] table maps "Flow".
    Found in source: Stage. Adjust [status], or drop the state column.

`Status 2/30` is the line to look at. A row that fell back to the default
carries a value, but that value means "nothing was found here" — counting
it as filled would show `30/30` on a board that says nothing. The
distribution beside it names what the rows actually hold.

Anything the run could not do goes to stderr, one paragraph each: a column
of the wrong type that was skipped, bundles whose progress GitLab could not
supply, item rows a target without a `type` column cannot take, a key the
target holds twice, a subgroup the token may not read.

**Exit codes are deliberately blunt.** Non-zero means *the run did not
happen* — a broken configuration, an unreadable target, or every single row
failing to write. It does not mean "something was ugly": one skipped row
among thirty keeps exit 0, and so does an empty result. The tool is built
for cron, and a failure mail every night trains its reader to ignore the
mails — including the one that reports a real abort.

## When to use something else

If you only want GitLab issues mirrored into a Notion table, use Notion's
own synced database, or a platform like Unito, n8n or Zapier. It is less
work and someone else maintains it. The same holds if you already run an
automation platform — one more connection there beats adopting a tool.

What those cannot do is the aggregation: a field mapping maps a field to a
field, and "63% of this epic is done" is a sum over a tree, not a field.
That is the one thing this tool is for.

## Contributing

The suite runs with no token and no network, and
[CONTRIBUTING.md](CONTRIBUTING.md) covers the three checks, where each
stage's code belongs and when a change needs an ADR.

## Licence

MIT — see [LICENSE](LICENSE).

---

Not affiliated with Notion or GitLab.
