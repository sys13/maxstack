/**
 * The ownership facts the review-risk model consults.
 *
 * Extracted here rather than living in `commands/review.ts` because three
 * surfaces need the *same* answer: `maxstack review`, the `review_queue` MCP
 * tool, and the workbench pane. The first version had only the web host reading
 * the manifest, and the two surfaces then disagreed about which of the same five
 * proposals were batchable — at which point the classification is decorative,
 * because a reviewer simply uses whichever surface says yes.
 */

import { pageDescriptor } from '@maxstack/mcp'
import {
	type RiskContext,
	riskContextFromOwnership,
	type SpecSystem,
} from '@maxstack/spec'
import { projectDrift } from './generate.ts'
import type { Project } from './project.ts'

/**
 * Read this project's ownership manifest and project it into a {@link RiskContext}.
 *
 * A failure returns `{}` — deliberately *without* `ownershipKnown`, which the risk
 * model reads as "assume everything is owned" and refuses to batch. The direction
 * matters and is easy to get backwards: these facts only ever *raise* risk, so an
 * empty context is the most permissive answer, not the safest one. An unreadable
 * manifest therefore empties the batch rather than filling it.
 */
export async function ownershipRiskContext(
	project: Project,
	spec: SpecSystem,
): Promise<RiskContext> {
	try {
		const report = await projectDrift(project, spec)
		return riskContextFromOwnership(
			spec,
			report.owned,
			(page) => pageDescriptor(page).resource,
		)
	} catch {
		return {}
	}
}
