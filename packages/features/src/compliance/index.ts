/**
 * Compliance & data lifecycle (Task 62): GDPR export/erasure over
 * the Sprout registry's owner convention, versioned terms/cookie consent, and
 * the soft-delete retention purge job. `softDelete` itself lives in
 * `@maxstack/core`'s `ResourceConfig`/operations.ts — this package is the
 * feature layer over it (consent, export, erasure, the scheduled purge).
 */

export {
	type ConsentRecord,
	ConsentService,
	type RecordConsentInput,
} from './consent-service.ts'
export type {
	EraseUserDataOptions,
	ErasureReport,
	ErasureReportEntry,
} from './erasure-service.ts'
export {
	ERASED_SUBJECT,
	eraseUserData,
	ScopeMismatchError,
} from './erasure-service.ts'
export type { GdprExport, GdprExportOptions } from './export-service.ts'
export { exportUserData } from './export-service.ts'
export { ownerFieldOf } from './owner.ts'
export type { PurgeOptions, PurgeReportEntry } from './purge-job.ts'
export {
	DEFAULT_RETENTION_MS,
	PURGE_JOB_TYPE,
	purgeSoftDeleted,
	schedulePurgeJob,
} from './purge-job.ts'
export type {
	RelationEdge,
	RetentionClass,
	RetentionPolicy,
	SubjectRowSet,
} from './retention.ts'
export {
	assertRetentionCoverage,
	collectSubjectRows,
	deletionOrder,
	RetentionCoverageError,
	relationEdges,
	retentionPolicyErrors,
} from './retention.ts'
export {
	CONSENT_DDL,
	type ConsentType,
	consent,
} from './schema.ts'
