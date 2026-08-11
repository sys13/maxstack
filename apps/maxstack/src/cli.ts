#!/usr/bin/env node
/**
 * maxstack — the AI-native app platform CLI: the **bin entry**.
 *
 * Deliberately thin. The command tree lives in {@link buildProgram}
 * (`./program.ts`) so it can be read as data — by `scripts/gen-reference-docs.ts`,
 * which renders `docs/cli-reference.md` straight off the commander metadata —
 * without importing this file and thereby parsing argv and exiting the process.
 *
 * The one thing it does beyond parsing argv is bracket the run with the update
 * check — which belongs here precisely because it must wrap *every*
 * command without any of them knowing about it.
 */

import { closePrompters } from './lib/prompt.ts'
import { finishUpdateCheck, startUpdateCheck } from './lib/update-check.ts'
import { buildProgram } from './program.ts'

async function main() {
	// Started here, before the command, so the registry round-trip overlaps the
	// work instead of being added to it. Returns null — costing
	// nothing — whenever the check is opted out, non-interactive, or already
	// answered today.
	const pending = startUpdateCheck({})
	try {
		await buildProgram().parseAsync(process.argv)
	} catch (err) {
		console.error(`\n✖ ${err instanceof Error ? err.message : err}\n`)
		// A failed command is the worst moment to editorialize about versions, and
		// exiting here also abandons the probe — which is fine, the cache write is
		// best-effort by design.
		process.exit(1)
	} finally {
		// Whatever happened, give the terminal back (#421). An open readline
		// interface holds a listener on stdin, and that listener alone is enough to
		// keep the event loop alive — so a command that asked a question and then
		// succeeded would print its result and never exit.
		await closePrompters()
	}
	await finishUpdateCheck(pending)
}

main()
