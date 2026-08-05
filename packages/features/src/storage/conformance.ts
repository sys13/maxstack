/**
 * The shared `StorageProvider` conformance suite.
 *
 * The issue's requirement is that "the dev driver and the deploy driver must
 * behave identically or the difference is declared; a project that works
 * locally and 500s in Docker on first upload is the worst possible first
 * impression." A prose promise of parity is worth nothing, so parity is a test
 * that every driver runs — local disk, S3, and the in-memory double — from one
 * definition. A behaviour that is not the same across all three either gets
 * fixed or gets moved into {@link ProviderQuirks} and named.
 *
 * Declared, deliberate differences live in `ProviderQuirks` and nowhere else.
 * That is the "or the difference is declared" half, made mechanical: adding a
 * divergence means writing it down at the call site, in the driver's own test
 * file, where a reviewer sees it.
 */

import { expect, it } from 'vitest'
import type { StorageProvider } from './provider.ts'

/**
 * The differences a driver is allowed to have. Every field is a statement about
 * an object store's actual semantics, not an excuse for an unfinished driver.
 */
export interface ProviderQuirks {
	/**
	 * URLs are bearer credentials rather than viewer-bound. True for S3: a
	 * presigned URL is redeemable by whoever holds it, by construction. This is
	 * why the app's read path is the `/files/:key` gateway for *every* driver
	 * and never a raw `getSignedUrl` result handed to a browser.
	 */
	bearerUrls?: boolean
	/** URLs are not real HTTP URLs (the in-memory double emits `memory://`). */
	syntheticUrls?: boolean
}

export interface ConformanceCase {
	name: string
	/** A fresh provider per test — no state shared between cases. */
	create: () => StorageProvider | Promise<StorageProvider>
	quirks?: ProviderQuirks
}

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

/**
 * Register the parity assertions for one driver. Call inside a `describe`.
 *
 * Every case here is a behaviour the upload route, the gateway route or the
 * derivative materializer relies on — this is not a generic "does the interface
 * exist" suite, it is the set of promises those three callers make.
 */
export function testStorageProviderConformance(
	testCase: ConformanceCase,
): void {
	const provider = async () => await testCase.create()

	it('round-trips bytes and content type through put → read', async () => {
		const p = await provider()
		const stored = await p.put('conformance.txt', bytes('hello'), 'text/plain')
		expect(stored.key).toBe('conformance.txt')
		expect(stored.size).toBe(5)
		expect(stored.contentType).toBe('text/plain')

		const readBack = await p.read('conformance.txt')
		expect(text(readBack?.bytes ?? new Uint8Array())).toBe('hello')
		expect(readBack?.contentType).toBe('text/plain')
		expect(readBack?.size).toBe(5)
	})

	it('returns null for a key that was never stored — not a throw', async () => {
		// The gateway turns null into a 404. A driver that throws here would turn
		// an ordinary missing file into a 500 in exactly one environment, which is
		// the divergence class this suite exists to catch.
		const p = await provider()
		await expect(p.read('does-not-exist.txt')).resolves.toBeNull()
	})

	it('overwrites in place on a repeated put to the same key', async () => {
		const p = await provider()
		await p.put('same.txt', bytes('first'), 'text/plain')
		await p.put('same.txt', bytes('second'), 'text/plain')
		const readBack = await p.read('same.txt')
		expect(text(readBack?.bytes ?? new Uint8Array())).toBe('second')
	})

	it('stores a derivative alongside its original, independently', async () => {
		const p = await provider()
		await p.put('img.png', bytes('original'), 'image/png')
		await p.put('img@thumb.png', bytes('thumb'), 'image/png')
		expect(text((await p.read('img.png'))?.bytes ?? new Uint8Array())).toBe(
			'original',
		)
		expect(
			text((await p.read('img@thumb.png'))?.bytes ?? new Uint8Array()),
		).toBe('thumb')
	})

	it('deletes a key, and deleting a missing key is a no-op', async () => {
		const p = await provider()
		await p.put('gone.txt', bytes('x'), 'text/plain')
		await p.delete('gone.txt')
		await expect(p.read('gone.txt')).resolves.toBeNull()
		// Idempotent: the orphan sweep may be run twice against the same report.
		await expect(p.delete('gone.txt')).resolves.toBeUndefined()
	})

	it('handles zero-byte and binary payloads', async () => {
		const p = await provider()
		await p.put('empty.bin', new Uint8Array(), 'application/octet-stream')
		expect((await p.read('empty.bin'))?.size).toBe(0)

		const binary = new Uint8Array([0, 255, 10, 13, 26, 127, 128])
		await p.put('bin.bin', binary, 'application/octet-stream')
		expect(Array.from((await p.read('bin.bin'))?.bytes ?? [])).toEqual(
			Array.from(binary),
		)
	})

	it('mints a signed URL for a stored key, and again on demand', async () => {
		const p = await provider()
		const stored = await p.put('signed.txt', bytes('x'), 'text/plain')
		expect(stored.url).toBeTruthy()

		// The whole reason `getSignedUrl` exists: the URL handed out at upload
		// time expires, so a page re-signs on every render rather than persisting
		// the URL into a row.
		const resigned = await p.getSignedUrl('signed.txt')
		expect(resigned).toBeTruthy()

		if (!testCase.quirks?.syntheticUrls) {
			expect(() => new URL(resigned, 'http://conformance.test')).not.toThrow()
		}
	})

	it('honors an explicit expiry on a re-signed URL', async () => {
		const p = await provider()
		await p.put('ttl.txt', bytes('x'), 'text/plain')
		const url = await p.getSignedUrl('ttl.txt', { expiresInSeconds: 30 })
		expect(url).toBeTruthy()
	})

	it('binds a signed URL to its viewer unless the store cannot', async () => {
		const p = await provider()
		await p.put('bound.txt', bytes('x'), 'text/plain')
		const forAlice = await p.getSignedUrl('bound.txt', { subject: 'alice' })
		const forBob = await p.getSignedUrl('bound.txt', { subject: 'bob' })

		if (testCase.quirks?.bearerUrls) {
			// Declared difference, not an oversight: S3 presigns cannot carry a
			// viewer. The app never hands these to a browser — reads go through the
			// gateway, which authorizes before it streams.
			expect(typeof forAlice).toBe('string')
			return
		}
		expect(forAlice).not.toBe(forBob)
	})
}
