/**
 * One import surface for the example authors: the spec runtime helpers, the
 * ported PRD fixtures, the compact PRD builder, and the local
 * `ExampleApp` types.
 */

export type {
	BlockId,
	BoardSpec,
	CalendarSpec,
	ComputedFieldSpec,
	DocumentTemplateId,
	DocumentTemplateSpec,
	EntityId,
	EntitySpec,
	FieldId,
	FieldType,
	ImporterId,
	ImporterSpec,
	ISODate,
	LiveId,
	LiveSubscriptionSpec,
	OpId,
	PageId,
	PageSpec,
	PortalId,
	PortalSpec,
	PRD,
	RollupSpec,
	ScheduleId,
	ScheduleSpec,
	SearchIndexId,
	SearchIndexSpec,
	SourceId,
	SourceSpec,
	SpecOp,
	SpecSystem,
	TimelineSpec,
} from '@maxstack/spec'
export {
	applyOp,
	manual,
	minimalPRD,
	newSpecSystem,
	suggested,
} from '@maxstack/spec'
export {
	blogPRD,
	cardstackPRD,
	tasklyPRD,
	todotrackerPRD,
} from '@maxstack/spec/fixtures'
export type {
	ExampleApp,
	ExampleChange,
	OffSurfaceCluster,
} from '@maxstack/spec-derive'
export { examplePRD } from './prd-builder.ts'
