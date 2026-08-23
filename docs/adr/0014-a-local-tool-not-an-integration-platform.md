# A local command, not an integration platform

Zapier, n8n, Make and Unito all connect GitLab to Notion, and any of them
can be running in an afternoon. This tool exists anyway.

## The line that decides it

An integration platform maps a field to a field. That is what it is for,
and it does it well: issue title becomes page title, state becomes select
value, assignee becomes person.

"63% of this epic is done" is not a field. It is a sum over a tree — count
the issues below an epic, including those under nested epics, closed
against total (ADR-0007). No field mapping can express that, however good
the mapping is, because there is no source field to map from.

That is the whole argument. Everything else below is a consequence of
running locally, and would not on its own justify writing anything.

## Consequences

The configuration is a file. It can be read without logging in anywhere,
copied, versioned, and reviewed. A mapping clicked together in someone
else's web interface exists only there, is tied to an account, and is
usually understood only by whoever created it.

The schedule belongs to whoever runs it. Cron at four in the morning, or
once a week, or on demand — not "every fifteen minutes" because that is
what a plan allows.

The data path is direct. Tokens stay in the environment of the machine
that runs the command; issue titles and descriptions go from GitLab to
Notion without a third party in between.

The version is pinned. A lockfile decides what runs tomorrow, not someone
else's release.

## When a platform is the better answer

Someone who only wants issues mirrored into Notion should use Notion's own
synced database or one of the platforms above — it is less work and it is
maintained by someone else. The same is true for anyone already running an
automation platform: one more connection there costs less than adopting
another tool.

This tool earns its place only where the aggregation is the point.
