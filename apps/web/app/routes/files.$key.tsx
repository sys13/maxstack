/**
 * `GET /files/:key` — the read gateway for stored files.
 *
 * Every driver's bytes come through here. Not just local disk: an S3-backed
 * deployment routes reads through this route too, because a presigned S3 URL is
 * a bearer credential the object store honors for anyone holding it, and the
 * issue's requirement is that a file attached to a row the caller cannot see is
 * not fetchable *including via a guessable URL*. Authorization has to happen
 * somewhere this app controls, and this is that place — which also means local
 * dev and a Docker deploy behave identically on read rather than diverging on
 * the security-relevant path.
 *
 * Two checks, in order:
 *
 *  1. **The token is valid for *this* viewer.** `verifyFileReadToken` re-derives
 *     the subject from the session, never from the URL, so a link copied out of
 *     someone else's page is refused. The key is inside the MAC, so guessing a
 *     key gets you nothing.
 *  2. **The object exists.** `provider.read()` returns `null` rather than
 *     throwing for a missing key on every driver (asserted by the parity suite),
 *     so a missing file is a 404 here and not a 500 in production only.
 *
 * The `Content-Type` served is the one the upload path validated, recorded on
 * the object — never re-sniffed from the bytes at read time.
 */

import { resolveUser } from '~/sprout.server'
import { getStorageProvider, verifyFileReadToken } from '~/storage.server'
import type { Route } from './+types/files.$key'

export async function loader({ params, request }: Route.LoaderArgs) {
	const key = params.key
	if (!key) throw new Response('Not found', { status: 404 })

	const url = new URL(request.url)
	const user = await resolveUser(request)
	const verdict = verifyFileReadToken(
		key,
		user?.id ?? null,
		url.searchParams.get('exp'),
		url.searchParams.get('sig'),
	)
	if (!verdict.ok) {
		// Deliberately one message for every refusal. Distinguishing "expired"
		// from "not yours" from "forged" back to the caller would confirm that a
		// key exists, which is the probe this route must not answer.
		throw new Response('Invalid or expired link', { status: 403 })
	}

	const object = await getStorageProvider().read(key)
	if (!object) throw new Response('Not found', { status: 404 })

	return new Response(new Uint8Array(object.bytes), {
		headers: {
			'Content-Type': object.contentType,
			'Content-Length': String(object.size),
			// `private` matters: the URL is viewer-bound, so a shared cache must
			// never serve one viewer's response to another. `max-age` is short
			// enough to stay inside the token's own lifetime.
			'Cache-Control': 'private, max-age=60',
			// Untrusted bytes served from our origin. Nothing here should ever be
			// interpreted as a document, whatever the recorded content type says.
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox",
		},
	})
}
