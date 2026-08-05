/**
 * Port probing.
 *
 * These use real sockets on real ports rather than a mock, because the bug being
 * pinned *is* the operating system's bind semantics: a mocked `createServer`
 * would have happily reported the wildcard squatter that the real one cannot
 * see. Ports are taken from a high range and released in `afterEach`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { hostPortInUse, hostPortReachable, portInUse } from './net.ts'

/** Every squatter this file started, so a failed expectation still frees them. */
const open: Server[] = []

async function squat(port: number, host: string): Promise<void> {
	const server = createServer()
	open.push(server)
	await new Promise<void>((res, rej) => {
		server.once('error', rej)
		server.listen(port, host, () => res())
	})
}

afterEach(async () => {
	await Promise.all(
		open.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))),
	)
})

/** A port in the ephemeral-ish range, unique per test so a lingering TIME_WAIT
 * socket from an earlier case cannot make a later one flaky. */
let next = 39400
const freePort = () => (next += 1)

describe('portInUse', () => {
	it('is false for a port nobody holds', async () => {
		await expect(portInUse(freePort())).resolves.toBe(false)
	})

	it.each([
		['127.0.0.1', 'IPv4 loopback'],
		['::1', 'IPv6 loopback'],
	])('sees a squatter on %s (%s)', async (host) => {
		const port = freePort()
		await squat(port, host)
		await expect(portInUse(port)).resolves.toBe(true)
	})

	// The regression. A wildcard listener answers `localhost:<port>` while
	// leaving every *specific* loopback address bindable on BSD/macOS, so the
	// bind-only probe reported the port free and `dev` started a second server
	// over a single-writer data dir.
	it.each([
		['0.0.0.0', 'IPv4 wildcard'],
		['::', 'IPv6 wildcard'],
	])('sees a squatter on %s (%s)', async (host) => {
		const port = freePort()
		await squat(port, host)
		await expect(portInUse(port)).resolves.toBe(true)
	})
})

describe('hostPortReachable', () => {
	// Every platform, no caveat: the connect probe is the one that answers the
	// question `portInUse` actually needs — "would a client aimed at loopback
	// reach someone else's server?" — for a listener bound any way at all.
	it('reaches a wildcard squatter through IPv4 loopback', async () => {
		const port = freePort()
		await squat(port, '::')
		await expect(hostPortReachable('127.0.0.1', port)).resolves.toBe(true)
	})

	it('is false for a port nobody holds', async () => {
		await expect(hostPortReachable('127.0.0.1', freePort())).resolves.toBe(
			false,
		)
	})

	// The *gap* this probe exists to close is BSD-shaped, so the assertion that
	// demonstrates it has to be too. On BSD/macOS a `::` listener leaves
	// `127.0.0.1` bindable, so the bind probe reports free while the squatter is
	// serving. Linux binds `::` dual-stack by default (`net.ipv6.bindv6only=0`),
	// so there the bind probe already fails and there is no gap to show — which
	// is why this ran green locally and red on CI the first time.
	//
	// `portInUse` is asserted unconditionally above on all four squatter shapes;
	// that is the behavioral guarantee. This case only pins the mechanism, and a
	// mechanism that does not exist on the platform cannot be pinned there.
	const BSD = process.platform === 'darwin' || process.platform.endsWith('bsd')
	it.runIf(BSD)('on BSD, the bind probe alone goes blind to it', async () => {
		const port = freePort()
		await squat(port, '::')
		await expect(hostPortInUse('127.0.0.1', port)).resolves.toBe(false)
		await expect(hostPortReachable('127.0.0.1', port)).resolves.toBe(true)
	})
})
