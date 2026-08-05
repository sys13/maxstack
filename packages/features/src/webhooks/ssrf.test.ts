/**
 * Issue #185's first gating clause: *"outbound webhooks are an SSRF and
 * data-exfiltration surface. Subscriber URLs must be validated against internal
 * address ranges."*
 *
 * The tests are organized around **how this check is normally bypassed**, not
 * around the ranges themselves. A validator that rejects `127.0.0.1` and accepts
 * `2130706433` has not rejected loopback; it has rejected one spelling of it.
 */

import { describe, expect, it } from 'vitest'
import {
	assertPublicUrl,
	checkPublicUrl,
	isPrivateHost,
	SsrfRefusedError,
} from './ssrf.ts'

const refused = async (url: string, policy = {}) => {
	const result = await checkPublicUrl(url, policy)
	if (result.ok) throw new Error(`expected "${url}" to be refused`)
	return result
}

describe('schemes and shapes', () => {
	it('allows an ordinary https URL', async () => {
		await expect(
			assertPublicUrl('https://hooks.example.com/inbound'),
		).resolves.toBeInstanceOf(URL)
	})

	it('refuses every scheme but https by default', async () => {
		for (const url of [
			'http://example.com/hook',
			'file:///etc/passwd',
			'gopher://example.com',
			'ftp://example.com',
		]) {
			expect((await refused(url)).reason).toBe('scheme')
		}
	})

	it('allows http only when a policy explicitly opts in', async () => {
		await expect(
			assertPublicUrl('http://example.com/hook', { allowHttp: true }),
		).resolves.toBeInstanceOf(URL)
	})

	it('refuses embedded credentials', async () => {
		// They would be written into the delivery log and replayed on every retry.
		expect((await refused('https://user:pass@example.com/h')).reason).toBe(
			'credentials',
		)
	})

	it('refuses a port that is not a web server', async () => {
		// `https://internal-db:5432` is a port scan with a retry policy.
		expect((await refused('https://example.com:5432/h')).reason).toBe('port')
		expect((await refused('https://example.com:22/h')).reason).toBe('port')
	})

	it('refuses a string that is not a URL at all', async () => {
		expect((await refused('not a url')).reason).toBe('not-a-url')
	})
})

describe('internal address ranges — including the spellings that usually get through', () => {
	const privateUrls = [
		'https://127.0.0.1/h',
		'https://localhost/h',
		'https://api.localhost/h',
		'https://thing.internal/h',
		'https://printer.local/h',
		'https://10.0.0.5/h',
		'https://172.16.4.1/h',
		'https://172.31.255.254/h',
		'https://192.168.1.1/h',
		'https://169.254.169.254/latest/meta-data/', // the cloud metadata endpoint
		'https://100.64.0.1/h', // CGNAT
		'https://0.0.0.0/h',
		'https://[::1]/h',
		'https://[fe80::1]/h',
		'https://[fd00::1]/h',
	]

	for (const url of privateUrls) {
		it(`refuses ${url}`, async () => {
			expect((await refused(url)).reason).toBe('private-address')
		})
	}

	it('refuses the decimal, octal and hex spellings of loopback', async () => {
		// 2130706433 === 0x7f000001 === 0177.0.0.1 === 127.0.0.1. A validator that
		// only string-matches "127." lets all three of these through.
		for (const host of ['2130706433', '0x7f000001', '0177.0.0.1']) {
			expect((await refused(`https://${host}/h`)).reason).toBe(
				'private-address',
			)
		}
	})

	it('refuses IPv4-mapped IPv6 loopback in both spellings', async () => {
		expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
		expect(isPrivateHost('::ffff:7f00:1')).toBe(true)
	})

	it('still allows a genuinely public address', async () => {
		await expect(
			assertPublicUrl('https://93.184.216.34/h'),
		).resolves.toBeTruthy()
	})
})

describe('DNS rebinding', () => {
	it('refuses a public-looking name that resolves to an internal address', async () => {
		// The whole reason the check is re-run before every delivery: the name
		// passed at subscribe time and now points at the metadata endpoint.
		const result = await refused('https://rebind.example.com/h', {
			resolve: async () => ['169.254.169.254'],
		})
		expect(result.reason).toBe('private-address')
		expect(result.message).toMatch(/resolves to the internal address/)
	})

	it('refuses a name that resolves to nothing rather than trying anyway', async () => {
		expect(
			(await refused('https://nope.example.com/h', { resolve: async () => [] }))
				.reason,
		).toBe('unresolvable')
		expect(
			(
				await refused('https://nope.example.com/h', {
					resolve: async () => {
						throw new Error('NXDOMAIN')
					},
				})
			).reason,
		).toBe('unresolvable')
	})

	it('refuses when ANY resolved address is internal, not just the first', async () => {
		// A split-horizon answer with one public and one internal address is the
		// interesting case; checking `addresses[0]` would pass it.
		await expect(
			assertPublicUrl('https://mixed.example.com/h', {
				resolve: async () => ['93.184.216.34', '10.0.0.1'],
			}),
		).rejects.toBeInstanceOf(SsrfRefusedError)
	})

	it('accepts a name that resolves entirely to public addresses', async () => {
		await expect(
			assertPublicUrl('https://ok.example.com/h', {
				resolve: async () => ['93.184.216.34'],
			}),
		).resolves.toBeTruthy()
	})
})

describe('the escape hatch is explicit', () => {
	it('allows a named internal host only when the policy names it', async () => {
		await expect(
			assertPublicUrl('https://localhost:8080/h', {
				allowHosts: ['localhost'],
			}),
		).resolves.toBeTruthy()
		// …and not otherwise.
		expect((await refused('https://localhost:8080/h')).reason).toBe(
			'private-address',
		)
	})
})
