/**
 * Derivative materialization — including the two failure modes
 * that matter more than the happy path: a missing transformer must be caught at
 * boot, and a transformer that throws must cost the *variant*, never the upload.
 *
 * The `sharp` path is exercised for real (it is an optional dependency, so the
 * test skips itself when the binary is unavailable rather than failing CI on a
 * platform with no prebuild).
 */

import { describe, expect, it } from 'vitest'
import {
	assertTransformerForDerivatives,
	createSharpImageTransformer,
	type ImageTransformer,
	isResizableContentType,
	materializeDerivatives,
	passthroughImageTransformer,
} from './derivatives.ts'
import { createMemoryStorageProvider } from './memory.ts'

const bytes = new TextEncoder().encode('pretend-image')

async function storedOriginal(provider = createMemoryStorageProvider()) {
	const original = await provider.put('img.png', bytes, 'image/png')
	return { provider, original }
}

describe('assertTransformerForDerivatives', () => {
	it('passes when nothing declares a derivative', () => {
		expect(() =>
			assertTransformerForDerivatives(
				[{ id: 'fld-post-attachment' }],
				undefined,
			),
		).not.toThrow()
	})

	it('throws at boot, naming the field, when a derivative has no transformer', () => {
		// Loud and early beats a thumbnail that silently never appears.
		expect(() =>
			assertTransformerForDerivatives(
				[{ id: 'fld-post-cover', derivatives: [{ name: 'thumb' }] }],
				undefined,
			),
		).toThrow(/fld-post-cover \(thumb\)/)
	})

	it('passes once a transformer is bound', () => {
		expect(() =>
			assertTransformerForDerivatives(
				[{ id: 'fld-post-cover', derivatives: [{ name: 'thumb' }] }],
				passthroughImageTransformer,
			),
		).not.toThrow()
	})
})

describe('materializeDerivatives', () => {
	it('writes one variant per declaration, under the derivative key', async () => {
		const { provider, original } = await storedOriginal()
		const made = await materializeDerivatives({
			provider,
			transformer: passthroughImageTransformer,
			original,
			bytes,
			derivatives: [
				{ name: 'thumb', width: 320 },
				{ name: 'card', width: 640, height: 360 },
			],
		})

		expect(made.map((d) => d.key)).toEqual(['img@thumb.png', 'img@card.png'])
		expect(await provider.read('img@thumb.png')).not.toBeNull()
		// Every record says which transformer produced it, so a passthrough
		// variant is identifiable rather than indistinguishable from a real one.
		expect(made.every((d) => d.generator === 'passthrough')).toBe(true)
	})

	it('does nothing when nothing is declared', async () => {
		const { provider, original } = await storedOriginal()
		expect(
			await materializeDerivatives({
				provider,
				transformer: passthroughImageTransformer,
				original,
				bytes,
				derivatives: [],
			}),
		).toEqual([])
	})

	it('skips content types nothing can resize', async () => {
		const provider = createMemoryStorageProvider()
		const original = await provider.put('doc.pdf', bytes, 'application/pdf')
		expect(
			await materializeDerivatives({
				provider,
				transformer: passthroughImageTransformer,
				original,
				bytes,
				derivatives: [{ name: 'thumb', width: 320 }],
			}),
		).toEqual([])
	})

	it('keeps the upload when a transformer throws, and reports the variant', async () => {
		// Losing the user's bytes because a thumbnail failed would be the wrong
		// trade. The original is already stored; the variant is reported missing.
		const exploding: ImageTransformer = {
			generator: 'exploding',
			async resize() {
				throw new Error('decode failed')
			},
		}
		const { provider, original } = await storedOriginal()
		const errors: string[] = []
		const made = await materializeDerivatives({
			provider,
			transformer: exploding,
			original,
			bytes,
			derivatives: [{ name: 'thumb', width: 320 }],
			onError: (name) => errors.push(name),
		})

		expect(made).toEqual([])
		expect(errors).toEqual(['thumb'])
		expect(await provider.read('img.png')).not.toBeNull()
	})

	it('materializes the variants it can when only one fails', async () => {
		const flaky: ImageTransformer = {
			generator: 'flaky',
			async resize({ width, bytes: input, contentType }) {
				if (width === 320) throw new Error('nope')
				return { bytes: input, contentType }
			},
		}
		const { provider, original } = await storedOriginal()
		const made = await materializeDerivatives({
			provider,
			transformer: flaky,
			original,
			bytes,
			derivatives: [
				{ name: 'thumb', width: 320 },
				{ name: 'card', width: 640 },
			],
		})
		expect(made.map((d) => d.name)).toEqual(['card'])
	})

	it('reports every variant when no transformer is bound', async () => {
		const { provider, original } = await storedOriginal()
		const errors: string[] = []
		expect(
			await materializeDerivatives({
				provider,
				transformer: undefined,
				original,
				bytes,
				derivatives: [{ name: 'thumb', width: 320 }],
				onError: (name) => errors.push(name),
			}),
		).toEqual([])
		expect(errors).toEqual(['thumb'])
	})
})

describe('isResizableContentType', () => {
	it('accepts rasters and rejects SVG and non-images', () => {
		expect(isResizableContentType('image/png')).toBe(true)
		expect(isResizableContentType('image/JPEG')).toBe(true)
		// An SVG is a document with a parser attack surface, not a raster.
		expect(isResizableContentType('image/svg+xml')).toBe(false)
		expect(isResizableContentType('application/pdf')).toBe(false)
	})
})

describe('the sharp transformer', () => {
	/** `sharp` is optional; skip rather than fail where it has no prebuild. */
	async function sharpAvailable(): Promise<boolean> {
		try {
			const specifier = 'sharp'
			await import(specifier)
			return true
		} catch {
			return false
		}
	}

	it('actually resizes, and never enlarges a smaller source', async () => {
		if (!(await sharpAvailable())) return
		const specifier = 'sharp'
		const sharp = ((await import(specifier)) as any).default

		const source: Buffer = await sharp({
			create: {
				width: 800,
				height: 600,
				channels: 3,
				background: { r: 10, g: 20, b: 30 },
			},
		})
			.png()
			.toBuffer()

		const transformer = createSharpImageTransformer()
		expect(transformer.generator).toBe('sharp')

		const small = await transformer.resize({
			bytes: new Uint8Array(source),
			contentType: 'image/png',
			width: 200,
		})
		expect((await sharp(Buffer.from(small.bytes)).metadata()).width).toBe(200)
		expect(small.bytes.byteLength).toBeLessThan(source.byteLength)

		// withoutEnlargement: a "thumbnail" larger than its source is pure cost.
		const big = await transformer.resize({
			bytes: new Uint8Array(source),
			contentType: 'image/png',
			width: 4000,
		})
		expect((await sharp(Buffer.from(big.bytes)).metadata()).width).toBe(800)
	})

	it('rejects bytes that are not a decodable image', async () => {
		if (!(await sharpAvailable())) return
		await expect(
			createSharpImageTransformer().resize({
				bytes: new TextEncoder().encode('not an image'),
				contentType: 'image/png',
				width: 100,
			}),
		).rejects.toThrow()
	})

	it('produces a real variant end to end through materializeDerivatives', async () => {
		if (!(await sharpAvailable())) return
		const specifier = 'sharp'
		const sharp = ((await import(specifier)) as any).default
		const source: Buffer = await sharp({
			create: {
				width: 640,
				height: 480,
				channels: 3,
				background: { r: 1, g: 2, b: 3 },
			},
		})
			.png()
			.toBuffer()

		const provider = createMemoryStorageProvider()
		const input = new Uint8Array(source)
		const original = await provider.put('photo.png', input, 'image/png')
		const made = await materializeDerivatives({
			provider,
			transformer: createSharpImageTransformer(),
			original,
			bytes: input,
			derivatives: [{ name: 'thumb', width: 64 }],
		})

		expect(made).toHaveLength(1)
		expect(made[0]?.generator).toBe('sharp')
		const stored = await provider.read('photo@thumb.png')
		expect(stored).not.toBeNull()
		expect(
			(await sharp(Buffer.from(stored?.bytes ?? new Uint8Array())).metadata())
				.width,
		).toBe(64)
		// The variant is genuinely smaller than the original it came from.
		expect(stored?.size).toBeLessThan(original.size)
	})
})
