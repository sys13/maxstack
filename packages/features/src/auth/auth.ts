/**
 * `createAuth` — the platform's better-auth instance, and `resolveSproutUser`,
 * the bridge from a better-auth session to the `SproutUser` the permission layer
 * reads. This is the "buy" side of the auth decision: sessions,
 * password hashing, CSRF, cookie handling, and the account/session tables are
 * better-auth's; the platform contributes only the RBAC mapping (`role`) and the
 * drizzle schema (`./schema`).
 *
 * The instance is backend-agnostic: it takes any drizzle db (pglite in tests and
 * dev, Postgres in prod) because the drizzle adapter is. Email+password is on by
 * default so the dogfood app is usable headlessly; social/OAuth providers are a
 * config field (`socialProviders`), not a code change.
 *
 * Breadth flows (task 50) are wired here rather than left to per-app config:
 *   - magic-link / passwordless and TOTP two-factor are always-on plugins, so
 *     the `Auth` type carries their endpoints and every app gets the same surface.
 *   - email verification, password reset, and magic-link delivery all render
 *     through the email feature's template registry and send through the
 *     injected `Mailer` (console mailer when none is given — dev-safe default).
 */

import type { PGlite } from '@electric-sql/pglite'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink, twoFactor } from 'better-auth/plugins'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import {
	createConsoleMailer,
	emailRegistry as defaultRegistry,
	type EmailRegistry,
	type Mailer,
	renderEmail,
} from '../email/index.ts'
import { AUTH_DDL, authSchema, authUserAdditionalFields } from './schema.ts'

/** The minimal user shape the platform's permission layer consumes. */
export interface AuthUser {
	id: string
	role?: string | null
	email?: string
	name?: string
	[key: string]: unknown
}

export interface CreateAuthOptions {
	/** A drizzle db (pglite or Postgres) whose schema includes {@link authSchema}.
	 * Untyped: better-auth's adapter accepts any drizzle driver handle. */
	db: any
	/** Signing secret. Required in prod; a dev default keeps local boot working. */
	secret?: string
	/** Public base URL (for cookies / redirects). Defaults to localhost dev. */
	baseURL?: string
	/** OAuth providers (github/google/…) — pure config, forwarded verbatim. */
	socialProviders?: BetterAuthOptions['socialProviders']
	/** Transport for verification / reset / magic-link mail. Defaults to the
	 * console mailer so the flows work (visibly) without a provider. */
	mailer?: Mailer
	/** Template registry the auth emails render through. Defaults to the shared
	 * singleton, so app-registered overrides apply to auth mail too. */
	registry?: EmailRegistry
	/** Product name used in email copy and as the TOTP issuer. */
	appName?: string
	/** Extra better-auth options (trustedOrigins, plugins, …). `plugins` are
	 * appended after the built-in twoFactor + magicLink plugins. */
	options?: Partial<BetterAuthOptions>
}

/**
 * Build the platform auth instance over a drizzle db. The `role` field is
 * declared as a non-input additional field: better-auth persists and returns it,
 * but clients cannot set it during sign-up — role changes go through an admin
 * path, never the public surface.
 *
 * The return type is left to inference: `betterAuth` narrows its type to the
 * exact options passed, and an explicit `Auth<BetterAuthOptions>` annotation is
 * a supertype it (correctly) refuses to widen to. Consumers use {@link Auth}.
 */
export function createAuth({
	db,
	secret,
	baseURL,
	socialProviders,
	mailer,
	registry,
	appName,
	options,
}: CreateAuthOptions) {
	const send = mailer ?? createConsoleMailer()
	const templates = registry ?? defaultRegistry
	const companyName = appName ?? 'Max'
	const { plugins: extraPlugins, ...restOptions } = options ?? {}
	return betterAuth({
		database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
		secret: secret ?? process.env.BETTER_AUTH_SECRET ?? 'maxstack-dev-secret',
		baseURL: baseURL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
		emailAndPassword: {
			enabled: true,
			autoSignIn: true,
			sendResetPassword: async ({ user, url }) => {
				await send.send({
					to: user.email,
					...renderEmail(templates, 'password-reset', {
						name: user.name,
						email: user.email,
						resetUrl: url,
						companyName,
					}),
				})
			},
		},
		emailVerification: {
			sendVerificationEmail: async ({ user, url }) => {
				await send.send({
					to: user.email,
					...renderEmail(templates, 'verify-email', {
						name: user.name,
						email: user.email,
						verificationUrl: url,
						companyName,
					}),
				})
			},
		},
		...(socialProviders ? { socialProviders } : {}),
		user: {
			additionalFields: authUserAdditionalFields,
			// Task 55 (account settings danger zone): delete-account is opt-in in
			// better-auth. No `sendDeleteAccountVerification` is configured, so a
			// correct current password deletes the account immediately — the
			// settings page adds its own typed "DELETE" confirmation on top.
			deleteUser: { enabled: true },
		},
		plugins: [
			twoFactor({ issuer: companyName }),
			magicLink({
				sendMagicLink: async ({ email, url }) => {
					await send.send({
						to: email,
						...renderEmail(templates, 'magic-link', {
							email,
							magicLinkUrl: url,
							companyName,
						}),
					})
				},
			}),
			...(extraPlugins ?? []),
		],
		...restOptions,
	})
}

/** The concrete auth instance type (inferred from {@link createAuth}). */
export type Auth = ReturnType<typeof createAuth>

/**
 * Convenience for the pglite backend (dev, tests, on-disk project mode):
 * materialize {@link AUTH_DDL} on the client, then build the instance over a
 * schema-bound drizzle. Keeps callers from importing drizzle directly.
 */
export async function createPgliteAuth(
	client: PGlite,
	opts: Omit<CreateAuthOptions, 'db'> = {},
): Promise<Auth> {
	await client.exec(AUTH_DDL)
	return createAuth({
		db: drizzlePglite({ client }),
		...opts,
	})
}

/**
 * Resolve the request's session to an {@link AuthUser}, or `null` when
 * unauthenticated. A thin wrapper over `auth.api.getSession` that also surfaces
 * the `role` additional field (typed loosely because better-auth widens the
 * user shape only when the admin plugin is present).
 */
export async function resolveSproutUser(
	auth: Auth,
	request: Request,
): Promise<AuthUser | null> {
	const result = await auth.api.getSession({ headers: request.headers })
	if (!result?.user) return null
	const u = result.user as AuthUser
	return {
		id: u.id,
		email: u.email,
		name: u.name,
		role: (u.role as string | null | undefined) ?? 'member',
	}
}
