/**
 * API keys feature (task 57; catalog bundle since issue #186) — issue/verify/
 * list/revoke/rotate personal access tokens, scoped per resource+action over
 * the Sprout REST and MCP surfaces.
 */

export type {
	MintedPortalToken,
	PortalTokenAudit,
	VerifiedPortalToken,
} from './portal-token.ts'
export { PortalTokenService } from './portal-token.ts'
export {
	API_KEYS_DDL,
	apiKey,
	PORTAL_TOKENS_DDL,
	portalToken,
} from './schema.ts'
export type {
	ApiKeyAction,
	ApiKeyScope,
	ApiKeyView,
	IssuedKey,
	VerifiedKey,
} from './service.ts'
export { ApiKeyService, normalizeScope } from './service.ts'
