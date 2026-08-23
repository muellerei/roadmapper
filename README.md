# roadmapper

Derive a Notion roadmap from GitLab epics and milestones. One way: GitLab
stays the source of truth, Notion is the view.

> **Status: design. No code yet.** See [docs/adr/](docs/adr/) for the
> decisions and why they were made, [docs/architecture.md](docs/architecture.md)
> for the boundaries between the three stages, and
> [CONTEXT.md](CONTEXT.md) for the vocabulary.

- One command, no daemon, no queue. Suitable for cron.
- Runs where you put it, on the schedule you choose.
- Configuration is a file you can read, copy and version.
- Two runtime dependencies. No LLM involved.

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

## What it does

- Reads **epics** or **milestones** from GitLab as bundles of issues
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
  next run resets it, because the state comes from the label. That is the
  design, not a defect — a view that can drift is a second place to
  maintain.
- **Keep what you type into a synced page.** The table is a *view*: the
  page body of every row — bundle and issue alike — is rewritten on each
  run. Notes belong in a Notion **comment**, which the tool never touches,
  or in the GitLab issue, where everyone reading the source sees them.
- **Support labels or parent issues as bundles.** A label lets one issue
  sit in several bundles, which breaks any total, and carries no date.
- **Fill in missing data.** No configuration supplies due dates or
  progress. Where a project has neither epics nor milestones, the tool
  says so instead of drawing a board out of nothing.
- **Produce HTML.** Notion is the only target.

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

## Configuration

Copy [`roadmapper.example.toml`](roadmapper.example.toml) to
`roadmapper.toml` and edit it. Tokens come from the environment
(`GITLAB_TOKEN`, `NOTION_TOKEN`), never from the file.

The configuration says *how* to read the source — which bundle kind,
which labels map to which state, which Notion column takes what. It never
says what is in the source.

## When to use something else

If you only want GitLab issues mirrored into a Notion table, use Notion's
own synced database, or a platform like Unito, n8n or Zapier. It is less
work and someone else maintains it. The same holds if you already run an
automation platform — one more connection there beats adopting a tool.

What those cannot do is the aggregation: a field mapping maps a field to a
field, and "63% of this epic is done" is a sum over a tree, not a field.
That is the one thing this tool is for.

## Licence

MIT — see [LICENSE](LICENSE).

---

Not affiliated with Notion or GitLab.
