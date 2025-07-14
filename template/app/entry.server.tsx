import { createReadableStreamFromReadable } from '@react-router/node'
import { isbot } from 'isbot'
import { handlers } from 'mocks/resend'
import { startApiMocks } from 'mocks/server'
import { PassThrough } from 'node:stream'
import type { RenderToPipeableStreamOptions } from 'react-dom/server'
import { renderToPipeableStream } from 'react-dom/server'
import type { AppLoadContext, EntryContext } from 'react-router'
import { ServerRouter } from 'react-router'

if (process.env.NODE_ENV === 'development' || process.env.MOCKS === 'true') {
	startApiMocks(handlers)
}

export const streamTimeout = 5_000

export default async function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext,
	_loadContext: AppLoadContext,
	// If you have middleware enabled:
	// loadContext: unstable_RouterContextProvider
) {
	// Initialize MSW if mocks=true in search params
	const url = new URL(request.url)
	if (url.searchParams.get('mocks') === 'true') {
		startApiMocks(handlers)
	}

	return new Promise((resolve, reject) => {
		let shellRendered = false
		// biome-ignore lint/style/useConst: default
		let userAgent = request.headers.get('user-agent')

		// Ensure requests from bots and SPA Mode renders wait for all content to load before responding
		// https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
		// biome-ignore lint/style/useConst: default
		let readyOption: keyof RenderToPipeableStreamOptions =
			(userAgent && isbot(userAgent)) || routerContext.isSpaMode
				? 'onAllReady'
				: 'onShellReady'

		const { pipe, abort } = renderToPipeableStream(
			<ServerRouter context={routerContext} url={request.url} />,
			{
				[readyOption]() {
					shellRendered = true
					const body = new PassThrough()
					const stream = createReadableStreamFromReadable(body)

					responseHeaders.set('Content-Type', 'text/html')

					resolve(
						new Response(stream, {
							headers: responseHeaders,
							status: responseStatusCode,
						}),
					)

					pipe(body)
				},
				onShellError(error: unknown) {
					reject(error)
				},
				onError(error: unknown) {
					responseStatusCode = 500
					// Log streaming rendering errors from inside the shell.  Don't log
					// errors encountered during initial shell rendering since they'll
					// reject and get logged in handleDocumentRequest.
					if (shellRendered) {
						console.error(error)
					}
				},
			},
		)

		// Abort the rendering stream after the `streamTimeout` so it has time to
		// flush down the rejected boundaries
		setTimeout(abort, streamTimeout + 1000)
	})
}
