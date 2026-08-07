# Write paths — change attribution and how it is enforced


The load-bearing sentence of this platform's positioning is that **the maintainer
stays in charge of every change**. This document is the mechanical version of
that sentence: what it actually promises, what it deliberately does *not*
promise, and the two gates that stop it quietly becoming false.

## The promise, stated so it can be tested

> **No write path may land a change without recorded attribution, and only a
> review may settle a review.**

Four properties, and each one has tests that would fail if it broke:

| # | property | where |
| --- | --- | --- |
| a | every landed op records who landed it — author *kind* (`origin`) and *which* author (`actor`) | every `write-path.invariant.test.ts` |
| b | a validate or a preview never mutates the spec it was handed, however deep inside it an `applyOp` lives | `validate-op-dry-run`, `bundle-install-preflight`, `web-diff-preview` |
| c | only `provenance.review` moves an existing row from undecided to accepted | `packages/spec/src/base/write-path.invariant.test.ts` |
| d | regeneration never deletes manual items | `packages/maxstack-core` ownership suite, plus the property test |

## What this does NOT promise, and why

It does **not** promise that an agent's applied op waits for a human before it
grounds. That is settled:
generation grounds on accepted rows, so a row that lands undecided is invisible
to the running app — and an agent whose work never appears is an agent that does
not work. `apply_spec_change` therefore lands rows accepted with AI provenance,
and `propose_spec_change` is the write-free suggest half.

**Review here is a record, not a gate.** The maintainer stays in charge because
every change is attributable, visible in the workbench, and revertible — not
because every change is blocked pending approval. A blocking review would either
be bypassed within a week or would stop the agent loop working at all, and either
outcome destroys the thing it was meant to protect.

That distinction is worth being precise about in copy, too: "you stay in charge
of every change" is honest; "nothing happens until you approve it" is not.

## The attribution record

`origin` answers *what kind* of author landed an op — `'ai'` or `'human'`. It has
carried the whole provenance story since day one, and one bit turned out not to be
enough to review with: two entries both stamped `'ai'` may be a coding agent in a
session the maintainer was watching, and a scheduled job holding a long-lived API
key. A reviewer treats those completely differently.

So `origin` keeps its meaning and an `OpActor`
(`packages/spec/src/base/actor.ts`) rides alongside it:

```ts
interface OpActor {
  surface: 'mcp' | 'cli' | 'web' | 'bundle' | 'codemod' | 'harness'
  agent?: string    // the tool that named itself — 'claude-code'
  session?: string  // groups one invocation's ops as one piece of work
  keyId?: string // the api-key row id — never the secret
  path?: string     // the write-path registry id that landed it
}
```

Four rules this follows, all of which have bitten before:

- **`surface` belongs to the host, never to the code that lands the op.** A tool
  cannot know what carried the request to it. `apply_spec_change` used to stamp
  `surface: 'mcp'` on the reasoning that an MCP tool is self-evidently reached
  over MCP — but `executePlatformTool` is an ordinary function, and the
  workbench's Land button calls it in process from an HTTP form post. So a
  maintainer clicking a button recorded `{origin: 'ai', surface: 'mcp'}`: an
  agent write that never happened, in the record this whole document exists to
  make trustworthy. `PlatformContext.origin` and `PlatformContext.surface` are
  therefore both required and both supplied per request, and a host that reuses
  a tool in process names its own declared path via `writePath`.
- **`surface` is not `origin`.** A human runs the CLI and so does an agent
  (where the verbs
  hardcoded `'human'` and an agent shelling out to `maxstack add-entity` logged
  its own work as hand-authored). Transport and author are independent facts.
- **Absent beats invented.** Only `surface` is required. A host that cannot
  identify the caller records nothing, because a placeholder in a provenance
  record reads as an answer.
- **No people.** Every field identifies a machine or a surface. A human author is
  `origin: 'human'` plus the surface they used, and that is all — the spec is a
  file in the maintainer's own repo, not a keystroke log.

`ApplyMeta.actor` is **required**, so a new write path cannot forget it: the
typechecker refuses the call. `AppliedOp.actor` is **optional**, because an entry
decoded from a `spec.json` written before write paths were recorded genuinely has none, and
synthesizing one would put a fabricated record in an audit trail.

## The registry, and why silence is a failure

The thing most likely to break the promise is not a bad decision — it is a *new
write path nobody thought about*. L1 adds bundles and L2 adds op families, each
with its own install path, and every one of them is a new way to reach `applyOp`.

`scripts/write-paths.config.json` declares every one of them.
`scripts/check-write-paths.mjs` enforces five rules:

1. every `applyOp(` call site in the workspace is named by some entry's `site` or
   `via` — **an undeclared write path fails the build**;
2. no stale entries: a declared path must still exist and still reach `applyOp`;
3. every declared `surface` is one of `OP_SURFACES`, read out of `actor.ts` by
   regex rather than duplicated here;
4. every path's `coveredBy` test exists **and mentions the path's id** — a
   declaration pointing at a test that never names it is an uncovered path wearing
   a covered path's clothes;
5. ids are unique, no `preflight` claims `canAccept`, and **every path that may
   settle a review carries a written `acceptRationale`** — see below.

`site` is where the path *is* — the command, loader or installer a reviewer would
go read. `via` names the shared file that calls `applyOp` on its behalf, because
five CLI verbs share `lib/land.ts` and the workbench form applies through
`view-model.ts`. Both facts stay true without either being fudged.

## Adding a write path

1. Land your `applyOp` call. It will not compile without an `actor`.
2. Add an entry to `scripts/write-paths.config.json` — `id`, `surface`, `site`
   (+ `via` if it applies elsewhere), `kind`, `authorKind`, `grounds`,
   `canAccept`, `coveredBy`, `why`.
3. Stamp `actor.path` with your `id`, so a landed op points back at its
   declaration.
4. Assert the invariants in the `coveredBy` suite, naming the id. At minimum:
   it attributes, and it does not settle a review it does not own.
5. `pnpm check:write-paths`.

If the path is a **preflight** — a validate or a preview that applies to a clone
it discards — say so with `kind: "preflight"` and assert the input spec is
byte-identical afterwards. That property is invisible in the type system (both
return a `SpecSystem`), so it is asserted or it is nowhere.

## Where it runs

- `pnpm validate` → the `write-paths` step (milliseconds; catches it before push).
- CI `ownership-safety` → the registry check, then every surface's invariant suite
  by name. Same job as never-clobber, because they are the same class of promise:
  what the maintainer owns is not taken from them, and what anything else changes
  is recorded against whoever changed it.

## Who may settle a review

Flipping `isAccepted` from `null` to `true` **is** the review step, so a path
claiming that power is the most consequential declaration in the registry.

The rule is that any such path carries a written `acceptRationale` saying why it is
entitled to settle a decision on a human's behalf. That sentence lands in the diff,
where somebody can disagree with it, and the checker **prints the whole set on every
successful run** — because the shortest and most important list in the project is
also the one that grows if nobody ever looks at it.

This replaced an earlier cap of "at most two such paths", which was the wrong
shape: `> 2` is satisfiable by a two-character diff, which is exactly the *config
edit* its own error message warned against. A required justification is not.

Three paths qualify today: the workbench form (a person clicking a button about one
named row), the CLI's `--accept` (the author clearing their own change, recording
the *same actor* on both entries so the trail cannot read as a second party having
looked at it), and bulk review (entitled to it only because it *cannot* clear a
high-risk proposal — see [`bulk-review.md`](bulk-review.md)).

## The current paths

24 declared: 20 write, 4 preflight, across 6 surfaces. See the registry file itself
for the full list with rationale — it is the source of truth and it is commented.
