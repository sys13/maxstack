/**
 * Determinism with a flagged surface (gating requirement 1).
 *
 * The requirement: *"a flag that gates a derived surface must not break
 * determinism. Generation output cannot depend on flag values — only on their
 * declaration."*
 *
 * maxstack meets it in the stronger form: generation output does not depend on a
 * flag **at all**. A flag is evaluated per viewer at request time, by
 * `getRoutes` in the running app; nothing in the ownership generators can reach
 * an evaluation, so there are no two branches to keep deterministic — there is
 * one branch, and it is the one that ships.
 *
 * That is easy to assert and easy to *silently lose*: the day someone threads a
 * resolved flag map into `pageDescriptor` "just for the nav", the property dies
 * with every test still green. So this file pins it against a **corpus app**
 * (`invoicer`, benchmark #4) rather than a toy fixture, and pins it in the
 * direction that catches the regression: the same spec, generated under flag
 * states that produce genuinely different runtime behavior, must emit
 * byte-identical files.
 *
 * The corpus app is cloned and flagged *here* rather than in `examples/src/`
 * on purpose. The frozen backlog is a measuring instrument (docs/corpus-integrity.md);
 * adding a flag to it would change what the eval scores. This test needs a
 * realistic spec, not a scored one.
 */

import { invoicerExample } from '@maxstack/examples'
import { defaultGeneratorRunner } from '@maxstack/mcp'
import {
	type ApplyMeta,
	applyOp,
	evaluateFlags,
	type SpecSystem,
} from '@maxstack/spec'
import { describe, expect, it } from 'vitest'

const meta = (n: number): ApplyMeta => ({
	actor: { surface: 'harness' },
	id: `op-flag-${n}`,
	origin: 'human',
	appliedAt: '2026-07-27',
})

/**
 * The corpus app with its first page gated on a flag, and `targeting` supplied
 * by the caller — the axis this test varies.
 */
function flaggedCorpusApp(
	targeting: { roles?: string[]; rolloutPercent?: number } | undefined,
): SpecSystem {
	const page = invoicerExample.spec.pages.pages[0]
	if (!page) throw new Error('invoicer benchmark has no pages to gate')
	let spec = applyOp(
		structuredClone(invoicerExample.spec),
		{
			op: 'flags.declare',
			args: {
				flag: {
					id: 'flg-invoice-redesign',
					key: 'invoice-redesign',
					description: 'The redesigned invoice surface.',
					default: false,
					...(targeting ? { targeting } : {}),
				},
			},
		},
		meta(1),
	)
	spec = applyOp(
		spec,
		{
			op: 'flags.gate',
			args: {
				target: { kind: 'page', id: page.id },
				flag: 'invoice-redesign',
			},
		},
		meta(2),
	)
	return spec
}

/** Every file all built-in generators emit for a spec, as a sorted map. */
async function generateAll(spec: SpecSystem): Promise<Record<string, string>> {
	const runner = defaultGeneratorRunner()
	const files: Record<string, string> = {}
	for (const name of ['page', 'docs', 'e2e-tests'] as const) {
		const result = await runner.run(name, spec, {})
		for (const artifact of result.artifacts)
			files[`${name}:${artifact.path}`] = artifact.content
	}
	return files
}

describe('determinism with a flagged surface', () => {
	it('emits byte-identical files for flag states with different runtime behavior', async () => {
		const offForEveryone = flaggedCorpusApp(undefined)
		const onForAdmins = flaggedCorpusApp({ roles: ['admin'] })
		const fullyRolledOut = flaggedCorpusApp({ rolloutPercent: 100 })

		// Not vacuous: the three specs genuinely disagree about the same viewer.
		const admin = { subject: 'u-1', role: 'admin' }
		expect(evaluateFlags(offForEveryone, admin)['invoice-redesign']).toBe(false)
		expect(evaluateFlags(onForAdmins, admin)['invoice-redesign']).toBe(true)
		expect(evaluateFlags(fullyRolledOut, admin)['invoice-redesign']).toBe(true)

		const generated = await Promise.all(
			[offForEveryone, onForAdmins, fullyRolledOut].map(generateAll),
		)
		expect(generated[1]).toEqual(generated[0])
		expect(generated[2]).toEqual(generated[0])
	})

	it('emits exactly what the unflagged corpus app emits — a flag is not a code path', async () => {
		// The stronger property: not just "both branches are deterministic", but
		// "there is one branch". Declaring and gating changes the running app's
		// composition, never the generated tree.
		const plain = await generateAll(invoicerExample.spec)
		const flagged = await generateAll(flaggedCorpusApp({ rolloutPercent: 50 }))
		expect(flagged).toEqual(plain)
	})

	it('regenerating the same flagged spec twice is byte-identical', async () => {
		const spec = flaggedCorpusApp({ rolloutPercent: 50 })
		expect(await generateAll(spec)).toEqual(await generateAll(spec))
	})
})
