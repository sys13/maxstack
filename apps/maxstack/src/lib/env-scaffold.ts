/**
 * The env scaffold `maxstack init` writes: a committed `.env.example` (the
 * documented contract, secret slots left blank) and a gitignored `.env` with
 * cryptographically-random values filled in for every secret slot.
 *
 * The point is that nobody ships a default or blank signing key: the runtime's
 * `BETTER_AUTH_SECRET` falls back to a hardcoded `'maxstack-dev-secret'` when
 * unset (see packages/features/src/auth/auth.ts), so a fresh project silently
 * signs sessions with a public constant unless something generates a real one.
 * `init` generates it up front, per-project.
 *
 * Both files render from the single `ENV_VARS` table so the example and the
 * generated `.env` can never drift out of sync.
 */
import { randomBytes } from 'node:crypto'

/**
 * One variable in the scaffolded env files. A `secret` var is generated fresh
 * into `.env` and left blank (with its comment) in `.env.example`; a var with a
 * `default` is written verbatim into both.
 */
interface EnvVar {
	key: string
	/** Human note rendered as `# ...` comment lines above the assignment. */
	comment: string
	/** Generate a random value into `.env`; leave blank in `.env.example`. */
	secret?: boolean
	/** Static value written into both files (non-secret config). */
	default?: string
	/**
	 * Left blank in *both* files: something only the user can supply, and which
	 * `init` must not invent. Distinct from `secret`, which is generated into
	 * `.env` — there is no generating an API key.
	 */
	byob?: boolean
}

const ENV_VARS: EnvVar[] = [
	{
		key: 'BETTER_AUTH_SECRET',
		comment:
			'Signing key for auth sessions and cookies. `maxstack init` generated a\nrandom value below; use a fresh, secret value per environment\n(`openssl rand -hex 32`). Never commit a real one — `.env` is gitignored.',
		secret: true,
	},
	{
		key: 'BETTER_AUTH_URL',
		comment: 'Public origin the app is served from (auth callbacks resolve against it).',
		default: 'http://localhost:3000',
	},
	{
		// Issue #284: the describe-to-prefill box sits at the top of every
		// generated create form and cannot work without this. Nothing in `init`,
		// the README, the scaffolded CLAUDE.md or the in-app message named the
		// variable, so the feature read as broken rather than unconfigured.
		key: 'ANTHROPIC_API_KEY',
		comment:
			'Optional. Enables the AI features in the app — the "Describe it, we\'ll fill\nthe form" box on every create/edit form. Get a key at\nhttps://console.anthropic.com/settings/keys, paste it below, and restart the\ndev server. Leave blank and the app works normally, minus those boxes.\n(`OPENAI_API_KEY` works too. `MOCK_AI=1` runs them keyless and deterministic,\nfor tests.)',
		byob: true,
	},
]

/** A cryptographically-random 256-bit secret as 64 hex chars. */
function generateSecret(): string {
	return randomBytes(32).toString('hex')
}

function commentLines(comment: string): string {
	return comment
		.split('\n')
		.map((line) => `# ${line}`)
		.join('\n')
}

/**
 * The committed template: every var documented, secrets blank so the file is
 * safe to check in and shows the reader exactly what to provide.
 */
export function renderEnvExample(): string {
	const blocks = ENV_VARS.map((v) => {
		const value = v.secret ? '' : (v.default ?? '')
		return `${commentLines(v.comment)}\n${v.key}=${value}`
	})
	return `${blocks.join('\n\n')}\n`
}

/**
 * The gitignored local file: same shape as the example, but with a freshly
 * generated value for every secret so the project runs safely out of the box.
 */
export function renderEnvLocal(): string {
	const blocks = ENV_VARS.map((v) => {
		const value = v.secret ? generateSecret() : (v.default ?? '')
		return `${commentLines(v.comment)}\n${v.key}=${value}`
	})
	return `${blocks.join('\n\n')}\n`
}
