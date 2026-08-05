/**
 * Session / device management (task 50) — the "which devices am I signed in on"
 * surface. better-auth already stores ip/user-agent per session and exposes
 * list/revoke endpoints; these helpers adapt them to the platform's
 * request-in/plain-data-out shape so a settings page (or MCP tool) can render
 * and revoke devices without knowing better-auth's API conventions.
 */

import type { Auth } from './auth.ts'

/** One signed-in device/session, as a settings page renders it. */
export interface SessionInfo {
	/** Opaque session token — the handle `revokeUserSession` takes. */
	token: string
	ipAddress: string | null
	userAgent: string | null
	createdAt: Date
	expiresAt: Date
	/** True for the session making this request (guard "sign out this device"). */
	current: boolean
}

/** List the requesting user's active sessions, most recent first. */
export async function listUserSessions(
	auth: Auth,
	request: Request,
): Promise<SessionInfo[]> {
	const [sessions, current] = await Promise.all([
		auth.api.listSessions({ headers: request.headers }),
		auth.api.getSession({ headers: request.headers }),
	])
	const currentToken = current?.session.token
	return sessions
		.map((s) => ({
			token: s.token,
			ipAddress: s.ipAddress ?? null,
			userAgent: s.userAgent ?? null,
			createdAt: s.createdAt,
			expiresAt: s.expiresAt,
			current: s.token === currentToken,
		}))
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/** Revoke one session by token (a device from `listUserSessions`). */
export async function revokeUserSession(
	auth: Auth,
	request: Request,
	token: string,
): Promise<void> {
	await auth.api.revokeSession({
		body: { token },
		headers: request.headers,
	})
}

/** Revoke every session except the requesting one ("sign out other devices"). */
export async function revokeOtherUserSessions(
	auth: Auth,
	request: Request,
): Promise<void> {
	await auth.api.revokeOtherSessions({ headers: request.headers })
}
