/**
 * Storage feature (task 60, promoted to a first-class bundle in issue #183) —
 * file and object storage as declared spec data rather than hand-wired plumbing.
 *
 * Four pieces, in the order a byte moves through them:
 *
 *   - `provider.ts` — the driver contract (`put`/`read`/`getSignedUrl`/`delete`),
 *     upload validation, and key minting. A key is a UUID plus an extension
 *     derived from the **validated content type**, never from the filename.
 *   - `derivatives.ts` — the `ImageTransformer` port and the materializer for
 *     spec-declared image variants (`<key>@thumb.png`). `sharp` is an optional
 *     dependency behind it; a spec that declares derivatives with nothing bound
 *     fails at boot, not at the first upload.
 *   - `access.ts` — viewer-bound, expiring read tokens. Every driver's bytes are
 *     served through the app's `/files/:key` gateway, which is where the
 *     authorization decision lives, so local disk and S3 do not diverge on read.
 *   - `objects.ts` — the `file_object` registry the bundle contributes, and the
 *     orphan *report* (never an automatic delete).
 *
 * `conformance.ts` is the parity suite all three drivers run, so "the dev driver
 * and the deploy driver behave identically" is a test rather than a promise. It
 * is deliberately **not** re-exported here: it imports `vitest` at module scope,
 * and this barrel is on the server's and the demo seeder's runtime path. The
 * three driver tests import it by relative path, which is the only consumer it
 * should ever have.
 */

export {
	ANONYMOUS_SUBJECT,
	DEFAULT_READ_TTL_SECONDS,
	type FileReadDenial,
	type FileReadVerdict,
	fileGatewayUrl,
	type MintReadTokenInput,
	mintReadToken,
	type ReadToken,
	type VerifyReadTokenInput,
	verifyReadToken,
} from './access.ts'
export {
	assertTransformerForDerivatives,
	createSharpImageTransformer,
	type ImageTransformer,
	type ImageTransformRequest,
	type ImageTransformResult,
	isResizableContentType,
	type MaterializedDerivative,
	materializeDerivatives,
	passthroughImageTransformer,
} from './derivatives.ts'
export type { LocalStorageOptions } from './local.ts'
export {
	createLocalStorageProvider,
	readLocalObject,
	uploadsDir,
	verifyLocalSignature,
} from './local.ts'
export { createMemoryStorageProvider } from './memory.ts'
export {
	type FileObjectRecord,
	fileObjectRow,
	findOrphanedObjects,
	type OrphanReport,
	recordKeys,
	referencedFileKeys,
} from './objects.ts'
export type {
	DeclaredFileField,
	SignedUrlOptions,
	StorageProvider,
	StoredBytes,
	StoredObject,
	UploadLimits,
	UploadValidationError,
	UploadValidationOk,
} from './provider.ts'
export {
	DEFAULT_UPLOAD_LIMITS,
	derivativeKey,
	extensionForContentType,
	formatBytes,
	limitsForField,
	makeStorageKey,
	parseDerivativeKey,
	validateUpload,
} from './provider.ts'
export type { S3StorageOptions } from './s3.ts'
export { createS3StorageProvider } from './s3.ts'
