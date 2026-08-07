/**
 * @maxstack/mcp — L3 MCP platform tools.
 *
 * Extends the Sprout-generated RBAC-gated per-resource CRUD tools
 * (@maxstack/core) with the **platform tools** (§3-L3): query_spec,
 * propose_spec_change, apply_spec_change, run_generator, run_checks,
 * explain_feature, list_acceptance_criteria, record_decision.
 *
 * The tools run against a {@link PlatformContext} (spec store + generator runner
 * + check runner) so the same code serves an in-memory spec in tests and a real
 * project on disk in the CLI / web server. See {@link platformTools} /
 * {@link executePlatformTool}; the JSON-RPC server merges these with Sprout's.
 */

export const MCP_PACKAGE = '@maxstack/mcp' as const

export * from './args.ts'
export * from './attention.ts'
export * from './blast-radius.ts'
export * from './checks.ts'
export * from './context.ts'
export * from './errors.ts'
export * from './generators.ts'
export * from './grounding.ts'
export * from './jsonrpc.ts'
export * from './ownership.ts'
export * from './shell.ts'
export * from './slots.ts'
export * from './spec-store.ts'
export * from './steering.ts'
export * from './tools.ts'
