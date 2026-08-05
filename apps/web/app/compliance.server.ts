/**
 * The retention classification for this app's tables.
 *
 * `@maxstack/features/compliance` refuses to run an export or an erasure
 * against a registry containing any unclassified table — deliberately, because
 * a flow that silently skips a table is the exposure the feature exists to
 * prevent. That leaves the composition root owing an answer for every resource,
 * which is this file.
 *
 * ## The default is `personal`, and that is the load-bearing choice
 *
 * A spec-derived project entity is classified `personal` unless it appears in
 * {@link INFRA_POLICIES} below. That is a default, and #188 is explicit that a
 * default is a form of silence — so it is worth being precise about *which*
 * default is dangerous.
 *
 *   - Defaulting to **`operational`** ("assume no personal data") means a new
 *     entity is quietly excluded from both the export and the erasure. The
 *     subject is told their data was deleted and it was not. That is the
 *     failure mode the issue names.
 *   - Defaulting to **`personal`** means a new entity is exported and erased
 *     without anyone classifying it. The worst case is over-collection in an
 *     export the subject already has a right to, and over-deletion of rows that
 *     are, by construction, reachable from the subject in the relation graph.
 *
 * The two are not symmetric, so the default goes in the safe direction and the
 * *unsafe* classifications — "this holds no personal data", "this survives an
 * erasure request" — are the ones that must be written down by a person. A test
 * asserts that nothing here is ever defaulted to `operational`.
 */

import type { ResourceRegistry } from '@maxstack/core'
import type { RetentionPolicy } from '@maxstack/features/compliance'

/**
 * The tables whose classification cannot be inferred, each with the written
 * claim the feature requires.
 *
 * Every entry here is either "holds no personal data" or "survives erasure" —
 * the two statements a heuristic must never make on somebody's behalf.
 */
const INFRA_POLICIES: RetentionPolicy[] = [
	{
		resource: 'audit_log',
		class: 'legal-hold',
		basis:
			'The audit trail is append-only by design: it is the record of what ' +
			'happened, including the actions of people who later ask to be erased. Deleting ' +
			'entries destroys the evidence that the erasure itself was performed correctly.',
		pseudonymize: ['userId', 'ipAddress', 'userAgent'],
	},
	{
		resource: 'job',
		class: 'operational',
		reason:
			'A run record: what the platform did and when. Payloads reference rows by id ' +
			'rather than embedding them, and the rows themselves are erased through their ' +
			'own resource.',
	},
	{
		resource: 'webhook_delivery',
		class: 'legal-hold',
		basis:
			'The record of what was sent to which third party — the evidence a ' +
			'data-protection question is answered from. Deleting it would destroy the ' +
			'answer to "was my data sent anywhere", which is a question the same subject ' +
			'is entitled to ask.',
		pseudonymize: ['payload'],
	},
	{
		resource: 'webhook_subscription',
		class: 'personal',
	},
	{
		resource: 'consent',
		class: 'legal-hold',
		basis:
			'The record that consent was given, which is the lawful basis for processing ' +
			'that happened before the erasure request. Deleting it deletes the proof that ' +
			'the processing was lawful at the time.',
		pseudonymize: ['userId'],
	},
	{
		resource: 'file_object',
		class: 'personal',
	},
	{
		resource: 'notification',
		class: 'personal',
	},
	{
		resource: 'notification_digest',
		class: 'personal',
	},
	{
		resource: 'preference',
		class: 'personal',
	},
	{
		resource: 'api_key',
		class: 'personal',
	},
	{
		resource: 'flag_usage',
		class: 'operational',
		reason:
			'Per-flag evaluation counters, coalesced in memory and flushed as sums. No ' +
			'row identifies a person.',
	},
]

/**
 * A retention policy for every resource in `registry`.
 *
 * Infra tables get their written classification; everything else — the
 * project's own spec entities — is `personal`. See the module note for why that
 * default goes in this direction and not the other.
 */
export function retentionPolicies(
	registry: ResourceRegistry,
): RetentionPolicy[] {
	const declared = new Map(INFRA_POLICIES.map((p) => [p.resource, p]))
	return registry.all().map((entry) => {
		const name = entry.resource.name
		return declared.get(name) ?? { resource: name, class: 'personal' as const }
	})
}
