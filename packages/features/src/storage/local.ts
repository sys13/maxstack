/**
 * Local-disk storage provider — the zero-config default when no S3-compatible
 * bucket is configured (mirrors `email`'s `createConsoleMailer` /
 * `billing`'s `memoryBillingProvider`: a real, usable implementation for dev
 * and small deploys, not just a test double). Files land under `<dataDir>/uploads`
 * — the same `MAXSTACK_DATA_DIR`-rooted layout the telemetry/db stores use
 * (see `apps/web/app/data-dir.server.ts`), so `maxstack build`/`deploy`
 * vendoring carries uploads along with everything else.
 *
 * "Signed URL" for local disk means an HMAC-SHA256 token over
 * `key + viewer + expiry` (`access.ts`), verified by the `/files/:key` gateway
 * route before it streams the bytes back. Unlike a presigned S3 URL — a bearer
 * credential anyone holding it can redeem — this one is bound to the viewer it
 * was minted for, so a copied link is refused for everyone else.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
	DEFAULT_READ_TTL_SECONDS,
	fileGatewayUrl,
	verifyReadToken,
} from './access.ts'
import type { StorageProvider, StoredBytes } from './provider.ts'

export interface LocalStorageOptions {
	/** Directory uploads are written under (typically `<dataDir>/uploads`). */
	dir: string
	/** HMAC signing secret for signed URLs. In dev, a random per-process secret
	 * is fine (URLs only need to survive one server lifetime); set
	 * `STORAGE_SIGNING_SECRET` for a stable secret across restarts/deploys. */
	secret: string
	/** The public route prefix a signed URL is rooted at, e.g. `/files`. */
	urlPrefix?: string
}

/**
 * Verify a `/files/:key` request's `exp`/`sig` query params against `secret`,
 * for the viewer making the request. Used by the `apps/web` gateway route that
 * actually serves the bytes — kept here so signing and verification can never
 * drift apart, and a thin wrapper over `access.ts` so local disk and S3 are
 * authorized by exactly the same code.
 *
 * `subject` is the session's user id, **never** a value from the URL: the token
 * is bound to a viewer, so a link copied out of one person's page does not work
 * for anyone else.
 */
export function verifyLocalSignature(
	secret: string,
	key: string,
	expiresAtParam: string | null,
	sigParam: string | null,
	subject?: string | null,
): boolean {
	return verifyReadToken({
		secret,
		key,
		subject,
		exp: expiresAtParam,
		sig: sigParam,
	}).ok
}

/** Resolve a storage key to an on-disk path, rejecting any attempt to escape
 * `dir` via `..` or an absolute-path key (path traversal guard). */
function resolvePath(dir: string, key: string): string {
	const root = resolve(dir)
	const target = resolve(root, key)
	if (target !== root && !target.startsWith(`${root}/`)) {
		throw new Error(`storage: refusing to resolve key outside its root: ${key}`)
	}
	return target
}

/** `<key>.meta.json` alongside the blob stores the content-type, since the
 * filesystem doesn't. Small enough to just read back on every signed-URL
 * request rather than adding a manifest/index file. */
function metaPath(path: string): string {
	return `${path}.meta.json`
}

/**
 * A real, working local-filesystem `StorageProvider` — the dev/small-deploy
 * default. `put` writes the blob + a tiny content-type sidecar under `dir`;
 * `getSignedUrl` mints a time-limited HMAC token; `delete` removes both files.
 */
export function createLocalStorageProvider(
	opts: LocalStorageOptions,
): StorageProvider {
	return {
		async put(key, bytes, contentType) {
			const path = resolvePath(opts.dir, key)
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, bytes)
			await writeFile(metaPath(path), JSON.stringify({ contentType }))
			return {
				key,
				url: fileGatewayUrl({
					secret: opts.secret,
					key,
					prefix: opts.urlPrefix,
					expiresInSeconds: DEFAULT_READ_TTL_SECONDS,
				}),
				size: bytes.byteLength,
				contentType,
			}
		},

		async read(key): Promise<StoredBytes | null> {
			return readLocalObject(opts.dir, key)
		},

		async getSignedUrl(key, signOpts) {
			return fileGatewayUrl({
				secret: opts.secret,
				key,
				prefix: opts.urlPrefix,
				subject: signOpts?.subject,
				expiresInSeconds:
					signOpts?.expiresInSeconds ?? DEFAULT_READ_TTL_SECONDS,
			})
		},

		async delete(key) {
			const path = resolvePath(opts.dir, key)
			await rm(path, { force: true })
			await rm(metaPath(path), { force: true })
		},
	}
}

/** Read a stored blob's bytes + content-type back off disk — the provider's
 * `read` in free function form, kept exported because the gateway route and the
 * orphan sweep both want it without constructing a provider. */
export async function readLocalObject(
	dir: string,
	key: string,
): Promise<StoredBytes | null> {
	const path = resolvePath(dir, key)
	try {
		const [bytes, metaRaw, info] = await Promise.all([
			readFile(path),
			readFile(metaPath(path), 'utf8'),
			stat(path),
		])
		const meta = JSON.parse(metaRaw) as { contentType?: string }
		return {
			bytes,
			contentType: meta.contentType ?? 'application/octet-stream',
			size: info.size,
		}
	} catch {
		return null
	}
}

/** The uploads directory under a `MAXSTACK_DATA_DIR`-style data dir. */
export function uploadsDir(dataDir: string): string {
	return join(dataDir, 'uploads')
}
