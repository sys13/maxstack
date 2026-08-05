/**
 * Image derivatives — the bytes behind a spec-declared
 * `file.derivatives` entry.
 *
 * The spec says *what* variants exist (`{ name: 'thumb', width: 320 }`) and
 * `derivativeKey()` says *where* they live (`<uuid>@thumb.png`). This module is
 * the third piece: turning the original's bytes into the variant's bytes. That
 * step needs an image codec, which Node does not have, so it is an injectable
 * port — the same posture as `StorageProvider` itself, `billing`'s provider and
 * `email`'s mailer.
 *
 * **Why a port and not just a dependency.** Resizing is the one part of this
 * feature that cannot be done honestly in zero dependencies: a pure-JS JPEG and
 * PNG decoder is a large, slow, security-relevant surface, and pretending to
 * resize (returning the original bytes under a `@thumb` key) would be worse
 * than not shipping it — every consumer would believe it had a thumbnail. So:
 *
 *   - {@link createSharpImageTransformer} is the real one, lazily importing
 *     `sharp` (an optional dependency: prebuilt binaries exist for macOS and
 *     Linux on x64/arm64, and it is simply absent elsewhere).
 *   - A project whose spec declares a derivative and whose composition root has
 *     no transformer bound fails **loudly and early**, naming the field — see
 *     {@link assertTransformerForDerivatives}. It does not silently skip the
 *     variant, because a missing thumbnail that nothing complains about is a
 *     bug you find in production.
 *   - {@link passthroughImageTransformer} exists for tests only, and says so in
 *     the `generator` it reports, so a passthrough variant is identifiable in
 *     stored metadata rather than indistinguishable from a real one.
 */

import type { FileDerivativeMeta } from '@maxstack/core'
import type { StorageProvider, StoredObject } from './provider.ts'
import { derivativeKey } from './provider.ts'

/** A resize request — one declared derivative applied to one image. */
export interface ImageTransformRequest {
	bytes: Uint8Array
	contentType: string
	width: number
	height?: number
	fit?: 'cover' | 'contain'
}

export interface ImageTransformResult {
	bytes: Uint8Array
	contentType: string
}

/**
 * The image-resize port. Implementations must be pure with respect to storage —
 * they receive bytes and return bytes, and never touch the provider.
 */
export interface ImageTransformer {
	/** A short identifier recorded alongside the derivative, e.g. `sharp`. */
	readonly generator: string
	resize(request: ImageTransformRequest): Promise<ImageTransformResult>
}

/**
 * A **test-only** transformer that returns the original bytes unchanged. Its
 * `generator` is `passthrough` precisely so that a variant produced by it is
 * distinguishable from a real one in whatever recorded it.
 */
export const passthroughImageTransformer: ImageTransformer = {
	generator: 'passthrough',
	async resize({ bytes, contentType }) {
		return { bytes, contentType }
	},
}

/** Content types `sharp` can decode. An SVG is a document, not a raster, and
 * resizing one is both unnecessary and a known parser-attack surface, so it is
 * deliberately excluded from derivative generation. */
const RESIZABLE = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/avif',
	'image/gif',
	'image/tiff',
])

/** Whether a derivative can be produced from this content type at all. */
export function isResizableContentType(contentType: string): boolean {
	return RESIZABLE.has(contentType.split(';')[0]?.trim().toLowerCase() ?? '')
}

/**
 * The real transformer, backed by `sharp`. `sharp` is an optional dependency
 * loaded on first use — construction never throws, so a composition root can
 * bind this unconditionally; the failure (if the binary is unavailable for this
 * platform) surfaces on the first resize with a message that says what to do.
 */
export function createSharpImageTransformer(): ImageTransformer {
	let loading: Promise<SharpModule> | undefined

	async function load(): Promise<SharpModule> {
		// A non-literal specifier on purpose: `sharp` is an *optional* dependency,
		// so a literal `import('sharp')` would fail `tsc` on any machine that does
		// not have it installed — including CI for a project that declares no
		// derivatives and legitimately does not need it.
		// @vite-ignore on the import: bundlers must leave this alone rather than
		// try to resolve an optional native dependency into the graph.
		const specifier = 'sharp'
		loading ??= import(/* @vite-ignore */ specifier)
			.then((m) => (m.default ?? m) as unknown as SharpModule)
			.catch((cause: unknown) => {
				throw new Error(
					'storage: image derivatives need the optional "sharp" dependency, ' +
						'which is not installed or has no prebuilt binary for this platform. ' +
						'Install it (`pnpm add sharp`), or remove the `derivatives` from the ' +
						'file field that declares them.',
					{ cause },
				)
			})
		return loading
	}

	return {
		generator: 'sharp',
		async resize({ bytes, contentType, width, height, fit }) {
			const sharp = await load()
			// `failOn: 'error'` (sharp's default is 'warning') rejects a malformed
			// image rather than best-effort decoding it — an upload is untrusted
			// input, and the strict path is the right default for untrusted input.
			const pipeline = sharp(Buffer.from(bytes), { failOn: 'error' }).resize({
				width,
				height,
				fit: fit ?? 'cover',
				// Never scale a small image up: a "thumbnail" larger than its source
				// costs bytes and gains nothing.
				withoutEnlargement: true,
			})
			const out = await pipeline.toBuffer()
			return { bytes: new Uint8Array(out), contentType }
		},
	}
}

/** The slice of `sharp`'s surface this module uses — typed locally so the
 * package does not need `@types` for an optional dependency. */
type SharpModule = (
	input: Buffer,
	options?: { failOn?: string },
) => {
	resize(options: {
		width: number
		height?: number
		fit?: string
		withoutEnlargement?: boolean
	}): { toBuffer(): Promise<Buffer> }
}

/** A derivative that was actually written, as recorded next to the original. */
export interface MaterializedDerivative {
	name: string
	key: string
	size: number
	contentType: string
	/** Which transformer produced it — `sharp`, or `passthrough` in tests. */
	generator: string
}

/**
 * Fail at the composition root, not at the first upload, when a spec declares
 * derivatives and nothing can produce them. Call this once at boot with every
 * declared file field; the error names the field so the fix is obvious.
 */
export function assertTransformerForDerivatives(
	fields: readonly {
		id: string
		derivatives?: readonly { name: string }[]
	}[],
	transformer: ImageTransformer | undefined,
): void {
	if (transformer) return
	const declaring = fields.filter((f) => (f.derivatives?.length ?? 0) > 0)
	if (declaring.length === 0) return
	const names = declaring
		.map((f) => `${f.id} (${f.derivatives?.map((d) => d.name).join(', ')})`)
		.join('; ')
	throw new Error(
		`storage: ${declaring.length} file field(s) declare image derivatives but no imageTransformer is bound at the composition root: ${names}. ` +
			'Bind `createSharpImageTransformer()`, or remove the derivatives from the spec.',
	)
}

/**
 * Materialize every declared derivative of a just-stored original.
 *
 * Ordering matters and is deliberate: the original is already persisted before
 * this runs, so a transformer failure costs you the *variants*, never the
 * upload. A failed variant is reported to `onError` and omitted from the
 * result rather than thrown, because the alternative — failing the whole upload
 * because a thumbnail could not be made — loses the user's bytes over a
 * cosmetic artifact. The caller records exactly which variants exist, so a
 * missing one is visible in the metadata rather than assumed.
 */
export async function materializeDerivatives(input: {
	provider: StorageProvider
	transformer: ImageTransformer | undefined
	original: StoredObject
	bytes: Uint8Array
	derivatives: readonly FileDerivativeMeta[]
	onError?: (derivative: string, error: unknown) => void
}): Promise<MaterializedDerivative[]> {
	const { provider, transformer, original, bytes, derivatives } = input
	if (derivatives.length === 0) return []
	if (!isResizableContentType(original.contentType)) return []
	if (!transformer) {
		// Unreachable from a booted app (assertTransformerForDerivatives runs
		// first); reported rather than thrown so a direct caller in a test or a
		// script gets the same "variants missing, upload kept" contract.
		for (const d of derivatives) {
			input.onError?.(d.name, new Error('no imageTransformer bound'))
		}
		return []
	}

	const out: MaterializedDerivative[] = []
	for (const derivative of derivatives) {
		try {
			const resized = await transformer.resize({
				bytes,
				contentType: original.contentType,
				width: derivative.width,
				height: derivative.height,
				fit: derivative.fit,
			})
			const key = derivativeKey(original.key, derivative.name)
			const stored = await provider.put(key, resized.bytes, resized.contentType)
			out.push({
				name: derivative.name,
				key: stored.key,
				size: stored.size,
				contentType: stored.contentType,
				generator: transformer.generator,
			})
		} catch (error) {
			input.onError?.(derivative.name, error)
		}
	}
	return out
}
