/**
 * @maxstack/core — L2 runtime.
 *
 * The kernel is Sprout: declare a Drizzle table enriched with `withMeta`,
 * register it, and derive validation, REST, and MCP tools from it (§3-L2).
 * Runtime route composition, the template registry, and DI land in later
 * phases (maxproject/max is the architectural reference).
 */

export const CORE_PACKAGE = '@maxstack/core' as const

// Ownership (the never-clobber writer, manifest, regen suite) is server-only —
// it drags in ts-morph + node fs, which must never reach a browser graph. It
// lives behind the '@maxstack/core/ownership' subpath instead of this index.
export * from './sprout/index.ts'
