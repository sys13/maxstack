/**
 * The portals pane's loader — `portalExposureReport`, grouped by
 * portal for rendering and by nothing else.
 *
 * It reads the spec and only the spec. There is deliberately no runtime probe
 * here ("try the portal, see what comes back"): the whole property the exposure
 * report has is that it cannot drift from what the runtime enforces *because
 * both derive from the declaration*, and a pane that reported observed behaviour
 * would be reporting something else. The agreement between the two is asserted
 * once, in `apps/web/app/portals.agreement.test.ts`, which is where an assertion
 * about a security boundary belongs.
 */

import {
	listPortals,
	portalExposureReport,
	summarizeExposure,
} from '@maxstack/spec'
import { getPlatform } from '~/sprout.server'
import type { PortalRow } from './portals-pane'

export async function loadPortalExposure(): Promise<{
	portals: PortalRow[]
	summary: string
}> {
	const spec = await getPlatform().spec.load()
	const report = portalExposureReport(spec)
	const declared = listPortals(spec)
	const portals: PortalRow[] = declared.map((portal) => ({
		key: portal.key,
		description: portal.description,
		audience: portal.audience,
		scope: portal.scope,
		entity: portal.entityId.replace(/^e-/, ''),
		paused: portal.paused,
		fields: report.filter((r) => r.portalId === portal.id),
	}))
	return { portals, summary: summarizeExposure(report) }
}
