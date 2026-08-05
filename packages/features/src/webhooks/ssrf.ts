/**
 * **Subscriber-URL validation**.
 *
 * An outbound webhook is a feature whose entire job is "let a user make this
 * server issue an HTTP request to a URL the user chose". That is the definition
 * of SSRF, so the URL is validated before it is ever stored, and again before
 * every delivery — because DNS is mutable and a hostname that resolved to a
 * public address at subscribe time can resolve to `169.254.169.254` an hour
 * later.
 *
 * ## What is refused, and why
 *
 * | Refused | Because |
 * |---|---|
 * | Any scheme but `https:` (and `http:` only when explicitly allowed) | `file:`, `gopher:` and friends are request forgery with extra steps. |
 * | Credentials in the URL (`https://u:p@host`) | The credentials would be logged and replayed on every retry. |
 * | Loopback, link-local, and every private range | The cloud metadata endpoint and every internal service live there. |
 * | A literal IP that parses into one of those ranges | Including the decimal, octal and IPv4-mapped-IPv6 spellings, which is how this check is normally bypassed. |
 * | A hostname that *resolves* into one of those ranges | The DNS-rebinding case, checked with an injected resolver at delivery time. |
 *
 * ## What this cannot do alone
 *
 * A pure-function check on a URL string cannot close the rebinding window on its
 * own: between the resolution this performs and the connection the HTTP client
 * makes, the answer can change. Closing it completely requires pinning the
 * resolved address into the connection, which is an agent-level concern in the
 * host runtime. {@link assertPublicUrl} narrows the window to near-zero and is
 * honest about the residual — see `docs/security-baseline.md`.
 */

/** Why a URL was refused. Machine-readable so a form can render a real message. */
export type SsrfRefusal =
	| 'not-a-url'
	| 'scheme'
	| 'credentials'
	| 'port'
	| 'private-address'
	| 'unresolvable'

export class SsrfRefusedError extends Error {
	readonly reason: SsrfRefusal

	constructor(reason: SsrfRefusal, message: string) {
		super(message)
		this.name = 'SsrfRefusedError'
		this.reason = reason
	}
}

/** Schemes a delivery may use. `http:` is opt-in, for a local dev receiver. */
const ALLOWED_SCHEMES = new Set(['https:'])

/**
 * Ports a delivery may target. Deliberately narrow: a subscriber endpoint is a
 * web server, and `https://internal-db:5432` is not a webhook receiver — it is a
 * port scan with a retry policy.
 */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443'])

/** Parse an IPv4 literal in any of the spellings `inet_aton` accepts. */
function parseIpv4(host: string): number[] | null {
	const parts = host.split('.')
	// The dotted-quad case, plus the decimal/octal/hex spellings of each octet.
	if (parts.length === 4) {
		const octets = parts.map(parseNumeric)
		if (octets.every((o) => o !== null && o >= 0 && o <= 255))
			return octets as number[]
		return null
	}
	// A single number is a valid IPv4 address to most resolvers: 2130706433 is
	// 127.0.0.1. Skipping this is the classic bypass.
	if (parts.length === 1) {
		const value = parseNumeric(host)
		if (value === null || value < 0 || value > 0xff_ff_ff_ff) return null
		return [
			(value >>> 24) & 0xff,
			(value >>> 16) & 0xff,
			(value >>> 8) & 0xff,
			value & 0xff,
		]
	}
	return null
}

function parseNumeric(text: string): number | null {
	if (!text) return null
	if (/^0[xX][0-9a-fA-F]+$/.test(text)) return Number.parseInt(text, 16)
	if (/^0[0-7]+$/.test(text)) return Number.parseInt(text, 8)
	if (/^\d+$/.test(text)) return Number.parseInt(text, 10)
	return null
}

/** Whether a dotted-quad is in a range no subscriber endpoint should be in. */
export function isPrivateIpv4(octets: readonly number[]): boolean {
	const [a = 0, b = 0] = octets
	if (a === 0) return true // "this network"
	if (a === 10) return true // RFC1918
	if (a === 127) return true // loopback
	if (a === 169 && b === 254) return true // link-local — the metadata endpoint
	if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
	if (a === 192 && b === 168) return true // RFC1918
	if (a === 192 && b === 0) return true // IETF protocol assignments
	if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
	if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
	if (a >= 224) return true // multicast + reserved + broadcast
	return false
}

/** Whether an IPv6 literal is loopback, link-local, unique-local, or a mapped
 * IPv4 in a private range. */
export function isPrivateIpv6(host: string): boolean {
	const address = host.replace(/^\[|]$/g, '').toLowerCase()
	if (address === '::1' || address === '::') return true
	if (address.startsWith('fe80:')) return true // link-local
	if (/^f[cd][0-9a-f]{2}:/.test(address)) return true // unique-local
	// ::ffff:127.0.0.1 and ::ffff:7f00:1 both reach loopback.
	const mapped = /^::ffff:(.+)$/.exec(address)?.[1]
	if (mapped) {
		const quad = parseIpv4(mapped)
		if (quad) return isPrivateIpv4(quad)
		const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped)
		if (hexPair) {
			const high = Number.parseInt(hexPair[1] ?? '0', 16)
			const low = Number.parseInt(hexPair[2] ?? '0', 16)
			return isPrivateIpv4([
				(high >> 8) & 0xff,
				high & 0xff,
				(low >> 8) & 0xff,
				low & 0xff,
			])
		}
	}
	return false
}

/** Whether a bare host string is a literal address in a refused range. */
export function isPrivateHost(host: string): boolean {
	if (host.includes(':') || host.startsWith('[')) return isPrivateIpv6(host)
	const quad = parseIpv4(host)
	if (quad) return isPrivateIpv4(quad)
	// Names that are loopback by convention rather than by parse.
	const lower = host.toLowerCase().replace(/\.$/, '')
	return (
		lower === 'localhost' ||
		lower.endsWith('.localhost') ||
		lower.endsWith('.local') ||
		lower.endsWith('.internal')
	)
}

/** How a host name is resolved for the rebinding check. */
export type AddressResolver = (host: string) => Promise<string[]>

export interface SsrfPolicy {
	/** Allow plain `http:` — for a local receiver in dev, never in deploy. */
	allowHttp?: boolean
	/** Hosts to allow through unchanged (a private receiver you actually want). */
	allowHosts?: readonly string[]
	/** Resolve a hostname to addresses. Omit to skip the resolution check. */
	resolve?: AddressResolver
}

/**
 * Validate a subscriber URL, throwing {@link SsrfRefusedError} when it is one
 * the platform must not fetch.
 *
 * Called at subscribe time (so a bad URL is refused at the form, with a reason)
 * **and** immediately before every delivery attempt (so a hostname that has
 * since been re-pointed at an internal address is refused too).
 */
export async function assertPublicUrl(
	raw: string,
	policy: SsrfPolicy = {},
): Promise<URL> {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new SsrfRefusedError('not-a-url', `"${raw}" is not a valid URL`)
	}

	const schemes = policy.allowHttp
		? new Set([...ALLOWED_SCHEMES, 'http:'])
		: ALLOWED_SCHEMES
	if (!schemes.has(url.protocol)) {
		throw new SsrfRefusedError(
			'scheme',
			`webhook URLs must use ${[...schemes].join(' or ')} (got "${url.protocol}")`,
		)
	}
	if (url.username || url.password) {
		throw new SsrfRefusedError(
			'credentials',
			'webhook URLs must not embed credentials — they would be logged and replayed on every retry',
		)
	}
	if (!ALLOWED_PORTS.has(url.port)) {
		throw new SsrfRefusedError(
			'port',
			`port ${url.port} is not a webhook receiver — allowed: ${[...ALLOWED_PORTS].filter(Boolean).join(', ')}`,
		)
	}

	const host = url.hostname
	if (policy.allowHosts?.includes(host)) return url

	if (isPrivateHost(host)) {
		throw new SsrfRefusedError(
			'private-address',
			`"${host}" is an internal address — a webhook subscriber must be reachable from the public internet`,
		)
	}

	if (policy.resolve) {
		let addresses: string[]
		try {
			addresses = await policy.resolve(host)
		} catch {
			throw new SsrfRefusedError(
				'unresolvable',
				`"${host}" does not resolve — refusing to deliver to a name we cannot check`,
			)
		}
		if (addresses.length === 0) {
			throw new SsrfRefusedError(
				'unresolvable',
				`"${host}" resolves to nothing — refusing to deliver`,
			)
		}
		for (const address of addresses) {
			if (isPrivateHost(address)) {
				throw new SsrfRefusedError(
					'private-address',
					`"${host}" resolves to the internal address ${address} — refusing to deliver`,
				)
			}
		}
	}

	return url
}

/** The non-throwing form, for a form that wants to render the reason. */
export async function checkPublicUrl(
	raw: string,
	policy: SsrfPolicy = {},
): Promise<
	{ ok: true; url: URL } | { ok: false; reason: SsrfRefusal; message: string }
> {
	try {
		return { ok: true, url: await assertPublicUrl(raw, policy) }
	} catch (err) {
		if (err instanceof SsrfRefusedError)
			return { ok: false, reason: err.reason, message: err.message }
		throw err
	}
}
