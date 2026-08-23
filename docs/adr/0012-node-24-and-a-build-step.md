# Node 24 and a compiled build, not the runtime's type stripping

The tool requires Node ≥ 24 and ships compiled JavaScript built by `tsc`.
It does not rely on Node's native TypeScript execution, although Node 24
supports it.

## Why not Node 18

ADR-0005 set the floor at 18 "because the SDK requires it". That reasoning
no longer holds: Node 18 reached end-of-life on 2025-04-30 and Node 20 on
2026-04-30. A tool published in 2026 cannot ask for a runtime that stopped
receiving security fixes. `@notionhq/client` still declares `>=18`, but a
dependency's floor is not a reason to inherit a dead runtime.

Node 24 is Active LTS until 2028-04-30. Node 22 is in maintenance and ends
in April 2027 — a year of headroom is not enough for something meant to sit
in a crontab and be left alone.

## Why a build, when Node 24 runs TypeScript directly

Node strips types; it does not check them. Without a compile step,
TypeScript here would be a comment language, and this codebase derives its
public types instead of writing them (ADR-0010, `ReturnType`). An
unchecked type graph is the wrong foundation for that. Running
`tsc --noEmit` instead would cost the same step and throw the result away.

The decisive reason is the Notion SDK's module shape. Version 5.26.0 is
CommonJS with no `exports` field, and its `main` points at a directory
(`./build/src`) rather than a file — directory resolution is a CommonJS
legacy mechanism. Reaching such a package from ESM depends on Node's
interop heuristics, and named imports are not dependable there. `tsc` with
`module: nodenext` settles this at compile time. For a program that runs
unattended, an error at build time is worth more than a correct guess at
runtime.

Shipping compiled JavaScript also keeps the published package independent
of how type stripping evolves.

## Consequences

A build step sits between editing and testing. `tsc --watch` with
`node --test` against `dist/` absorbs most of that cost.

The build lifts the syntax restrictions type stripping imposes — `enum`,
parameter properties and `tsconfig` path aliases would all be available
again. They stay unused, but by choice rather than by constraint.

Modules are ESM (`"type": "module"`); the SDK is reached through a default
import.

Supersedes the Node floor stated in ADR-0005, not its subject: that
decision is about using the SDK rather than MCP, and it stands.
