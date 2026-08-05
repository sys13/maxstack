# AGENTS.md — working agreement for this repo

This is the standing instruction set for any agent (or human) working in the
maxstack repo. It is deliberately short. If you are *using* maxstack rather than
contributing to it, you want [`docs/quickstart.md`](docs/quickstart.md) instead.

## The validate gate

Nothing lands unless `pnpm validate` is green. It runs lint, the boundary and
correctness checks, typecheck and the test suite. `pnpm validate --fix`
auto-fixes formatting and lint first.

Individual checks are also available on their own (`pnpm check:boundaries`,
`check:write-paths`, `check:guarded-statements`, `check:client-safe-imports`,
`check:test-integrity`) — each costs milliseconds and each exists because a
specific silent bug shipped. [`CONTRIBUTING.md`](CONTRIBUTING.md) says which.

## Test integrity (anti-tampering)

Never make a gate pass by weakening it: do not delete, skip or loosen a failing
test, do not add drive-by lint or type suppressions, and do not relax validate
or a CI step inside a feature change. If a test or gate is genuinely wrong, it
changes in **its own commit, with the reasoning** — not as a side effect of
making something else green.

This is enforced, not just asserted: `pnpm check:test-integrity` fails the build
on a skipped test, a focused test, a swallowed exit code, a non-failing CI step,
a typechecker suppression, or a rise in the lint-suppression count. Violations
are treated as broken builds — revert first, discuss after.

## Invariants that never bend

- **Regeneration never deletes manual items** (`isAddedManually`).
- **Generation grounds only on accepted items** (`isAccepted`).
- **Eject never clobbers** — copies-with-banner, skips existing.
- **Regeneration safety is 100%**, not a target — the change does not land
  otherwise.

## Conventions

- Formatting and linting: Biome (tabs, single quotes, no semicolons, trailing
  commas). Config in `biome.jsonc`.
- Packages export TypeScript source (`./src/index.ts`) — the internal-packages
  pattern, so no build step is needed for cross-package typecheck.
- TypeScript is `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.
- Commit subjects follow Conventional Commits. This is load-bearing:
  `CHANGELOG.md` is generated from them.

## Architecture

The layer map and what may import what is in
[`ARCHITECTURE.md`](ARCHITECTURE.md). The import rules are machine-enforced by
`scripts/check-boundaries.mjs` against `scripts/boundaries.config.json`, so a
violation fails the gate rather than relying on you having read this.

## Where design rationale lives

In the code, next to the thing it explains. A comment that says *why* a check
exists — and what breaks without it — is worth more than a document that has to
be found. When you fix a subtle bug, leave the explanation at the site.

Decisions that shape user-visible product behaviour belong in
[`ARCHITECTURE.md`](ARCHITECTURE.md) as prose, so a reader meets them where
they matter.
