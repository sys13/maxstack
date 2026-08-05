/**
 * External data sources — declared fetch, typed response mapping, and
 * scheduled or webhook-driven sync.
 *
 * The spec declares a source (`@maxstack/spec`'s `sources.ts` — endpoint, the
 * credential *by name*, the mapping, the budget); this is the half that runs
 * it. Three files, three jobs:
 *
 *   - `fetch.ts` — the guarded request: SSRF-checked immediately before it is
 *     issued, pinned to the declared origin, redirects never followed, timeout
 *     and size cap applied, credential read from the deployment's secret store
 *     and never returned.
 *   - `mapping.ts` — pure: response document → values, typed by the target
 *     column and refusing rather than writing a lie.
 *   - `service.ts` / `queue.ts` — a run produces *intent*, which the host
 *     applies through the same validated write path a form posts to; and a run
 *     is a job, so retries, backoff and the run history are the queue's.
 *
 * Nothing here is reachable from the generation path — declaring a source
 * changes what the running app does, never what the generator writes.
 */

export type {
	FetchLike,
	FetchSourceDeps,
	SecretStore,
	SourceFailure,
} from './fetch.ts'
export {
	buildSourceUrl,
	envSecretStore,
	fetchSource,
	MAX_RESPONSE_BYTES,
	SourceFetchError,
	sourceBackoffMs,
	substitutePlaceholders,
} from './fetch.ts'
export type { MappedValues, MappingRefusal } from './mapping.ts'
export { applyMapping, readCollection, remoteIdOf } from './mapping.ts'
export type {
	RegisterSourcesOptions,
	SourceHealth,
	SourceHealthState,
	SourceJobPayload,
	SourceWriteApplier,
} from './queue.ts'
export {
	allSourceHealth,
	describeHealth,
	enqueueEnrichment,
	enqueueSync,
	registerSourceHandlers,
	SOURCE_JOB_TYPE,
	STALE_AFTER_MS,
	sourceHealth,
	sourceJobKey,
	writeTriggersEnrichment,
} from './queue.ts'
export type {
	RowValues,
	SourceRefineContext,
	SourceRefiner,
	SourceRunDeps,
	SourceRunResult,
	SourceWrite,
} from './service.ts'
export { runEnrichment, runSync } from './service.ts'
