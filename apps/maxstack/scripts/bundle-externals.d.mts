/**
 * Types for `bundle-externals.mjs`.
 *
 * The helper stays `.mjs` because `build.mjs` imports it under a bare `node`
 * invocation at `prepublishOnly`, where relying on type stripping would make the
 * publish path depend on the Node minor in use. The test that consumes it is
 * TypeScript, so the surface is declared here instead.
 */

import type { BuildOptions, Metafile } from 'esbuild'

export const externalizeThirdParty: NonNullable<BuildOptions['plugins']>[number]

/** esbuild options that reproduce the published bundle, minus the write. */
export const BUNDLE_OPTIONS: BuildOptions & { metafile: true }

/** The npm packages the bundle imports, deduped to their package name, sorted. */
export function collectExternals(metafile: Metafile): string[]

/** The externals the bundle is expected to have. Update deliberately. */
export const EXPECTED_EXTERNALS: string[]

/** `null` when `actual` matches `EXPECTED_EXTERNALS`, else what moved. */
export function externalsDrift(
	actual: string[],
): { added: string[]; gone: string[] } | null
