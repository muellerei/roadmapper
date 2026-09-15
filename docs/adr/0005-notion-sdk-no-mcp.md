# Notion over REST via the official SDK, not over MCP

An MCP server is a toolbox for an agent: it needs a model talking to it,
gives text to interpret, and is not deterministic. This tool runs as one
command in cron, so it uses Notion's REST API through `@notionhq/client`.

## Considered Options

Writing raw HTTP was considered and rejected. Notion moved to a
data-source model in API version `2025-09-03` — a database is now a
container, and pages are created against a `data_source_id`. Hand-written
HTTP against a model that just shifted is more risk than a dependency.
The SDK (5.26.0, released 2026-08-20) carries **no transitive
dependencies**, verified via `npm view`.

GitLab gets no SDK: GraphQL is one request and `fetch` is built in.

## A consequence worth naming

Issue content never reaches a model. That was not the reason — the reason
was determinism under cron — but it is the property people ask about
first when a tool touches their tickets, and a decision taken for one
reason can be worth stating for another.

It also holds in the other direction: because nothing is generated, a
board that looks wrong is wrong *reproducibly*. The labels can be read,
the count recomputed, the same run repeated to the same result. A tool
that summarised a tree with a model would lose that, and the loss would
show up exactly where it costs most — in the column management reads.

## Consequences

Exactly one runtime dependency. The SDK declares `engines.node >= 18`,
but the tool requires Node ≥ 24 for reasons of its own — 18 and 20 are
both end-of-life (ADR-0012). Notion allows roughly 3 requests per second;
the tool throttles itself rather than exposing a setting nobody can set
correctly.
