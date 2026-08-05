/**
 * The Phase 0 demo fixture (task + author) as a reusable subpath export.
 * Consumed by the core e2e tests and by `apps/web` as its seed schema — the
 * "one demo table end-to-end" of the Phase 0 exit criteria. A real project
 * swaps this for its own `sprout.config` + Postgres store.
 */

export * from './schema.ts'
export * from './store.ts'
