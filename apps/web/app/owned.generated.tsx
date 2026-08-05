/**
 * Owned-code manifest (Bar 2 seam). AUTO-GENERATED — `maxstack build` overwrites
 * this with static imports of the project's user-owned slot/route modules so the
 * deployed bundle *executes* them instead of merely listing their names.
 *
 * This committed default is the empty stub: with no project owned code (a plain
 * `apps/web` build, the demo tour, the test suite) the runtime falls back to the
 * generic spec-driven render. The generator never touches a project's own files;
 * it only assembles this lookup at build time (see `commands/build.ts`).
 */

import type { ImportParser } from '@maxstack/core'
import type { ScheduleHandler } from '@maxstack/features/jobs'
import type { SourceRefiner } from '@maxstack/features/sources'
import type { ComponentType } from 'react'

/** `{ [resource]: { [slotName]: OwnedSlotComponent } }` — filled `*.slots.tsx`. */
export const OWNED_SLOTS: Record<string, Record<string, ComponentType>> = {}

/** `{ [resource]: EjectedRouteComponent }` — a project's ejected `<r>.tsx`. */
export const OWNED_ROUTES: Record<string, ComponentType> = {}

// The non-page seams. Each is the registry its generator wrote
// into the project — `jobs/schedules.generated.ts` and friends — re-exported so
// the runtime can execute what a project actually filled in. Empty here, and
// empty in a generated project that declared none of them: the generators emit
// nothing at all for an undeclared seam.

/** `{ [scheduleKey]: handler }` — the project's `jobs/schedules.generated.ts`. */
export const OWNED_SCHEDULE_HANDLERS: Record<string, ScheduleHandler> = {}

/** `{ [sourceKey]: refiner }` — the project's `sources/sources.generated.ts`. */
export const OWNED_SOURCE_REFINERS: Record<string, SourceRefiner> = {}

/** `{ [importerKey]: parser }` — the project's `imports/imports.generated.ts`. */
export const OWNED_IMPORT_PARSERS: Record<string, ImportParser> = {}

/** `{ [channelKey]: surface }` — the project's `live/live.generated.ts`. */
export const OWNED_LIVE_SURFACES: Record<string, ComponentType<never>> = {}
