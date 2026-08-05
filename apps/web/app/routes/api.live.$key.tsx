/**
 * `GET /api/live/:key` — a declared live channel, as Server-Sent Events
 *. `?poll=1` on the same route is the fallback.
 *
 * ## Why SSE and not a WebSocket
 *
 * The issue's gating requires the transport to work in the existing
 * single-container deploy (`maxstack deploy` → `docker run -p`, or Fly), or for
 * the change to be recorded as a decision. It does, and this is why:
 *
 *  - **SSE is a long-lived GET on the HTTP server that already exists.** There
 *    is no second server object, no `upgrade` handler, and nothing for a proxy
 *    to negotiate. `apps/web` is served by `react-router-serve`, which exposes
 *    no `upgrade` hook at all — a WebSocket would mean replacing the server
 *    entry, which is a change to how every deployment starts.
 *  - **It survives the deploy path unchanged.** `docker run -p 3000:3000` and
 *    Fly's `[http_service]` both forward an ordinary HTTP request; a WebSocket
 *    additionally needs the upgrade to survive whatever proxy fronts the
 *    container, which is one more thing that is fine until it is not.
 *  - **It reconnects on its own.** `EventSource` retries with `Last-Event-ID`
 *    without the client writing a reconnection loop — and a reconnection loop
 *    nobody wrote is a reconnection loop nobody got wrong.
 *
 * The cost is real and worth naming: SSE is one-directional, so a presence
 * heartbeat is a separate `POST` rather than a frame on the same socket. That is
 * an acceptable trade for a primitive whose scope line is "we push changes and
 * we report presence" — nothing here needs a client→server stream.
 *
 * ## This route decides nothing
 *
 * **No filtering, no column selection, no access check.** It resolves the
 * channel through `liveRequest`, builds a subscriber over the caller's *own*
 * context, and hands it to `LiveChannel`, which authorizes every message through
 * `opList`. A test asserts this module does not reach the store, the registry or
 * the permission layer — the mechanical version of the paragraph, and the same
 * assertion the portal routes carry.
 */

import { type LiveMessage, liveIdentityOf, pollLive } from '@maxstack/core'
import { liveRequest } from '~/live.server'
import type { Route } from './+types/api.live.$key'

/** One SSE frame. `id:` is what `EventSource` replays as `Last-Event-ID`. */
function frame(message: LiveMessage, seq: number): string {
	return `id: ${seq}\ndata: ${JSON.stringify(message)}\n\n`
}

/** A close, always with a stated reason. Never a silent hang-up. */
function closeFrame(reason: string): string {
	return `event: close\ndata: ${JSON.stringify({ reason })}\n\n`
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const resolved = await liveRequest(request, params.key)
	// One 404 for every reason a channel is unreachable — unknown key, never
	// declared, not grounded. Distinguishing them would tell a caller which
	// channel keys exist.
	if (!resolved) throw new Response('Not found', { status: 404 })
	const { channel, ctx, scopeValue, rowId } = resolved
	const bound = {
		...(scopeValue !== undefined ? { scopeValue } : {}),
		...(rowId !== undefined ? { rowId } : {}),
	}

	// The polling fallback, served by the SAME route. A client that cannot hold
	// an EventSource open, or that was closed for `paused` or `rate-exceeded`,
	// asks for `?poll=1` and gets one page through `pollLive` — which is `opList`
	// with the channel's bound. It is the same op, so the two views cannot
	// disagree about what a subscriber may see.
	if (new URL(request.url).searchParams.get('poll') === '1') {
		const rows = await pollLive(
			channel.plan,
			{ id: 'poll', ctx, ...bound, send: () => {}, close: () => {} },
			channel.primaryKey,
		)
		return Response.json({
			rows,
			present: rowId ? channel.present(rowId, Date.now()).present : [],
			polling: true,
		})
	}

	let seq = 0
	// Hoisted so `cancel` can drop exactly THIS subscriber. Closing the whole
	// channel there would disconnect everybody else because one proxy hung up.
	const id = crypto.randomUUID()
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder()
			let open = true
			const write = (chunk: string) => {
				if (!open) return
				try {
					controller.enqueue(encoder.encode(chunk))
				} catch {
					// The client went away mid-write. The abort handler below removes the
					// subscriber; throwing here would be an unhandled rejection in a
					// stream nobody is reading.
					open = false
				}
			}
			const shut = () => {
				if (!open) return
				open = false
				try {
					controller.close()
				} catch {
					// Raced with another close path. Closing twice is not an error worth
					// surfacing to anybody.
				}
			}
			const result = channel.subscribe({
				id,
				ctx,
				...bound,
				send: (message) => {
					seq += 1
					write(frame(message, seq))
				},
				close: (reason) => {
					// Always stated. A client shed for `rate-exceeded` backs off; one
					// told `paused` polls instead; one told `permission-revoked` stops
					// asking rather than reconnecting in a loop.
					write(closeFrame(reason))
					shut()
				},
			})
			if (!result.ok) {
				write(closeFrame(result.reason))
				shut()
				return
			}
			// A client aborting is the ordinary end of a subscription, not an error.
			request.signal.addEventListener('abort', () => {
				channel.unsubscribe(id)
				shut()
			})
		},
		cancel() {
			// The stream was torn down without an abort (a proxy hang-up). The channel
			// must forget this subscriber either way, or a dead connection keeps
			// consuming one of the declared `maxSubscribers` slots forever.
			channel.unsubscribe(id)
		},
	})

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			// Long-lived and never cached. `X-Accel-Buffering` is the one header a
			// reverse proxy in front of the container actually needs: without it an
			// nginx-shaped proxy buffers the response and the whole stream arrives at
			// the end, which looks exactly like the feature not working.
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	})
}

/**
 * `POST /api/live/:key?row=<id>` — a presence heartbeat. `DELETE` leaves.
 *
 * A separate request rather than a frame, because SSE is one-directional. That
 * is the honest cost of the transport choice and it is small: one tiny POST per
 * TTL period per open record.
 *
 * The identity is **derived from the session**, never read from the body. A
 * client that could name its own presence identity could name somebody else's,
 * and "who is viewing this" would become "who says they are viewing this".
 */
export async function action({ request, params }: Route.ActionArgs) {
	const resolved = await liveRequest(request, params.key)
	if (!resolved) throw new Response('Not found', { status: 404 })
	const { channel, ctx } = resolved
	if (channel.plan.kind !== 'presence')
		throw new Response('Not a presence channel', { status: 400 })

	const rowId = new URL(request.url).searchParams.get('row')
	if (!rowId) throw new Response('row is required', { status: 400 })

	// The identity comes off the context `liveRequest` already resolved from the
	// session — never off the request body.
	const identity = liveIdentityOf(ctx.user)
	const now = Date.now()
	if (request.method === 'DELETE') channel.leave(rowId, identity)
	else channel.heartbeat(rowId, identity, now)
	return Response.json(channel.present(rowId, now))
}
