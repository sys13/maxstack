/**
 * Ownership — the Phase 2 "safe change-over-time" machinery.
 *
 * The hard guarantees that ship regardless of the ladder-vs-diff bake-off:
 *   - the ownership manifest (`manifest.ts`) + never-clobber writer/eject
 *     (`write.ts`) — the eject rung and the invariant behind it;
 *   - ts-morph generator-side emission (`emit.ts`) replacing string `.replace()`;
 *   - the cross-file extension slot seam (the `<Slot>` runtime lives in
 *     `@maxstack/ui`; the generator wires it here);
 *   - regeneration-as-diff (bet B) + the regeneration-safety suite (`regen.ts`).
 */

export * from './block-slots.ts'
export * from './drift.ts'
export * from './emit.ts'
export * from './generate.ts'
export * from './imports.ts'
export * from './live.ts'
export * from './manifest.ts'
export * from './memfs.ts'
export * from './nodefs.ts'
export * from './owned-codegen.ts'
export * from './prune.ts'
export * from './regen.ts'
export * from './schedules.ts'
export * from './sources.ts'
export * from './write.ts'
