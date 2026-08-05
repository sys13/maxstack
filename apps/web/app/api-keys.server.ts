/**
 * Owned-code wiring for the API-key management page (`routes/api-keys.tsx`) —
 * task 57.
 *
 * Bar-2 territory, the same shape as `notifications.server.ts`/`settings.server.ts`:
 * hand-owned server code that composes `ApiKeyService`
 * (`@maxstack/features/api-keys`) into the running app. The feature owns the
 * model (issue/verify/list/revoke/rotate); this module gives it a database
 * and lists the resources a key can be scoped to, from the live registry.
 *
 * `sprout.server.ts`'s `resolveUser` constructs its *own* `ApiKeyService`
 * instance for the bearer-token verify path — independent DDL-ready flag, no
 * shared singleton — so this file can freely import from `sprout.server.ts`
 * (`getSprout`/`resolveUser`/`getContext`) without a circular dependency.
 */

import {
	API_KEYS_DDL,
	ApiKeyService,
	type ApiKeyView,
} from '@maxstack/features/api-keys'
import { getContext, getSprout, resolveUser } from './sprout.server'

const apiKeysScope = globalThis as typeof globalThis & {
	__maxstackApiKeysManageReady?: boolean
}

export async function getApiKeyService(): Promise<ApiKeyService> {
	const { backend } = await getSprout()
	if (!apiKeysScope.__maxstackApiKeysManageReady) {
		await backend.exec(API_KEYS_DDL)
		apiKeysScope.__maxstackApiKeysManageReady = true
	}
	return new ApiKeyService({ db: backend.db })
}

export interface ApiKeysView {
	userId: string
	/** The issuer's active organization, if any — what a newly issued key gets
	 * pinned to. */
	orgId: string | null
	keys: ApiKeyView[]
	/** Resource names a key can be scoped to — the live registry, not a
	 * hand-maintained list, so it never drifts from what `/api/:resource` serves. */
	resources: string[]
}

export async function resolveApiKeys(
	request: Request,
): Promise<ApiKeysView | null> {
	const user = await resolveUser(request)
	if (!user) return null
	const ctx = await getContext(request)
	const service = await getApiKeyService()
	return {
		userId: user.id,
		orgId: ctx.user?.orgId ?? null,
		keys: await service.listKeys(user.id),
		resources: ctx.registry.all().map((r) => r.resource.name),
	}
}
