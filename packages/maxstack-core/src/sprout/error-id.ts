/**
 * Correlation ids for internal failures — the half of #336 that is not about
 * REST.
 *
 * #336 drew the line for the API: an error *we* constructed goes back to the
 * caller verbatim, and anything else becomes a fixed string plus an id, with the
 * detail on stderr. That line is not specific to a JSON body. A page loader that
 * dies inside the driver leaks exactly the same statement, column names and
 * bound parameters if its message reaches the browser, and the user who hit it
 * has exactly the same problem: nothing to quote in a bug report.
 *
 * So the minting and the logging live here rather than inside `api.ts`, and the
 * REST boundary and the app's root error boundary mint the *same* kind of id and
 * print the *same* line shape. An operator greps one pattern, not two.
 */

/** Where the failure happened — server-side log context, never sent to a client. */
export interface ErrorContext {
	/** The resource, route or subsystem being served, e.g. `book` or `/app/decks`. */
	resource: string
	/** What was being attempted, e.g. `list`, `loader`, `action`. */
	operation: string
}

/**
 * A short correlation id, in `logger.ts`'s `req_…` shape so the two ids read as
 * the same kind of thing in a log pipeline. It is handed to the caller *and*
 * printed with the detail, which is the whole point: a user can quote it in a
 * bug report and the operator can find the one line that says what actually
 * broke.
 */
export function nextErrorId(): string {
	return `err_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The detail, to stderr, as one structured JSON line — the shape
 * `logRequest`/`createConsoleErrorReporter` already emit (`level`, `type`,
 * then fields), so a deployed app's logs stay greppable and `maxstack doctor`'s
 * "go and read stderr" advice lands somewhere useful.
 *
 * `@maxstack/core` may not import `@maxstack/features` (see
 * `scripts/boundaries.config.json`), so this cannot reuse the observability
 * reporter; it deliberately duplicates only the line *shape*, not the logic.
 */
export function reportInternalError(
	e: unknown,
	errorId: string,
	context: ErrorContext,
): void {
	const err = e instanceof Error ? e : new Error(String(e))
	console.error(
		JSON.stringify({
			level: 'error',
			type: 'api-internal-error',
			errorId,
			resource: context.resource,
			operation: context.operation,
			name: err.name,
			message: err.message,
			stack: err.stack,
		}),
	)
}
