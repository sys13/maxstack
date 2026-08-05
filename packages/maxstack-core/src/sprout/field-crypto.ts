/**
 * Field-level encryption at rest and display masking (issue #306).
 *
 * Two declarations on a field, deliberately separate because they defend
 * against different things and neither substitutes for the other:
 *
 *  - **`encrypted`** protects the value *at rest* — a database dump, a backup
 *    tarball, a replica somebody forgot about. The column holds ciphertext and
 *    nothing but ciphertext; the plaintext exists only inside a request that
 *    was allowed to see it.
 *  - **`mask`** protects the value *in transit and on screen* — the REST
 *    payload, the MCP tool result, the CSV, the rendered document, the table
 *    cell. It is a display transform, so it is emphatically **not** a substitute
 *    for encryption: a masked plaintext column is still plaintext in the dump.
 *
 * ## Why the primitive is AES-256-GCM and nothing else
 *
 * GCM is authenticated: opening a value either returns exactly what was sealed
 * or throws. That property is what makes ciphertext in a column safe to trust —
 * without it, an attacker with write access to the database can flip bits in a
 * stored credential and the application will happily use whatever comes out.
 * ECB (and any unauthenticated mode) also leaks equality: two rows holding the
 * same tax id would hold the same bytes, which is a join key over the exact
 * column that was supposed to be secret. Every seal here uses a fresh random
 * 96-bit IV, so two rows with the same plaintext are byte-different.
 *
 * ## The key never comes from the spec
 *
 * The spec is a file in the repository. Key material comes from the process
 * environment ({@link FIELD_KEY_ENV}) and from nowhere else, and a spec that
 * declares an encrypted field with no key configured **refuses to boot** rather
 * than storing plaintext under a column somebody believes is sealed. A silent
 * downgrade is the worst outcome available here: it is indistinguishable from
 * working, right up until the dump.
 *
 * ## What is deliberately NOT decided here
 *
 * Key **rotation**, **per-tenant keys** and **KMS/HSM custody** are operator
 * decisions with migration consequences, and this module does not guess at any
 * of them. What it does is leave room: every ciphertext carries the fingerprint
 * of the key that sealed it, so a future key ring can select rather than
 * re-derive, and a value sealed under a retired key fails loudly by name instead
 * of decoding to garbage.
 */

/** The environment variable holding the field key: 32 bytes, base64 or hex. */
export const FIELD_KEY_ENV = 'MAXSTACK_FIELD_ENCRYPTION_KEY'

/** The envelope prefix — a stored value that starts with this is ciphertext. */
export const ENVELOPE_PREFIX = 'msenc'

/** Envelope version. Bumped only if the framing or the primitive changes. */
export const ENVELOPE_VERSION = 'v1'

/** AES-256-GCM's key length in bytes. Not configurable: a shorter key is a
 * different algorithm wearing this one's name. */
export const FIELD_KEY_BYTES = 32

/** GCM's recommended IV length. 96 bits is the size the mode is specified for;
 * anything else runs GCM's IV through GHASH and loses the safety margin. */
const IV_BYTES = 12

/** The declared mask styles. Three, because three is what the ask is:
 *  - `redact` — "there is a value here" and nothing more.
 *  - `last4`  — the shape a support agent verifies a card or a tax id against.
 *  - `hash`   — a stable token, so two records can be *compared* without either
 *               being read. Keyed (HMAC), never a bare digest: an unsalted
 *               SHA-256 of a nine-digit number is a rainbow table, not a mask.
 */
export type MaskStyle = 'redact' | 'last4' | 'hash'

/** The runtime set, for guarding ops that arrive as JSON. */
export const MASK_STYLES: readonly MaskStyle[] = ['redact', 'last4', 'hash']

/** A field's declared mask, as it travels on column metadata. */
export interface MaskMeta {
	style: MaskStyle
	/**
	 * Roles whose reads are **not** masked. Absent or empty means nobody: the
	 * platform's read paths mask the value for every caller, and the plaintext is
	 * reachable only by owned code holding the key. That is the safe default —
	 * an omitted allowlist must not read as "everyone".
	 */
	unmaskRoles?: string[]
}

/** The fixed-width redaction. Fixed on purpose: a mask whose length tracked the
 * plaintext would publish the length of every secret it hid. */
const BULLETS = '••••••••'

/** Raised when an encrypted (or `hash`-masked) field is declared and no key is
 * configured. Named so a host can recognize it; thrown at boot, not at write. */
export class MissingFieldKeyError extends Error {
	constructor(where: string) {
		super(
			`${where} needs field encryption, but ${FIELD_KEY_ENV} is not set. ` +
				"Generate one with `node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"` " +
				'and set it in the environment (never in the spec or the repository). ' +
				'Refusing to start: storing the value in plaintext under a column ' +
				'declared encrypted is worse than not starting.',
		)
		this.name = 'MissingFieldKeyError'
	}
}

/** Raised when the configured key is present but unusable. Separate from
 * {@link MissingFieldKeyError} because "you set nothing" and "you set something
 * wrong" are different operator mistakes with different fixes. */
export class InvalidFieldKeyError extends Error {
	constructor(detail: string) {
		super(
			`${FIELD_KEY_ENV} is not a usable key: ${detail}. ` +
				`It must decode (base64 or hex) to exactly ${FIELD_KEY_BYTES} bytes.`,
		)
		this.name = 'InvalidFieldKeyError'
	}
}

/** Raised when a stored value cannot be opened — a truncated envelope, a
 * tampered ciphertext (GCM's tag check failing), or a value sealed under a key
 * this process does not hold. Never contains the value. */
export class FieldDecryptError extends Error {
	constructor(column: string, detail: string) {
		super(`could not decrypt "${column}": ${detail}`)
		this.name = 'FieldDecryptError'
	}
}

// ---------------------------------------------------------------------------
// node:crypto, loaded lazily
//
// `operations.ts` is re-exported from the `@maxstack/core` barrel, which React
// Router route modules import — so a *static* `node:crypto` import here would
// follow the pglite driver into client bundles. Same lazy-import treatment
// `from-spec.ts` gives pglite, and for the same reason.
// ---------------------------------------------------------------------------

type NodeCrypto = typeof import('node:crypto')
let cryptoModule: NodeCrypto | undefined

async function nodeCrypto(): Promise<NodeCrypto> {
	cryptoModule ??= await import('node:crypto')
	return cryptoModule
}

/** Decode a configured key, or throw the operator error that says how to fix it. */
function decodeKey(raw: string): Uint8Array {
	const trimmed = raw.trim()
	if (trimmed === '') throw new InvalidFieldKeyError('it is empty')
	const bytes = /^[0-9a-fA-F]+$/.test(trimmed)
		? Uint8Array.from(
				trimmed.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [],
			)
		: base64ToBytes(trimmed)
	if (bytes.length !== FIELD_KEY_BYTES)
		throw new InvalidFieldKeyError(`it decodes to ${bytes.length} bytes`)
	return bytes
}

function base64ToBytes(value: string): Uint8Array {
	// `Buffer.from` is lenient enough to accept a hex string as base64, so the
	// caller checks hex first. Node and every runtime we target have atob.
	try {
		const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
		return Uint8Array.from(binary, (c) => c.charCodeAt(0))
	} catch {
		throw new InvalidFieldKeyError('it is not valid base64 or hex')
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/** The configured key, or `undefined` when none is set. Read from the
 * environment on every call rather than cached at module load, so a test (and a
 * process that sets its environment after import) sees the truth. */
export function configuredFieldKey(): Uint8Array | undefined {
	const raw =
		typeof process === 'undefined' ? undefined : process.env[FIELD_KEY_ENV]
	if (raw === undefined || raw === '') return undefined
	return decodeKey(raw)
}

/** The key, or the boot refusal. `where` names what needed it, so the message
 * points at the declaration rather than at the platform. */
export function requireFieldKey(where: string): Uint8Array {
	const key = configuredFieldKey()
	if (!key) throw new MissingFieldKeyError(where)
	return key
}

/**
 * A short, non-secret fingerprint of a key — the first 8 hex characters of
 * SHA-256 over the key bytes.
 *
 * It is stamped into every envelope so a value sealed under a different key
 * fails by name instead of by garbage, which is the difference between "restore
 * the other key" and "this data is corrupt". Publishing it costs nothing: a
 * 32-bit prefix of a hash over 256 bits of key material identifies the key to
 * somebody who already has it and tells somebody who does not exactly nothing.
 */
export async function keyFingerprint(key: Uint8Array): Promise<string> {
	const { createHash } = await nodeCrypto()
	return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/**
 * Whether a stored value is one of our envelopes. Used to keep sealing
 * idempotent (re-sealing a ciphertext would be a second layer nobody can peel)
 * and to let a column that predates the declaration read back as-is rather than
 * throwing across every existing row.
 */
export function isSealed(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith(`${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:`)
	)
}

/**
 * Seal one value.
 *
 * `aad` binds the ciphertext to the place it lives — `"<resource>:<column>"`.
 * GCM authenticates it, so a ciphertext lifted out of `employee.ssn` and pasted
 * into `note.body` fails to open rather than decrypting there. Without it, a
 * writer who can set any string on any column can move secrets between columns
 * whose read rules differ.
 */
export async function sealValue(
	plaintext: string,
	key: Uint8Array,
	aad: string,
): Promise<string> {
	const { createCipheriv, randomBytes } = await nodeCrypto()
	const iv = randomBytes(IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(Buffer.from(aad, 'utf8'))
	const ciphertext = Buffer.concat([
		cipher.update(Buffer.from(plaintext, 'utf8')),
		cipher.final(),
	])
	const tag = cipher.getAuthTag()
	const fingerprint = await keyFingerprint(key)
	return [
		ENVELOPE_PREFIX,
		ENVELOPE_VERSION,
		fingerprint,
		bytesToBase64(new Uint8Array(iv)),
		bytesToBase64(new Uint8Array(ciphertext)),
		bytesToBase64(new Uint8Array(tag)),
	].join(':')
}

/** Open one envelope, or throw. Never echoes the stored value into the error —
 * an error message is a log line, and a log line is a place secrets escape. */
export async function openValue(
	envelope: string,
	key: Uint8Array,
	aad: string,
	column: string,
): Promise<string> {
	const parts = envelope.split(':')
	if (parts.length !== 6)
		throw new FieldDecryptError(column, 'the stored envelope is malformed')
	const [, , fingerprint, ivB64, ctB64, tagB64] = parts as [
		string,
		string,
		string,
		string,
		string,
		string,
	]
	const mine = await keyFingerprint(key)
	if (fingerprint !== mine)
		throw new FieldDecryptError(
			column,
			`it was sealed with key ${fingerprint} and this process holds ${mine}`,
		)
	const { createDecipheriv } = await nodeCrypto()
	try {
		const decipher = createDecipheriv(
			'aes-256-gcm',
			key,
			Buffer.from(base64ToBytes(ivB64)),
		)
		decipher.setAAD(Buffer.from(aad, 'utf8'))
		decipher.setAuthTag(Buffer.from(base64ToBytes(tagB64)))
		return Buffer.concat([
			decipher.update(Buffer.from(base64ToBytes(ctB64))),
			decipher.final(),
		]).toString('utf8')
	} catch {
		// GCM's tag check failing means the bytes, the key or the binding is wrong.
		// All three are the same answer to the caller: this did not come back.
		throw new FieldDecryptError(
			column,
			'authentication failed — the value was modified, or the binding does not match',
		)
	}
}

/**
 * Render the masked form of a plaintext value.
 *
 * `null`/`undefined` mask to themselves: "there is no value" is not a secret,
 * and inventing bullets for an empty column would tell a support user a tax id
 * is on file when none is.
 */
export async function maskValue(
	value: unknown,
	mask: MaskMeta,
	key: Uint8Array | undefined,
	aad: string,
): Promise<unknown> {
	if (value === null || value === undefined) return value
	const text = String(value)
	if (text === '') return text
	switch (mask.style) {
		case 'redact':
			return BULLETS
		case 'last4':
			// Fewer than four characters means the "last four" IS the value, so the
			// mask degrades to a full redaction rather than publishing it.
			return text.length <= 4 ? BULLETS : `••••${text.slice(-4)}`
		case 'hash': {
			// Keyed, and bound to the column like the ciphertext is: the same value in
			// two columns must not produce the same token, or the mask becomes a join
			// key across tables whose read rules differ.
			if (!key) throw new MissingFieldKeyError(`the "${aad}" mask`)
			const { createHmac } = await nodeCrypto()
			return `sha256:${createHmac('sha256', key)
				.update(`${aad} ${text}`)
				.digest('hex')
				.slice(0, 16)}`
		}
		default: {
			const exhaustive: never = mask.style
			throw new Error(`unknown mask style: ${String(exhaustive)}`)
		}
	}
}
