/**
 * The check registry + the built-in checks — the machine-runnable half of the
 * validate gate, exposed through the MCP `run_checks` tool.
 *
 * The one built-in that can run purely off the spec is `spec-validate`
 * (referential integrity via {@link collectSpecSystemErrors} — the same gate
 * `apply_spec_change` enforces per-op, run here across the whole system). The
 * shell-backed checks (`typecheck`, `lint`, `test`) are supplied by the CLI /
 * web wiring as additional registered checks, since they need a real
 * subprocess; the tool contract is identical.
 */

import { collectSpecSystemErrors } from '@maxstack/spec'
import type {
	CheckInfo,
	CheckResult,
	CheckRunner,
	RegisteredCheck,
	UnavailableCheck,
} from './context.ts'
import { PlatformToolError } from './errors.ts'

/**
 * Build a runner over a fixed set of checks, plus the ones this host knows it
 * *should* run and cannot.
 *
 * `unavailable` is a constructor argument rather than something callers report
 * separately, because the two lists have to be produced by the same code that
 * decided which checks exist. A host that computes "typecheck is missing" in one
 * place and builds its registry in another will eventually ship a registry with
 * three checks and an empty unavailable list, which is precisely the hollow
 * green this exists to prevent.
 */
export function createCheckRegistry(
	checks: RegisteredCheck[],
	unavailable: UnavailableCheck[] = [],
): CheckRunner {
	const byName = new Map(checks.map((c) => [c.name, c]))
	return {
		list(): CheckInfo[] {
			return checks.map(({ name, summary }) => ({ name, summary }))
		},
		unavailable(): UnavailableCheck[] {
			return unavailable
		},
		async run(spec, names): Promise<CheckResult[]> {
			const selected = names?.length
				? names.map((n) => {
						const c = byName.get(n)
						if (!c)
							// Addressed to the caller (see PlatformToolError, #353).
							throw new PlatformToolError(
								`Unknown check "${n}". Available: ${[...byName.keys()].join(', ') || '(none)'}`,
							)
						return c
					})
				: checks
			const results: CheckResult[] = []
			for (const c of selected) results.push(await c.run(spec))
			return results
		},
	}
}

/** Referential integrity of the whole spec system. Pure — no subprocess. */
export const specValidateCheck: RegisteredCheck = {
	name: 'spec-validate',
	summary: 'Referential integrity of the whole spec system.',
	run(spec): CheckResult {
		const errors = collectSpecSystemErrors(spec)
		return {
			name: 'spec-validate',
			ok: errors.length === 0,
			output: errors.length ? errors.join('\n') : 'spec: valid',
		}
	},
}

export const BUILT_IN_CHECKS: RegisteredCheck[] = [specValidateCheck]

/** A runner over the built-in checks. */
export function defaultCheckRunner(): CheckRunner {
	return createCheckRegistry(BUILT_IN_CHECKS)
}
