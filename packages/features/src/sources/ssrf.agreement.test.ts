/**
 * The two halves of the SSRF check must agree.
 *
 * `@maxstack/spec`'s `isPrivateHostLiteral` refuses an internal address at
 * **declaration** time — inside `validateOp`, where a DNS lookup would be
 * unthinkable. `@maxstack/features`'s `isPrivateHost` refuses one at **request**
 * time, where a resolver is available and the rebinding case is real.
 *
 * They cannot be one function: `@maxstack/spec` sits below `@maxstack/features`
 * in the package graph, and importing upward would be a cycle. So the
 * duplication is deliberate — and this file is the price of it. Without it the
 * two drift, and the drift is invisible until a spec accepts an endpoint the
 * runtime then refuses on every single fetch (or, far worse, the other way
 * round).
 *
 * This is the same device `slots.agreement.test.ts` uses to pin the harness's
 * own slot fold against the platform's discovery surface.
 */

import { isPrivateHostLiteral } from '@maxstack/spec'
import { describe, expect, it } from 'vitest'
import { isPrivateHost } from '../webhooks/ssrf.ts'

/**
 * One table, every bypass spelling. Organized by *how the check is normally
 * evaded* rather than by address family — a table grouped by family invites
 * somebody to add an IPv4 row and think the IPv6 spelling of it is covered.
 */
const HOSTS: readonly string[] = [
	// loopback, in every spelling a resolver accepts
	'127.0.0.1',
	'127.1',
	'2130706433',
	'0x7f.0.0.1',
	'0177.0.0.1',
	'localhost',
	'app.localhost',
	'LOCALHOST.',
	'::1',
	'[::1]',
	'::ffff:127.0.0.1',
	'::ffff:7f00:1',
	// the cloud metadata endpoint and the rest of link-local
	'169.254.169.254',
	'169.254.0.1',
	'fe80::1',
	// RFC1918 and its edges
	'10.0.0.1',
	'172.15.0.1',
	'172.16.0.1',
	'172.31.255.255',
	'172.32.0.1',
	'192.168.0.1',
	'192.0.0.1',
	// CGNAT, benchmarking, multicast, "this network", broadcast
	'100.64.0.1',
	'100.128.0.1',
	'198.18.0.1',
	'224.0.0.1',
	'0.0.0.0',
	'255.255.255.255',
	// unique-local IPv6
	'fd00::1',
	'fc00::1',
	// names that are internal by convention
	'db.internal',
	'printer.local',
	// genuinely public
	'openlibrary.org',
	'api.github.com',
	'8.8.8.8',
	'1.1.1.1',
	'2606:4700::1111',
]

describe('declaration-time and request-time host checks agree', () => {
	it.each(HOSTS)('%s', (host) => {
		expect(isPrivateHostLiteral(host)).toBe(isPrivateHost(host))
	})

	it('is not vacuous — the table contains both answers', () => {
		const refused = HOSTS.filter(isPrivateHostLiteral)
		expect(refused.length).toBeGreaterThan(20)
		expect(HOSTS.length - refused.length).toBeGreaterThan(3)
	})
})
