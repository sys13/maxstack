/**
 * Owned-code wiring for file/image uploads (task 60) — the backend behind the
 * task-39 `FormFileInput` component. Same posture as `billing.server.ts`:
 * the feature (`@maxstack/features/storage`) owns the provider contract +
 * implementations, this module picks one for the running app and exposes it
 * to the upload/serve routes.
 *
 * Provider selection mirrors `billing.server.ts`'s `getBillingProvider`: a
 * real `S3_BUCKET` env var selects the S3-compatible adapter (AWS S3, R2,
 * MinIO, …); otherwise uploads land on local disk under
 * `<dataDir>/uploads`, the same `MAXSTACK_DATA_DIR`-rooted layout the
 * telemetry/db stores use (`data-dir.server.ts`) so `maxstack build`/`deploy`
 * vendoring carries uploads along with everything else.
 */

import {
	createLocalStorageProvider,
	createS3StorageProvider,
	createSharpImageTransformer,
	DEFAULT_UPLOAD_LIMITS,
	fileGatewayUrl,
	type ImageTransformer,
	type StorageProvider,
	type UploadLimits,
	uploadsDir,
	verifyReadToken,
} from '@maxstack/features/storage'
import { resolveDataDir } from './data-dir.server'

const storageScope = globalThis as typeof globalThis & {
	__maxstackStorageProvider?: StorageProvider
	__maxstackStorageSigningSecret?: string
	__maxstackImageTransformer?: ImageTransformer
}

/** The route prefix the read gateway is mounted at (`files.$key.tsx`). */
export const FILE_GATEWAY_PREFIX = '/files'

/** Whether a real S3-compatible bucket is configured (vs. local disk). */
export function isLiveStorage(): boolean {
	return !!process.env.S3_BUCKET
}

/** A stable-for-the-process signing secret for local-disk signed URLs. Set
 * `STORAGE_SIGNING_SECRET` for a secret that survives restarts/deploys (a
 * fresh random one otherwise still works — it just invalidates any signed
 * URLs handed out before the last restart). */
function localSigningSecret(): string {
	if (process.env.STORAGE_SIGNING_SECRET) {
		return process.env.STORAGE_SIGNING_SECRET
	}
	storageScope.__maxstackStorageSigningSecret ??= crypto.randomUUID()
	return storageScope.__maxstackStorageSigningSecret
}

/**
 * The storage provider for this app: the live S3-compatible adapter when
 * `S3_BUCKET` is set, else the local-disk provider rooted at
 * `<dataDir>/uploads`. A singleton on `globalThis` so HMR / repeated calls
 * within one process share the same signing secret and on-disk root.
 */
export function getStorageProvider(): StorageProvider {
	if (storageScope.__maxstackStorageProvider) {
		return storageScope.__maxstackStorageProvider
	}
	const provider = isLiveStorage()
		? createS3StorageProvider({
				bucket: process.env.S3_BUCKET as string,
				region: process.env.S3_REGION,
				endpoint: process.env.S3_ENDPOINT,
				accessKeyId: process.env.S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
				forcePathStyle: !!process.env.S3_FORCE_PATH_STYLE,
				publicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
			})
		: createLocalStorageProvider({
				dir: uploadsDir(resolveDataDir() ?? process.cwd()),
				secret: localSigningSecret(),
				urlPrefix: '/files',
			})
	storageScope.__maxstackStorageProvider = provider
	return provider
}

/** The upload size/type limits this app enforces — the task-60 default
 * (10MB, common image/doc types). Exposed so callers can override per-field
 * via `FormFileInput`'s `maxSize`/`accept` without changing the server wall. */
export function uploadLimits(): UploadLimits {
	return DEFAULT_UPLOAD_LIMITS
}

/**
 * Mint the URL a page renders for a stored key.
 *
 * Always the app's own `/files/:key` gateway, for **every** driver — never a
 * raw presigned S3 URL. That is what keeps local disk and S3 from diverging on
 * the one axis that matters: with a presigned URL the object store decides who
 * may read, and it will happily serve anyone holding the link; with the gateway
 * this app decides, before a byte moves.
 *
 * `subject` is the viewer this URL is for, taken from the session. It is bound
 * into the signature and never appears in the URL.
 *
 * The caller must already have read the owning row through the access-checked
 * read path — minting a URL *is* the authorization decision, and the token then
 * carries it for its (short) lifetime.
 */
export function signedFileUrl(
	key: string,
	subject: string | null,
	expiresInSeconds?: number,
): string {
	return fileGatewayUrl({
		secret: localSigningSecret(),
		key,
		subject,
		prefix: FILE_GATEWAY_PREFIX,
		expiresInSeconds,
	})
}

/**
 * Verify a `/files/:key` request for the viewer making it. Unlike the previous
 * key-and-expiry-only check, this refuses a link copied out of somebody else's
 * page — the token is bound to a viewer.
 *
 * Applies to every driver: the gateway authorizes, then reads bytes back
 * through `getStorageProvider().read()`, whichever store that is.
 */
export function verifyFileReadToken(
	key: string,
	subject: string | null,
	exp: string | null,
	sig: string | null,
) {
	return verifyReadToken({
		secret: localSigningSecret(),
		key,
		subject,
		exp,
		sig,
	})
}

/**
 * The image transformer used for spec-declared derivatives. `sharp` is an
 * optional dependency loaded on first resize, so binding this unconditionally
 * costs nothing at boot; a project whose spec declares no derivatives never
 * touches it. `assertTransformerForDerivatives` is what turns a *missing*
 * transformer into a boot error rather than a silently absent thumbnail.
 */
export function getImageTransformer(): ImageTransformer {
	storageScope.__maxstackImageTransformer ??= createSharpImageTransformer()
	return storageScope.__maxstackImageTransformer
}

/** The local-disk uploads directory for this app (only meaningful when
 * `isLiveStorage()` is false). */
export function localUploadsDir(): string {
	return uploadsDir(resolveDataDir() ?? process.cwd())
}
