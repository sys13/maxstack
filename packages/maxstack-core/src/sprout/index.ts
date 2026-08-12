/**
 * Sprout — the maxstack kernel. Declare a Drizzle table enriched with
 * `withMeta`, register it, and derive validation, REST, and MCP tools from it.
 */

// NOTE: `./backend.ts` is deliberately NOT re-exported here. It statically
// imports the pglite + postgres.js drivers, so folding it into this barrel
// pulls those Node-only DB drivers into any *client* bundle that imports
// `@maxstack/core` (React Router route modules do), which breaks the
// production build (`postgres` → `performance` from a browser-externalized
// node builtin). Server code imports it from the `@maxstack/core/backend`
// subpath instead. The `StoreBackend` type still flows through `from-spec.ts`.
// `./coordination.ts` only *type*-imports `./backend.ts`, so it carries none of
// the driver weight the note above is about and belongs in the barrel.
export * from './actions.ts'
export * from './api.ts'
export * from './api-contract.ts'
export * from './constraints.ts'
export * from './coordination.ts'
export * from './derived.ts'
export * from './document-embed.ts'
export * from './document-fonts.ts'
export * from './document-html.ts'
export * from './document-pdf.ts'
export * from './document-truetype.ts'
export * from './documents.ts'
export * from './error-id.ts'
export * from './from-spec.ts'
export * from './import-parse.ts'
export * from './imports.ts'
export * from './introspection.ts'
export * from './live.ts'
export * from './mcp.ts'
export * from './operations.ts'
export * from './page-contract.ts'
export * from './permissions.ts'
export * from './portals.ts'
export * from './query.ts'
export * from './references.ts'
export * from './registry.ts'
export * from './schema-builder.ts'
export * from './search.ts'
export * from './store.ts'
export * from './types.ts'
export * from './validation.ts'
