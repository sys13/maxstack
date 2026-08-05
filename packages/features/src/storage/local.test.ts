import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testStorageProviderConformance } from './conformance.ts'
import {
	createLocalStorageProvider,
	readLocalObject,
	verifyLocalSignature,
} from './local.ts'

describe('local driver parity', () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-storage-parity-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})
	testStorageProviderConformance({
		name: 'local',
		create: () => createLocalStorageProvider({ dir, secret: 'parity-secret' }),
	})
})

describe('createLocalStorageProvider', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'maxstack-storage-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('writes bytes to disk and returns a signed URL that verifies', async () => {
		const provider = createLocalStorageProvider({ dir, secret: 'test-secret' })
		const bytes = new TextEncoder().encode('hello world')
		const stored = await provider.put('a/b/hello.txt', bytes, 'text/plain')

		expect(stored.key).toBe('a/b/hello.txt')
		expect(stored.size).toBe(bytes.byteLength)
		expect(stored.contentType).toBe('text/plain')

		const url = new URL(stored.url, 'http://local.test')
		expect(url.pathname).toBe('/files/a%2Fb%2Fhello.txt')
		const exp = url.searchParams.get('exp')
		const sig = url.searchParams.get('sig')
		expect(verifyLocalSignature('test-secret', 'a/b/hello.txt', exp, sig)).toBe(
			true,
		)

		const readBack = await readLocalObject(dir, 'a/b/hello.txt')
		expect(readBack?.contentType).toBe('text/plain')
		expect(new TextDecoder().decode(readBack?.bytes)).toBe('hello world')
	})

	it('rejects a signature signed with the wrong secret', async () => {
		const provider = createLocalStorageProvider({ dir, secret: 'right' })
		const stored = await provider.put(
			'x.txt',
			new TextEncoder().encode('x'),
			'text/plain',
		)
		const url = new URL(stored.url, 'http://local.test')
		const sig = url.searchParams.get('sig')
		const exp = url.searchParams.get('exp')
		expect(verifyLocalSignature('wrong', 'x.txt', exp, sig)).toBe(false)
	})

	it('rejects an expired signature', async () => {
		expect(
			verifyLocalSignature('s', 'x.txt', String(Date.now() - 1000), 'deadbeef'),
		).toBe(false)
	})

	it('getSignedUrl re-signs a previously stored key', async () => {
		const provider = createLocalStorageProvider({ dir, secret: 'test-secret' })
		await provider.put('k.txt', new TextEncoder().encode('k'), 'text/plain')
		const url = new URL(
			await provider.getSignedUrl('k.txt'),
			'http://local.test',
		)
		expect(
			verifyLocalSignature(
				'test-secret',
				'k.txt',
				url.searchParams.get('exp'),
				url.searchParams.get('sig'),
			),
		).toBe(true)
	})

	it('delete removes the blob and its metadata sidecar', async () => {
		const provider = createLocalStorageProvider({ dir, secret: 'test-secret' })
		await provider.put('d.txt', new TextEncoder().encode('d'), 'text/plain')
		expect(await readLocalObject(dir, 'd.txt')).not.toBeNull()
		await provider.delete('d.txt')
		expect(await readLocalObject(dir, 'd.txt')).toBeNull()
	})

	it('readLocalObject returns null for a missing key', async () => {
		expect(await readLocalObject(dir, 'nope.txt')).toBeNull()
	})

	it('refuses to resolve a key that escapes the storage root', async () => {
		const provider = createLocalStorageProvider({ dir, secret: 's' })
		await expect(
			provider.put(
				'../../etc/passwd',
				new TextEncoder().encode('x'),
				'text/plain',
			),
		).rejects.toThrow(/outside its root/)
	})
})
