/**
 * A `PlatformContext` for **listing** the platform tools without being able to run
 * any of them.
 *
 * Two generators need this and they must agree: `gen-reference-docs.ts` renders
 * `docs/mcp-reference.md` from the tool list, and `gen-published-stats.ts`
 * publishes its length (the site claimed "the eight platform tools" against a
 * generated reference that said ten). Two hand-rolled contexts
 * would let those two counts diverge, which is the exact class of defect both
 * generators exist to close, so there is one.
 *
 * # It is the most capable host, not a typical one
 *
 * This used to mirror what `maxstack mcp` happens to register, with **no optional
 * providers wired**. Three tools are gated on those providers — `ownership_drift`,
 * `review_cost`, `browse_catalog` — so all three were silently absent from the
 * generated reference, and the validate gate drift-checked that absence as
 * correct. The result read as verified documentation of the whole vocabulary while
 * missing a third of it, and an agent reading it to discover what exists could not
 * learn those tools were there at all.
 *
 * So every provider is stubbed. The point of the reference is that the vocabulary
 * is self-describing; a fixture host less capable than every real host
 * produces a reference that understates the platform. Which tools need what is not
 * hidden — `renderMcpReference` annotates them from `HOST_GATED_TOOLS`, because "a
 * tool that exists only in some hosts" is a documentation fact, not a reason to
 * omit it.
 *
 * The stubs throw. Nothing here may run: the doc generator lists, it does not call,
 * and a stub that returned plausible data would let a generator quietly start
 * depending on values no real host supplied.
 */

import {
	createGeneratorRegistry,
	defaultCheckRunner,
	docsGenerator,
	e2eTestsGenerator,
	type PlatformContext,
	type RegisteredGenerator,
} from '@maxstack/mcp'

/** A context that mirrors what `maxstack mcp` registers, for tool-listing only. */
export function docContext(): PlatformContext {
	const diskPageGenerator: RegisteredGenerator = {
		name: 'page',
		summary:
			'Emit route/slot/manifest code for the spec pages, landing them in app/ (never-clobber).',
		run: () => {
			throw new Error('doc-only context — generators are never run here')
		},
	}
	const unreachable = (what: string) => (): never => {
		throw new Error(`doc-only context — ${what} is never called here`)
	}
	return {
		spec: undefined as never, // only `generators`/`checks` are read by platformTools
		generators: createGeneratorRegistry([
			diskPageGenerator,
			docsGenerator,
			e2eTestsGenerator,
		]),
		checks: defaultCheckRunner(),
		origin: 'ai',
		now: () => '1970-01-01' as never,
		nextOpId: () => 'op-doc' as never,
		// The three host-gated providers, present so their tools are documented.
		// See the module note: absent here meant absent from the reference.
		ownership: { drift: unreachable('ownership.drift') },
		reviewCost: { report: unreachable('reviewCost.report') },
		catalog: {
			list: unreachable('catalog.list'),
			preview: unreachable('catalog.preview'),
		},
	}
}
