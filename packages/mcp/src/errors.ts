/**
 * The platform half's "this was written for the caller" marker (#353).
 *
 * `mcpFail` in `@maxstack/core` draws #336's line by **class**: an error we
 * constructed goes back verbatim, anything else becomes a fixed string plus a
 * correlation id. Sprout's half already had the classes to test — `NotFoundError`,
 * `PermissionError`, `ValidationError` and the rest. The platform half did not:
 * every one of its refusals was a bare `new Error(...)`, indistinguishable at the
 * boundary from an `ENOENT` out of the spec store or a stack out of a generator.
 *
 * So the refusals that are genuinely addressed to whoever called the tool —
 * `Unknown generator "x". Available: …`, `Unknown requirement "r9"` — throw this
 * instead. It carries no new data and no new behaviour; its whole content is the
 * assertion that this message was composed for a caller to read, which is the
 * only thing the boundary needs to know.
 *
 * The test to apply when adding one: could this sentence have been written
 * without looking at the machine it is running on? `Unknown page "p3"` could —
 * it is a fact about the caller's own spec. `EACCES: … /srv/app/spec/prd.ts`
 * could not. The second stays a plain `Error` and stays generic over the
 * network, which is the direction that fails safe.
 */
export class PlatformToolError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PlatformToolError'
	}
}
