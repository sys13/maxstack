/**
 * Storage provider contract (task 60) — the backend behind the task-39 upload
 * components (`FormFileInput` et al). Mirrors the shape every other feature in
 * this package uses: a small provider interface with an injectable, real
 * implementation plus a zero-config local default, selected by env vars at
 * the composition root (same posture as `billing`'s `stripeBillingProvider` /
 * `memoryBillingProvider` and `email`'s mailer transports).
 *
 * `put` persists bytes and returns a `StoredObject` (a key + an initial URL —
 * for a public/CDN-fronted bucket this is already a durable delivery URL; for
 * a private bucket or local disk it's a short-lived signed URL, same as a
 * fresh `getSignedUrl` call). `getSignedUrl` re-signs a previously stored key
 * — the read path a page's loader calls each render so a link never goes
 * stale, since the signed URL returned at upload time may since have expired.
 */

/** The outcome of a successful `put` — a stable `key` plus a URL to render
 * immediately (already signed / already public, depending on provider). */
export interface StoredObject {
	key: string
	url: string
	size: number
	contentType: string
}

export interface SignedUrlOptions {
	/** How long the URL stays valid. Defaults to the provider's own default
	 * (15 minutes for local disk, 15 minutes for S3). */
	expiresInSeconds?: number
	/**
	 * The viewer the URL is minted **for**. A local-disk signed URL
	 * binds this into its HMAC, so a leaked link is useless to anyone else.
	 *
	 * S3 presigned URLs cannot carry it — a presign is a bearer credential by
	 * construction — which is exactly why `getSignedUrl` is not the app's public
	 * read path. Reads go through the app's `/files/:key` gateway, which does the
	 * authorization; see `access.ts`.
	 */
	subject?: string
}

/** Raw bytes read back out of a provider — what the `/files/:key` gateway
 * streams once it has authorized the request. */
export interface StoredBytes {
	bytes: Uint8Array
	contentType: string
	size: number
}

/** The storage backend contract. A provider never exposes credentials or a
 * bucket layout to the caller — only keys and URLs. */
export interface StorageProvider {
	put(
		key: string,
		bytes: Uint8Array,
		contentType: string,
	): Promise<StoredObject>
	/**
	 * Read an object's bytes back, or `null` if there is no such key (never a
	 * throw — "missing" is an ordinary answer here, and the gateway turns it into
	 * a 404).
	 *
	 * Part of the contract as of issue #183 so every driver can back the same
	 * authorizing read gateway. Without it, local disk and S3 would necessarily
	 * behave differently on read — the local one proxied and access-checked, the
	 * S3 one a bare presigned bearer URL — which is precisely the dev/deploy
	 * divergence the issue rules out.
	 */
	read(key: string): Promise<StoredBytes | null>
	getSignedUrl(key: string, opts?: SignedUrlOptions): Promise<string>
	delete(key: string): Promise<void>
}

/** Size/type limits enforced before a `put` — config-driven so an app can
 * tighten or loosen them per upload surface. */
export interface UploadLimits {
	/** Max upload size in bytes. */
	maxSizeBytes: number
	/** Allowed MIME types, or `'*'` entries treated as a prefix wildcard
	 * (e.g. `'image/*'`). Empty/undefined allows anything. */
	allowedTypes?: string[]
}

/** Sensible defaults for the task-39 file/image inputs: 10MB, common image +
 * document MIME types. An app overrides via `validateUpload`'s `limits` arg. */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
	maxSizeBytes: 10 * 1024 * 1024,
	allowedTypes: [
		'image/*',
		'application/pdf',
		'text/plain',
		'text/csv',
		'application/json',
		'application/msword',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	],
}

export interface UploadValidationError {
	ok: false
	error: string
}
export interface UploadValidationOk {
	ok: true
}

/**
 * A size cap in the unit a person would say it in. Rounding everything to MB
 * was fine when there was one app-wide 10MB default; with per-field caps
 * a 200KB avatar field reported "exceeds the 0MB limit", which
 * tells the user nothing and reads like a bug in the app rather than a limit
 * they hit.
 */
export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		const mb = bytes / (1024 * 1024)
		return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`
	}
	if (bytes >= 1024) {
		const kb = bytes / 1024
		return `${Number.isInteger(kb) ? kb : kb.toFixed(1)}KB`
	}
	return `${bytes} byte${bytes === 1 ? '' : 's'}`
}

/** Validate a would-be upload's size + MIME type against `limits` (defaults
 * to {@link DEFAULT_UPLOAD_LIMITS}). Pure — callable both client- and
 * server-side so the UI can reject before it ever sends bytes, and the server
 * re-checks because the client can't be trusted. */
export function validateUpload(
	contentType: string,
	size: number,
	limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): UploadValidationOk | UploadValidationError {
	if (size > limits.maxSizeBytes) {
		return {
			ok: false,
			error: `File exceeds the ${formatBytes(limits.maxSizeBytes)} limit`,
		}
	}
	const allowed = limits.allowedTypes
	if (allowed && allowed.length > 0) {
		const matches = allowed.some((pattern) => {
			if (pattern.endsWith('/*')) {
				return contentType.startsWith(pattern.slice(0, -1))
			}
			return contentType === pattern
		})
		if (!matches) {
			return { ok: false, error: `File type "${contentType}" is not allowed` }
		}
	}
	return { ok: true }
}

/**
 * The declared constraints on one spec file field, structurally
 * mirrored from `@maxstack/spec`'s `FileFieldSpec` so the storage feature stays
 * importable without the spec package.
 */
export interface DeclaredFileField {
	accept: string[]
	maxSizeBytes: number
	derivatives?: {
		name: string
		width: number
		height?: number
		fit?: 'cover' | 'contain'
	}[]
}

/**
 * Turn a field's *declaration* into the limits the server wall enforces. This
 * is the whole point of issue #183: the cap a request is checked against comes
 * from the spec, per field, rather than from one app-wide default that a
 * 50MB-video field and a 200KB-avatar field would both have to live with.
 */
export function limitsForField(field: DeclaredFileField): UploadLimits {
	return {
		maxSizeBytes: field.maxSizeBytes,
		allowedTypes: [...field.accept],
	}
}

/**
 * Extensions we are willing to put on a stored object, keyed by the content
 * type we ourselves validated. Deliberately a *table*, not a parse of the
 * uploaded filename: issue #183's non-negotiable is that stored filenames are
 * never derived from user input, and "take the extension the client sent, but
 * only if it matches a charset" is still derived from user input — it just
 * launders it through a regex. A type we do not have an entry for gets no
 * extension at all, which is always safe.
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'image/avif': '.avif',
	'image/svg+xml': '.svg',
	'application/pdf': '.pdf',
	'text/plain': '.txt',
	'text/csv': '.csv',
	'text/markdown': '.md',
	'application/json': '.json',
	'application/zip': '.zip',
	'application/msword': '.doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
		'.docx',
	'application/vnd.ms-excel': '.xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

/** The extension for a validated content type, or `''` when we have none. */
export function extensionForContentType(contentType: string): string {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	return EXTENSION_BY_TYPE[type] ?? ''
}

/**
 * Mint a collision-resistant storage key. The name is a UUID plus an extension
 * looked up from the **validated content type** — never anything the client
 * chose. A key is therefore always `[0-9a-f-]{36}` + a known suffix, so it
 * cannot contain a path separator, a leading dot, a `..`, a NUL, or a second
 * extension like `avatar.png.php`.
 *
 * `originalName` is accepted and ignored beyond that: callers have it, and
 * threading it through keeps the display name and the storage key visibly
 * separate concerns rather than tempting a caller to build a key from it.
 */
export function makeStorageKey(
	_originalName: string,
	contentType?: string,
): string {
	return `${crypto.randomUUID()}${contentType ? extensionForContentType(contentType) : ''}`
}

/** `<uuid>.png` + `thumb` → `<uuid>@thumb.png`. A derivative shares its
 * original's extension, so a signed URL for a variant still content-negotiates
 * the same way. Pure and total — the read side derives variant keys with the
 * exact same function the write side stored them under. */
export function derivativeKey(key: string, name: string): string {
	const dot = key.lastIndexOf('.')
	return dot > 0
		? `${key.slice(0, dot)}@${name}${key.slice(dot)}`
		: `${key}@${name}`
}

/** Whether `key` is a derivative of some original, and of which variant. */
export function parseDerivativeKey(
	key: string,
): { original: string; name: string } | null {
	const dot = key.lastIndexOf('.')
	const stem = dot > 0 ? key.slice(0, dot) : key
	const ext = dot > 0 ? key.slice(dot) : ''
	const at = stem.lastIndexOf('@')
	if (at <= 0) return null
	return { original: `${stem.slice(0, at)}${ext}`, name: stem.slice(at + 1) }
}
