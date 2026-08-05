import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@aws-sdk/s3-request-presigner', () => ({
	getSignedUrl: vi.fn(
		async (_client: unknown, command: { input: { Key: string } }) =>
			`https://bucket.s3.test/${command.input.Key}?presigned=1`,
	),
}))

import { getSignedUrl as presignMock } from '@aws-sdk/s3-request-presigner'
import { testStorageProviderConformance } from './conformance.ts'
import { createS3StorageProvider } from './s3.ts'

beforeEach(() => {
	vi.mocked(presignMock).mockClear()
})

interface FakeCommand {
	input: Record<string, unknown>
}

function fakeClient() {
	return { send: vi.fn(async (_command: FakeCommand) => ({})) }
}

describe('createS3StorageProvider', () => {
	it('put() PUTs the object then returns a presigned GET URL', async () => {
		const client = fakeClient()
		const provider = createS3StorageProvider({
			bucket: 'my-bucket',
			client: client as any,
		})
		const bytes = new TextEncoder().encode('hi')
		const stored = await provider.put('img/a.png', bytes, 'image/png')

		expect(client.send).toHaveBeenCalledTimes(1)
		const [putCommand] = client.send.mock.calls[0] ?? []
		expect(putCommand?.input).toMatchObject({
			Bucket: 'my-bucket',
			Key: 'img/a.png',
			ContentType: 'image/png',
		})
		expect(stored.url).toBe('https://bucket.s3.test/img/a.png?presigned=1')
		expect(stored.size).toBe(bytes.byteLength)
	})

	it('returns a plain public URL when publicBaseUrl is configured (CDN-fronted)', async () => {
		const client = fakeClient()
		const provider = createS3StorageProvider({
			bucket: 'my-bucket',
			publicBaseUrl: 'https://cdn.example.com/',
			client: client as any,
		})
		const stored = await provider.put(
			'img/b.png',
			new TextEncoder().encode('hi'),
			'image/png',
		)
		expect(stored.url).toBe('https://cdn.example.com/img/b.png')
		expect(presignMock).not.toHaveBeenCalled()
	})

	it('getSignedUrl re-signs an existing key without re-uploading', async () => {
		const client = fakeClient()
		const provider = createS3StorageProvider({
			bucket: 'my-bucket',
			client: client as any,
		})
		const url = await provider.getSignedUrl('img/c.png', {
			expiresInSeconds: 60,
		})
		expect(url).toBe('https://bucket.s3.test/img/c.png?presigned=1')
		expect(client.send).not.toHaveBeenCalled()
	})

	it('delete() issues a DeleteObjectCommand for the key', async () => {
		const client = fakeClient()
		const provider = createS3StorageProvider({
			bucket: 'my-bucket',
			client: client as any,
		})
		await provider.delete('img/d.png')
		expect(client.send).toHaveBeenCalledTimes(1)
		const [deleteCommand] = client.send.mock.calls[0] ?? []
		expect(deleteCommand?.input).toMatchObject({
			Bucket: 'my-bucket',
			Key: 'img/d.png',
		})
	})
})

/**
 * A bucket-shaped double: a Map behind the three commands the driver issues,
 * including the `NoSuchKey` error real S3 raises on a missing GetObject. Good
 * enough to be worth running the parity suite against — a fake that answered
 * `{}` to everything would make the suite pass without proving anything.
 */
function bucketDouble() {
	const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
	return {
		objects,
		send: vi.fn(
			async (command: { constructor: { name: string }; input: any }) => {
				const name = command.constructor.name
				const key = command.input.Key as string
				if (name === 'PutObjectCommand') {
					objects.set(key, {
						bytes: new Uint8Array(command.input.Body),
						contentType: command.input.ContentType,
					})
					return {}
				}
				if (name === 'GetObjectCommand') {
					const object = objects.get(key)
					if (!object) {
						const error = new Error('The specified key does not exist.')
						error.name = 'NoSuchKey'
						throw error
					}
					return {
						Body: { transformToByteArray: async () => object.bytes },
						ContentType: object.contentType,
						ContentLength: object.bytes.byteLength,
					}
				}
				if (name === 'DeleteObjectCommand') {
					objects.delete(key)
					return {}
				}
				throw new Error(`unexpected command ${name}`)
			},
		),
	}
}

describe('s3 driver parity', () => {
	testStorageProviderConformance({
		name: 's3',
		create: () =>
			createS3StorageProvider({
				bucket: 'parity',
				client: bucketDouble() as any,
			}),
		// Declared, deliberate: a presigned S3 URL is a bearer credential. The app
		// never hands one to a browser — reads go through the /files/:key gateway,
		// which authorizes first. See conformance.ts.
		quirks: { bearerUrls: true },
	})
})

describe('read()', () => {
	it('returns null for a missing key rather than throwing', async () => {
		const client = bucketDouble()
		const provider = createS3StorageProvider({
			bucket: 'my-bucket',
			client: client as unknown as Parameters<
				typeof createS3StorageProvider
			>[0]['client'],
		})
		await expect(provider.read('nope.png')).resolves.toBeNull()
	})

	it('propagates a real fault instead of laundering it into "not found"', async () => {
		// A misconfigured deployment must look misconfigured, not empty.
		const client = {
			send: vi.fn(async () => {
				const error = new Error(
					'The AWS Access Key Id you provided does not exist',
				)
				error.name = 'InvalidAccessKeyId'
				throw error
			}),
		}
		const provider = createS3StorageProvider({
			bucket: 'my-bucket',
			client: client as unknown as Parameters<
				typeof createS3StorageProvider
			>[0]['client'],
		})
		await expect(provider.read('x.png')).rejects.toThrow(/Access Key/)
	})
})
