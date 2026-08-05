/**
 * An in-memory `StorageProvider` — the test double, same role as `billing`'s
 * `memoryBillingProvider` / `email`'s `createMemoryMailer`. Keeps every put
 * in a `Map`; signed URLs are deterministic fake tokens so tests can assert
 * on them without touching the filesystem or network.
 */

import type {
	SignedUrlOptions,
	StorageProvider,
	StoredBytes,
	StoredObject,
} from './provider.ts'

export function createMemoryStorageProvider(): StorageProvider & {
	objects: Map<string, { bytes: Uint8Array; contentType: string }>
} {
	const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
	let n = 0
	return {
		objects,
		async put(key, bytes, contentType) {
			objects.set(key, { bytes, contentType })
			return {
				key,
				url: `memory://${key}?sig=${++n}`,
				size: bytes.byteLength,
				contentType,
			}
		},
		async read(key): Promise<StoredBytes | null> {
			const object = objects.get(key)
			return object
				? {
						bytes: object.bytes,
						contentType: object.contentType,
						size: object.bytes.byteLength,
					}
				: null
		},
		async getSignedUrl(key, _opts?: SignedUrlOptions) {
			return `memory://${key}?sig=${++n}`
		},
		async delete(key) {
			objects.delete(key)
		},
	} satisfies StorageProvider & {
		objects: Map<string, { bytes: Uint8Array; contentType: string }>
	}
}

export type { StoredObject }
