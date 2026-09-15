# Changelog

All notable changes to `roadmapper` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- ADR-0013 forbids a published document from citing working material, and
  `docs/architecture.md` was doing it. Its table *Where the rules are
  written down* listed an ADR for every boundary but one, which named
  `R3c (spec)` — a marker into a specification that lives outside the
  repository. The column promises a place to read the rule; for that one
  row it pointed at a file nobody who clones this can open.

  The rule itself was never in doubt: the state is derived one child level
  deep and the run names the bundles that nest deeper. What was missing is
  *why*, which is now ADR-0024 — the cost of descending further, why the
  limit is reported rather than left silent, and the two alternatives that
  were rejected. Same for `src/core/state.ts` and `src/core/types.ts`,
  which carried the marker in their doc comments.

  This is the defect ADR-0013 was written about, found in the document
  that records it. The citations that remain are the harmless kind: prose
  that states its reasoning in full and appends the marker, rather than
  outsourcing the argument to a pointer.

- `scripts/check-boundaries.sh` told a failing contributor to "See
  ADR-0003, ADR-0008 and `.claude/rules/boundaries.md`". The first two are
  in the repository; the third is agent working material, excluded by
  `.gitignore`. The message now names `docs/architecture.md`, which
  carries the stage vocabulary the check enforces.

  `src/output/notion/throttle.ts` cited the same file for "no module-level
  state" — without a path, so the reference did not even reveal where it
  was meant to lead. That claim was in no published document at all. It is
  now stated in ADR-0010, with the throttle as the case that shows why it
  matters: as a module-level variable, two targets in one run would share
  a pace neither of them chose.

### Changed

- ADR-0010 explained the factory shape partly by pointing at another
  codebase, one that is not in this repository and that a reader has no
  way to look at. The comparison therefore carried no information for
  anyone but its author, while reading as though part of the reasoning
  lived elsewhere. It does not: what this shape leaves out are the parts
  answering problems this tool does not have, a database behind a
  repository and a server to wire up. That argument stands on its own.

- `src/main.ts` told the reader that credentials never come from
  `local/` — a directory in the author's working copy that no clone of
  this repository contains. The comment now states the rule itself:
  credentials come from the environment, nothing beside the command is
  searched for, and cron has no working directory worth trusting.

### Added

- The README says where the data goes and where it does not. Two
  endpoints — your GitLab instance and your Notion database — and no
  model in between: this is a deterministic program, and no issue content
  is sent anywhere else. The section gives the means to check that rather
  than asking anyone to believe it, since the URLs are greppable and the
  dependency tree is two packages deep.

  ADR-0005 rejected MCP for determinism under cron. Keeping issue content
  away from a model follows from that decision rather than motivating it,
  which is why it had never been written down — it is now, together with
  the half nobody names: because nothing is generated, a board that looks
  wrong is wrong reproducibly.

- Every example label was renamed to an invented scheme. The old ones
  reproduced a real group's label vocabulary verbatim — the values, the
  prefix, and a second prefix beside it — because they were written from
  what was in front of the author rather than made up. Nothing about them
  identified anyone, but example data in a public repository should be
  invented on purpose, the way the fixtures already are.

  ADR-0017 keeps its measurement and loses the label names: what it
  records is that a status field read 100 % default while the labels held
  three different steps, and that holds without naming them.

- The data section is now titled for the person who needs it — whoever
  signs a tool off before it touches a tracker — and says what it had
  never stated: the GraphQL query selects no assignee, author, username,
  email or avatar, so `src/core/` has no field that could carry one. The
  board answers what is moving, not who. Issue titles and descriptions do
  travel, and that is said in the same breath rather than left for
  somebody to discover.

- The README says who the tool is for. It explained the problem and the
  design at length and never named a situation, so a reader had to work
  out from the feature list whether they were the intended audience.
  Three concrete ones now stand after *Why*, along with the case it is
  explicitly wrong for — planning in Notion and having GitLab follow —
  and the observation that structure decides rather than team size: a
  tracker with no epics and no milestones has nothing to aggregate.

  The choice between the two bundle kinds is now a decision rather than a
  requirement buried in a list. Milestones need no paid tier and keep
  progress, state, activity and dates; what they cannot do is nest, and
  GitLab carries no health status for them.

- The README says what the tool is allowed to do, and why it can run
  again tomorrow. Both properties existed and neither was stated where a
  reader decides: the GitLab side is read-only because no mutation exists
  in the source stage, the Notion side reaches one shared database and
  the columns `[columns]` names — a narrower grant than the account of
  whoever would otherwise do it by hand. Idempotence was recorded only in
  `docs/architecture.md`, although it is what makes this a cron job
  rather than a procedure somebody has to remember.

- The README says that Notion views are set up by hand. ADR-0016 already
  assumed one ("whoever wants the judgement makes it in the view"), and
  nothing said who creates it — the tool fills a table and creates missing
  columns, never views. A reader was left to find that out by looking.

- CI runs the suite and typecheck on Node 24 and 26, the boundary check
  of ADR-0003 and ADR-0008, and the path a stranger takes — clone,
  install, build, `roadmapper init` twice. `engines: >=24` had never been
  exercised above its lower bound, and the boundary script hung in no
  hook, so nothing ran it.

## [0.1.0] - 2026-08-28

The state the repository was published in. Never tagged and never
released as a package — `package.json` carried this number, and the two
commits below are what it stands for. Not verified against a live Notion
workspace; see *Not yet verified* in the README for what that leaves open.

### Added

- Read GitLab **epics** or **milestones** over GraphQL as bundles of
  issues, and write bundles and their items into one Notion database.
- Progress counted from the issue tree at any depth, taken from GitLab's
  rolled-up counts rather than a recursive query (ADR-0015).
- State derived from either scoped labels or GitLab's status field,
  whichever `stage_source` names; exactly one wins (ADR-0017).
- Activity dates, health roll-up, and a configurable column mapping in
  which each role owns a column of its own.
- `roadmapper init`: creates the configuration from the example, checks
  both tokens, resolves the database, creates configured columns the
  target lacks, and reports whether the source returns bundles. It stops
  at the first problem, because the later checks build on the earlier ones.
- A closing report that distinguishes a filled value from one that fell
  back to a default, so a board that says nothing cannot read as complete.
- Notion schema precheck: a column of the wrong type is skipped and named
  in the report rather than failing the run halfway through (ADR-0021).
- Self-throttling at ~3 requests/second with `Retry-After` and jittered
  backoff, never configurable (ADR-0005).
- 24 architecture decision records, `docs/architecture.md` for the stage
  boundaries, and `CONTEXT.md` for the vocabulary.
- `scripts/check-boundaries.sh`, which makes the stage boundary of
  ADR-0003 and ADR-0008 runnable rather than merely written down.

[Unreleased]: https://github.com/muellerei/roadmapper/compare/308a906...HEAD
[0.1.0]: https://github.com/muellerei/roadmapper/commit/308a906
