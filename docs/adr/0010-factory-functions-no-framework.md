# Factory functions with explicit parameters, no framework, no classes

Every unit that holds dependencies is a factory function returning an
object of methods. Dependencies arrive as parameters. The public type is
derived with `ReturnType`, never written by hand. Composition happens in
one place — `src/main.ts` — and nothing resolves itself.

    export function createEpicSource(http: HttpFn, cfg: GitlabConfig) {
      return {
        async bundles(): Promise<Bundle[]> { … },
      }
    }

    export type EpicSource = ReturnType<typeof createEpicSource>

The same shape carries the Notion writer and anything else that needs a
token, a client or a rate limiter. Pure computation in `src/core/` needs
none of it and stays plain exported functions.

**State is closed over, never module-level.** No mutable value lives at
the top of a module, and nothing reads `process.env` deep in a call. The
throttle is the case that shows why: it remembers when the last request
finished, and as a module-level variable two targets in one run would
share a pace neither of them chose. Closed over by the factory, each
target gets its own — and a test can drive one without the other
noticing.

## Considered Options

**Classes with a DI container** were rejected. A container earns its cost
where a graph is deep enough that wiring it by hand is error-prone. This
program wires three things once. The container would be a dependency
whose only job is to hide four lines of `src/main.ts`, which reads
against "prefer no dependency".

**Ports and adapters** were rejected as ceremony without a payer. It
would make ADR-0003 explicit — the core declaring interfaces, GitLab and
Notion implementing them — but an interface pays off when several
implementations exist or when one is swapped at runtime. There are two
sources, fixed by ADR-0002, and one target. `ReturnType` already gives a
name to talk about, and it cannot drift from the implementation the way a
hand-written interface can.

**Free functions everywhere**, with configuration threaded through every
call, were rejected for the writer only. Throttling and the Notion client
are state that every call needs and no call owns; passing them as
arguments through each function is the parameter list a factory exists to
close over. Where there is no such state, free functions stay.

## Consequences

`src/core/` is testable by calling a function with invented data, and the
edges are testable by passing a stub `http` — no mock framework, no
module interception, nothing to configure. That is the same test story
ADR-0003 promises, now with a shape that delivers it.

The wiring is visible in one file and grows linearly. If it ever stops
being readable, that is the signal to reconsider — not a reason to hide
it behind a container.

What this shape deliberately leaves out are the parts that answer
problems this tool does not have: there is no database to hide behind a
repository, and no server to wire up in an `app.ts`. A factory that
closes over one `http` client is the whole of it.
