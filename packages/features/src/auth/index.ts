/**
 * `auth` feature — better-auth sessions + RBAC role, staged as a bundle-ready
 * module (Phase 6 / task 27 wraps this in the bundle format). It replaces the
 * `x-maxstack-role` dev header: the request's session (not a header) is the
 * source of the current user, and `user.role` drives the Sprout permission
 * layer (`admin` ⇒ full access, anything else ⇒ member).
 *
 * Staged pieces:
 *   - `schema`  — the better-auth tables as drizzle + idempotent `AUTH_DDL`.
 *   - `createAuth` / `resolveSproutUser` — the instance and the session→user
 *     bridge, backend-agnostic (pglite or Postgres).
 *   - breadth flows (task 50) — social providers, magic-link, TOTP two-factor,
 *     email verification, password reset, and session/device management.
 */

export {
	type Auth,
	type AuthUser,
	type CreateAuthOptions,
	createAuth,
	createPgliteAuth,
	resolveSproutUser,
} from './auth.ts'
export {
	AUTH_DDL,
	account,
	authSchema,
	authUserAdditionalFields,
	session,
	twoFactor,
	user,
	verification,
} from './schema.ts'
export {
	listUserSessions,
	revokeOtherUserSessions,
	revokeUserSession,
	type SessionInfo,
} from './sessions.ts'
