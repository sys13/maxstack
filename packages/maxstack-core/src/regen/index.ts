/**
 * `@maxstack/core/regen` — the per-project regeneration ledger.
 *
 * The platform half of "how is this project doing", next to `@maxstack/core/
 * review`'s human half. #201 answers what reviewing costs the maintainer; this
 * answers what a change costs the project, in files the platform has to redraw.
 *
 * Read `regen-log.ts`'s header before using any of it, in particular the part
 * about what this is **not**: it is not `weightPerSafeChange`, that metric needs
 * a replay harness and a ledger of attempted changes, and the whole reason this
 * module is small is that publishing the platform's figure on a maintainer's
 * project would be worse than publishing nothing.
 */

export * from './regen-log.ts'
