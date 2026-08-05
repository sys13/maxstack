/**
 * The web host's inputs for the ordered what-needs-you report.
 *
 * The ordering itself is `attentionReport` in `@maxstack/mcp` — the same fold
 * `maxstack review` and the `workbench` MCP tool run. This file only supplies
 * the disk facts the shared model cannot see, which is the whole reason three
 * surfaces can agree about what matters most.
 *
 * **This loader must not mutate anything.** #198 states that as a gating
 * requirement and it is easy to violate by accident on this surface: the pane
 * next door records a telemetry event on load, and the hypothetical accept below
 * applies ops. The projection is in-memory and never handed to `spec.save`, and
 * nothing here records an event — see `loadWorkbenchAttention`.
 */

import {
	type AttentionInputs,
	type AttentionReport,
	attentionReport,
	type BlastRadius,
	blastRadius,
	type DerivedSurface,
	deriveSurfaces,
	latentExposure,
	specIfAllAccepted,
} from '@maxstack/mcp'
import type { SpecSystem } from '@maxstack/spec'
import { getPlatform } from '~/sprout.server'
import { ownershipContext } from './bulk-review.server'

/**
 * Gather what this host can see.
 *
 * Each fact in its own `try`: a failing drift read must not cost the reviewer the
 * upgrade list, and whatever is missing comes back absent so the shared model can
 * name it as unevaluated. An absent category and an empty one look identical on
 * screen and mean opposite things, which is why this never substitutes `[]`.
 */
export async function attentionInputs(
	spec: SpecSystem,
): Promise<AttentionInputs> {
	const inputs: AttentionInputs = {
		risk: await ownershipContext(spec),
	}
	try {
		const { loadOwnershipDrift } = await import('./drift.server')
		const report = await loadOwnershipDrift()
		inputs.drift = report.owned.map((owned) => ({
			id: owned.id,
			file: owned.file,
			drifted: owned.status === 'drifted',
		}))
	} catch {
		// Left absent — see the docblock.
	}
	try {
		const { describeCatalog } = await import('@maxstack/features/bundle')
		const { installedBundleRecords } = await import('~/sprout.server')
		inputs.upgrades = describeCatalog(await installedBundleRecords()).flatMap(
			(m) =>
				m.installed?.upgradeTo
					? [
							{
								slug: m.slug,
								from: m.installed.version,
								to: m.installed.upgradeTo,
							},
						]
					: [],
		)
	} catch {
		// Left absent.
	}
	return inputs
}

export interface AttentionView {
	report: AttentionReport
	/** What accepting everything pending would do to the built application. */
	radius: BlastRadius
	/** Every field the internet can reach right now. */
	exposed: DerivedSurface[]
	/** Declared-but-not-live portals — one op from `exposed`. */
	latent: ReturnType<typeof latentExposure>
}

/**
 * Everything the top of the workbench renders.
 *
 * Read-only by construction: `specIfAllAccepted` builds its projection in memory
 * and this function never calls `spec.save`, so opening the page cannot settle a
 * review. That is asserted rather than promised — see the loader test.
 */
export async function loadWorkbenchAttention(): Promise<AttentionView> {
	const spec = await getPlatform().spec.load()
	const inputs = await attentionInputs(spec)
	const ifAccepted = specIfAllAccepted(spec, inputs.risk ?? {})
	return {
		report: attentionReport(spec, { ...inputs, ifAccepted }),
		radius: blastRadius(spec, ifAccepted),
		exposed: deriveSurfaces(spec).filter(
			(s) => s.kind === 'public-field' || s.kind === 'public-write',
		),
		latent: latentExposure(spec),
	}
}
