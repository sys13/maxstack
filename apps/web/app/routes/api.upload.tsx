/**
 * `POST /api/upload` — the write half of declared file fields.
 *
 * The important change from the task-60 endpoint this replaces: the limits it
 * enforces come from the **spec declaration of the target field**, looked up
 * server-side from `resource` + `field` in the body, not from one app-wide
 * default. A 200KB avatar field and a 10MB attachment field get their own
 * walls, and neither can be widened by anything the client sends — the form
 * fields are only used to *find* the declaration, never to supply it.
 *
 * What the route guarantees, in order:
 *
 *  1. Authenticated, rate-limited (uploads are the most expensive request this
 *     app serves) and observable, as before.
 *  2. The target is a real, declared `file` column. An upload aimed at a column
 *     that is not one is refused — there is no "general purpose blob dump" here.
 *  3. Size and MIME are re-validated server-side against that column's
 *     declaration. The widget's client-side check is a UX nicety, not a trust
 *     boundary.
 *  4. The storage key is minted from the **validated content type**, never from
 *     the uploaded filename, so `avatar.png.php` and `../../etc/passwd` are both
 *     inert by construction.
 *  5. Declared derivatives are materialized. A derivative that fails is logged
 *     and omitted — it never costs the user their upload.
 *  6. A `file_object` row records what was stored, for the read gateway's
 *     content type and for the orphan report.
 *
 * The response returns the storage **key** as the value the form should submit.
 * The previous version returned the signed URL, which meant a row stored a
 * string that expired; the column now holds a key and the read path re-signs it
 * on every render.
 *
 * This route returns `data()` (a `DataWithResponseInit`), not a `Response`, so
 * it uses the observability primitives directly rather than
 * `withRequestObservability` (which expects a real `Response`).
 */

import type { SproutColumn } from '@maxstack/core'
import { logRequest, nextRequestId } from '@maxstack/features/observability'
import {
	fileObjectRow,
	limitsForField,
	makeStorageKey,
	materializeDerivatives,
	validateUpload,
} from '@maxstack/features/storage'
import { data } from 'react-router'
import { checkRateLimit, getErrorReporter } from '~/observability.server'
import { getSprout, resolveUser } from '~/sprout.server'
import {
	getImageTransformer,
	getStorageProvider,
	signedFileUrl,
} from '~/storage.server'
import type { Route } from './+types/api.upload'

/** The registry entry for `file_object`, when the storage bundle is installed. */
const FILE_OBJECT_RESOURCE = 'file_object'

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return data({ error: 'Method not allowed' }, { status: 405 })
	}
	const user = await resolveUser(request)
	const { denied } = await checkRateLimit(request, user)
	if (denied) return denied

	const requestId = nextRequestId()
	const startedAt = Date.now()
	const path = new URL(request.url).pathname
	try {
		const result = await handleUpload(request, user?.id ?? null)
		logRequest({
			requestId,
			method: request.method,
			path,
			status: result.init?.status ?? 200,
			durationMs: Date.now() - startedAt,
			userId: user?.id ?? null,
		})
		return result
	} catch (err) {
		getErrorReporter().capture(err, { requestId, method: request.method, path })
		logRequest({
			requestId,
			method: request.method,
			path,
			status: 500,
			durationMs: Date.now() - startedAt,
			userId: user?.id ?? null,
		})
		throw err
	}
}

/**
 * Resolve `resource` + `field` to the declared file column, or explain why not.
 *
 * Every failure here is a 400 rather than a fallback to a permissive default:
 * an upload with no declaration behind it is an upload with no allowlist and no
 * cap, which is exactly the thing this issue exists to make impossible.
 */
async function resolveFileColumn(
	resource: string | null,
	field: string | null,
): Promise<{ column: SproutColumn } | { error: string }> {
	if (!resource || !field) {
		return {
			error:
				'Upload needs a "resource" and a "field" naming the declared file field it is for.',
		}
	}
	const { registry } = await getSprout()
	const entry = registry.get(resource)
	if (!entry) return { error: `Unknown resource "${resource}".` }

	const column = entry.resource.columns.find((c) => c.name === field)
	if (!column) return { error: `Unknown field "${resource}.${field}".` }
	if (column.meta.isFile !== true) {
		return { error: `"${resource}.${field}" is not a file field.` }
	}
	return { column }
}

async function handleUpload(request: Request, userId: string | null) {
	if (!userId) {
		return data({ error: 'Sign in to upload files.' }, { status: 401 })
	}

	let form: FormData
	try {
		form = await request.formData()
	} catch {
		return data(
			{ error: 'Expected a multipart/form-data body.' },
			{ status: 400 },
		)
	}

	const file = form.get('file')
	if (!(file instanceof File)) {
		return data({ error: 'Missing "file" field.' }, { status: 400 })
	}

	const target = await resolveFileColumn(
		asString(form.get('resource')),
		asString(form.get('field')),
	)
	if ('error' in target) return data({ error: target.error }, { status: 400 })
	const { column } = target

	// The declaration is the wall. `fileAccept` and `fileMaxSize` were put on the
	// column by the spec→Sprout bridge from the field's `file` block; nothing in
	// this request can widen them.
	const declared = {
		accept: (column.meta.fileAccept ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
		maxSizeBytes: column.meta.fileMaxSize ?? 0,
	}
	if (declared.accept.length === 0 || declared.maxSizeBytes <= 0) {
		// Unreachable from a validated spec (`fieldFileErrors` requires both), so
		// this is a "the invariant broke" answer, not a policy decision made here.
		return data(
			{
				error: `"${column.name}" has no upload allowlist or size cap declared; refusing to accept bytes.`,
			},
			{ status: 500 },
		)
	}

	const contentType = file.type || 'application/octet-stream'
	const validation = validateUpload(
		contentType,
		file.size,
		limitsForField(declared),
	)
	if (!validation.ok) {
		return data({ error: validation.error }, { status: 400 })
	}

	const bytes = new Uint8Array(await file.arrayBuffer())
	// Key from the *validated* content type. `file.name` is carried through as a
	// display name only, and never touches the key.
	const key = makeStorageKey(file.name, contentType)
	const provider = getStorageProvider()
	const stored = await provider.put(key, bytes, contentType)

	// The original is durable before any derivative is attempted, so a resize
	// failure can only cost the variant.
	const derivatives = await materializeDerivatives({
		provider,
		transformer: getImageTransformer(),
		original: stored,
		bytes,
		derivatives: column.meta.fileDerivatives ?? [],
		onError: (name, error) =>
			getErrorReporter().capture(error, {
				derivative: name,
				key: stored.key,
				resource: column.meta.fileResource ?? null,
			}),
	})

	await recordFileObject({
		key: stored.key,
		contentType: stored.contentType,
		size: stored.size,
		originalName: file.name,
		uploadedBy: userId,
		resource: column.meta.fileResource ?? null,
		field: column.name,
		derivatives,
	})

	return data({
		// The value the form submits and the column stores: a key, not a URL.
		key: stored.key,
		// A viewer-bound preview URL for rendering right now. Short-lived by
		// design — the read path re-signs on every render rather than persisting
		// this string anywhere.
		url: signedFileUrl(stored.key, userId),
		name: file.name,
		size: stored.size,
		contentType: stored.contentType,
		derivatives: derivatives.map((d) => ({
			name: d.name,
			url: signedFileUrl(d.key, userId),
		})),
	})
}

const asString = (value: FormDataEntryValue | null): string | null =>
	typeof value === 'string' && value.trim() ? value.trim() : null

/**
 * Record the upload in the `file_object` registry, if the storage bundle is
 * installed. Best-effort on purpose: the bytes are already durable, and failing
 * the request after a successful write would tell the user their upload failed
 * when it did not. A registry miss shows up in the orphan report as a dangling
 * reference, which is precisely the signal that wants a human.
 */
async function recordFileObject(
	row: Parameters<typeof fileObjectRow>[0],
): Promise<void> {
	try {
		const { registry, store } = await getSprout()
		if (!registry.get(FILE_OBJECT_RESOURCE)) return
		await store.create(FILE_OBJECT_RESOURCE, {
			...fileObjectRow(row),
			// jsonb column; the store serializes it.
			derivatives: row.derivatives ?? [],
		})
	} catch (error) {
		getErrorReporter().capture(error, { at: 'file_object registry write' })
	}
}
