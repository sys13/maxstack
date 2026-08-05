/**
 * @maxstack/spec — the source of truth every other layer derives from.
 *
 * Two halves. `prd/` is the typed, runtime-validated product spec: what the app
 * is for, who it serves, what it must do. `base/` is the spine underneath it —
 * provenance columns every layer carries, the append-only decision ledger, and
 * the typed spec-op vocabulary — keyed by branded cross-references so a page
 * cannot name an entity that does not exist, and composed into one validated
 * `SpecSystem`.
 *
 * Nothing here reaches for a database, a filesystem or a clock. That is what
 * makes a spec something you can diff, validate and reason about before any of
 * it becomes an app.
 */

export const SPEC_PACKAGE = '@maxstack/spec' as const

export * from './base/index.ts'
export * from './prd/index.ts'
