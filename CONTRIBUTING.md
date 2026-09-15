# Contributing

## Getting a working copy

```bash
git clone https://github.com/muellerei/roadmapper.git
cd roadmapper
npm install
npm run build
npm test
```

Node ≥ 24 is required (ADR-0012). Nothing else has to be installed, and
no token is needed to run the suite: every test drives a stub, so the
whole thing passes with no network and no GitLab or Notion account.

## The three checks

```bash
npm run typecheck          # tsc --noEmit
npm test                   # builds, then runs the suite
npm run check:boundaries   # the stage boundary, as a script
```

All three run in CI on every push and pull request, plus a job that walks
the path a new user takes — clone, install, build, `roadmapper init`.

`check:boundaries` is the one worth knowing about. ADR-0003 and ADR-0008
split the program into three stages and forbid each from using the
vocabulary of the others: no GitLab field name below the source stage, no
Notion term in the core. The script greps for exactly that, and the list
it greps for lives in the script and nowhere else. If it fails, the fix
is almost never to add a name to the list.

## Where things go

    src/source/gitlab/   reads GitLab, translates to bundles and items
    src/core/            counts and groups; no network, no vendor terms
    src/output/notion/   maps to columns and writes
    docs/adr/            the decisions, and why
    CONTEXT.md           the vocabulary

A change that crosses a stage boundary is usually a change that belongs
in a different stage.

## Tests

The suite is `node --test` against the compiled output; there is no test
framework dependency. Two habits are worth keeping:

**A test names what it covers.** Most carry an acceptance-criterion id
(`AK27`, `R3c`) in the title. A new test does not need one, but it does
need a title that says what breaks if it fails.

**A test must be able to fail.** Where a test covers a fix, remove the
fix and watch it go red before keeping it. Several tests in this suite
are counter-checks that exist because the obvious version of the same
test passed against broken code.

Fixtures are invented: hosts end in `.invalid`, namespaces start with
`acme/`, and a test asserts it. Never paste a real API response into
`test/fixtures/` — it carries project paths, ticket content and names.

## Decisions

Anything that changes what the tool *means* — not how it is spelled —
gets an ADR in `docs/adr/`, numbered in sequence. An ADR states its
decision and its reasoning in full, cites other ADRs by number, and never
cites working material (ADR-0013). A superseded one stays where it is,
with a note naming its successor.

If you are unsure whether something needs one: if the next person would
otherwise ask "why is this like this?", it does.

## Commits

The subject line follows Conventional Commits — `feat:`, `fix:`,
`docs:`, `test:`, `ci:`, `chore:`. The body is where the reasoning goes,
and it is worth writing: the changelog is assembled from what the commits
already explain.

## Reporting something

An issue that names the bundle kind (epics or milestones), the
`stage_source`, and what the closing report said is usually enough to
locate a problem. Please do not paste real ticket titles or URLs — a
shape (`acme/product&7`) says as much and keeps your tracker out of a
public repository.
