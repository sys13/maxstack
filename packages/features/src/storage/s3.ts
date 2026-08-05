/**
 * S3-compatible storage provider — the "real" backend task 60 asks for,
 * selected at the composition root when `S3_BUCKET` is set (mirrors
 * `billing`'s `STRIPE_SECRET_KEY` gate). Works against AWS S3 and any
 * S3-compatible object store (R2, MinIO, Backblaze B2, …) via `S3_ENDPOINT` +
 * `forcePathStyle`.
 *
 * Uses the official `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
 * rather than hand-rolled SigV4: request signing is exactly the kind of thing
 * worth a real dependency for (a subtly wrong signature fails closed, but
 * only in production, against a real bucket — not a place to save an SDK).
 * Every other feature in this package prefers zero dependencies where the
 * protocol is a couple of fetch calls (`billing`'s Stripe adapter, `email`'s
 * mailer); this is the exception, deliberately.
 *
 * CDN-friendly delivery: if `S3_PUBLIC_BASE_URL` is set (a CDN or bucket
 * website endpoint in front of the bucket), `put`/`getSignedUrl` return a
 * plain public URL instead of a presigned one — no expiry, cacheable at the
 * edge. Otherwise every URL is presigned with a bounded TTL.
 */

import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner'
import type {
	SignedUrlOptions,
	StorageProvider,
	StoredBytes,
	StoredObject,
} from './provider.ts'

const DEFAULT_EXPIRES_SECONDS = 15 * 60

/** S3 signals a missing object as `NoSuchKey` (GetObject) or a bare 404. */
function isNotFound(error: unknown): boolean {
	const e = error as {
		name?: string
		Code?: string
		$metadata?: { httpStatusCode?: number }
	}
	return (
		e?.name === 'NoSuchKey' ||
		e?.name === 'NotFound' ||
		e?.Code === 'NoSuchKey' ||
		e?.$metadata?.httpStatusCode === 404
	)
}

export interface S3StorageOptions {
	bucket: string
	region?: string
	/** Custom endpoint for S3-compatible stores (R2, MinIO, …); omitted for AWS. */
	endpoint?: string
	accessKeyId?: string
	secretAccessKey?: string
	/** Required by most non-AWS S3-compatible stores. */
	forcePathStyle?: boolean
	/** A CDN / bucket-website base URL served in front of the bucket, e.g.
	 * `https://cdn.example.com`. When set, URLs are plain `${base}/${key}` —
	 * no signing, no expiry — instead of presigned. */
	publicBaseUrl?: string
	/** Test seam: inject a pre-built client instead of constructing one. */
	client?: S3Client
}

/**
 * The real S3(-compatible) adapter. `put` streams bytes via `PutObjectCommand`
 * then returns either a public CDN URL (if `publicBaseUrl` is set) or a fresh
 * presigned GET URL; `getSignedUrl` re-signs a previously stored key the same
 * way; `delete` issues `DeleteObjectCommand`.
 */
export function createS3StorageProvider(
	opts: S3StorageOptions,
): StorageProvider {
	const client =
		opts.client ??
		new S3Client({
			region: opts.region ?? 'auto',
			endpoint: opts.endpoint,
			forcePathStyle: opts.forcePathStyle ?? !!opts.endpoint,
			credentials:
				opts.accessKeyId && opts.secretAccessKey
					? {
							accessKeyId: opts.accessKeyId,
							secretAccessKey: opts.secretAccessKey,
						}
					: undefined,
		})

	async function sign(key: string, expiresInSeconds: number): Promise<string> {
		if (opts.publicBaseUrl) {
			return `${opts.publicBaseUrl.replace(/\/$/, '')}/${key}`
		}
		const command = new GetObjectCommand({ Bucket: opts.bucket, Key: key })
		return presign(client, command, { expiresIn: expiresInSeconds })
	}

	return {
		async put(key, bytes, contentType): Promise<StoredObject> {
			await client.send(
				new PutObjectCommand({
					Bucket: opts.bucket,
					Key: key,
					Body: bytes,
					ContentType: contentType,
				}),
			)
			const url = await sign(key, DEFAULT_EXPIRES_SECONDS)
			return { key, url, size: bytes.byteLength, contentType }
		},

		async read(key): Promise<StoredBytes | null> {
			try {
				const result = await client.send(
					new GetObjectCommand({ Bucket: opts.bucket, Key: key }),
				)
				const body = result.Body
				if (!body) return null
				const bytes = await body.transformToByteArray()
				return {
					bytes,
					contentType: result.ContentType ?? 'application/octet-stream',
					size: result.ContentLength ?? bytes.byteLength,
				}
			} catch (error) {
				// A missing key is an ordinary answer, not an exception — the gateway
				// turns `null` into a 404. Anything else (credentials, network, a
				// bucket that does not exist) is a real fault and must not be
				// laundered into "not found", which would make a misconfigured
				// deployment look like an empty one.
				if (isNotFound(error)) return null
				throw error
			}
		},

		async getSignedUrl(key, signOpts?: SignedUrlOptions): Promise<string> {
			return sign(key, signOpts?.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS)
		},

		async delete(key) {
			await client.send(
				new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }),
			)
		},
	}
}
