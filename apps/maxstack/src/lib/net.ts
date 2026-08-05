/**
 * Loopback port probing — the one implementation.
 *
 * Three copies of this had accumulated (`dev`'s pre-flight refusal, `doctor`'s
 * dev-server liveness check, and `demo`'s stale-record fallback), which is how
 * the IPv6 bug got fixed in one of them and not the others: a squatter holding a
 * port on `::1` only slipped past an IPv4-only probe, and `dev` proceeded to die
 * on vite's `strictPort` bind instead of failing with the message that names the
 * cause. Preflight needs the same probe again, so it lives here.
 *
 * Issue #281: a bind probe alone is not enough, because on BSD/macOS a
 * *specific* address and a *wildcard* address can hold the same port at once.
 * A server on `::`/`0.0.0.0` therefore answers `localhost:3000` while a probe
 * that binds `127.0.0.1:3000` succeeds and reports the port free. That is how a
 * second `maxstack dev` got past the refusal and landed two servers on one
 * single-writer data dir. So the question is asked both ways round.
 */

import { createConnection, createServer } from 'node:net'

/** The loopback addresses a listener can hide on, and a client can arrive on. */
const LOOPBACK = ['127.0.0.1', '::1'] as const

/** How long a connect probe waits before calling a host unreachable. Loopback
 * either answers immediately or refuses immediately; the timeout exists only so
 * a black-holed address cannot hang `dev` before it has printed anything. */
const CONNECT_TIMEOUT_MS = 500

/**
 * Whether `port` is already taken on localhost — by anything, bound any way.
 *
 * Two probes, because they miss different squatters and `dev` cannot afford
 * either miss:
 *
 *   - **bind** (`hostPortInUse`) — "could I listen here?" Catches a listener on
 *     the same specific address, and a privileged port this user may not have.
 *   - **connect** (`hostPortReachable`) — "would a client reach someone else?"
 *     Catches the wildcard listener the bind probe is blind to, and it is the
 *     question that actually matters: `.mcp.json`, a demo seed and every open
 *     tab address this port by name, so a port that already answers on loopback
 *     is not ours even when we *can* also bind it.
 *
 * Reports busy if either probe says so, on either stack.
 *
 * The connect probes run **first, and to completion**, rather than in one
 * `Promise.all` with the bind probes. Overlapping them is a race against
 * ourselves: the bind probe legitimately takes `127.0.0.1:<port>` for a moment
 * (that is the whole #281 asymmetry), so a connect probe in flight can land on
 * *our own* transient listener and then be refused when it closes — a wildcard
 * squatter that reports free perhaps one run in three.
 */
export async function portInUse(port: number): Promise<boolean> {
	const reachable = await Promise.all(
		LOOPBACK.map((host) => hostPortReachable(host, port)),
	)
	if (reachable.some(Boolean)) return true
	const bound = await Promise.all(
		LOOPBACK.map((host) => hostPortInUse(host, port)),
	)
	return bound.some(Boolean)
}

/**
 * Whether `port` is bound on one specific host. A host family that isn't
 * available at all (IPv6 disabled) counts as free on that stack rather than as
 * an error — the question being asked is "can I bind here", and on a
 * single-stack machine the answer for the missing stack is irrelevant.
 *
 * Note the asymmetry this function cannot see: a wildcard listener does
 * not make a specific-address bind fail on BSD/macOS, so a `false` here means
 * "nothing is bound to *this address*", never "nothing is serving this port".
 * Pair it with {@link hostPortReachable}.
 */
export function hostPortInUse(host: string, port: number): Promise<boolean> {
	return new Promise((res) => {
		const probe = createServer()
		probe.once('error', (err: NodeJS.ErrnoException) =>
			res(err.code === 'EADDRINUSE' || err.code === 'EACCES'),
		)
		probe.once('listening', () => probe.close(() => res(false)))
		probe.listen(port, host)
	})
}

/**
 * Whether something accepts a TCP connection at `host:port` — the client's-eye
 * view, which is the one a wildcard listener is visible from.
 *
 * A refused connection (nothing there) and an unreachable family (IPv6 disabled)
 * are both "free": the probe answers for the address it was given and lets the
 * caller union the stacks, exactly as the bind probe does.
 */
export function hostPortReachable(host: string, port: number): Promise<boolean> {
	return new Promise((res) => {
		const socket = createConnection({ host, port })
		const settle = (taken: boolean) => {
			socket.destroy()
			res(taken)
		}
		socket.setTimeout(CONNECT_TIMEOUT_MS)
		socket.once('connect', () => settle(true))
		socket.once('timeout', () => settle(false))
		socket.once('error', () => settle(false))
	})
}
