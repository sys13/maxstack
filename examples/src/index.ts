/**
 * @maxstack/examples — worked example apps, each a complete validated
 * {@link SpecSystem} (product + data + page layers) plus a change set: the
 * sequence of follow-up requests a real maintainer would make against it.
 *
 * They serve two purposes. Read on their own, they are the clearest answer to
 * "what does a spec actually look like?" — a whole app, in one file, at a size
 * you can hold in your head. Used as fixtures, they give the CLI's determinism
 * and derivation tests real apps to run against instead of toy ones.
 *
 * The set is deliberately biased toward long-lived tools under sustained
 * change, and spans task boards, content, study loops, planning, money and
 * pipelines, so nothing here is overfit to a single domain shape. Ten are
 * hand-authored; `saas-starter` is assembled from the feature-bundle catalog.
 */

import { blogExample } from './blog.ts'
import { bookclubExample } from './bookclub.ts'
import { bugtrailExample } from './bugtrail.ts'
import { cardstackExample } from './cardstack.ts'
import { crmliteExample } from './crmlite.ts'
import { gymlogExample } from './gymlog.ts'
import { invoicerExample } from './invoicer.ts'
import { recipeboxExample } from './recipebox.ts'
import { saasStarterExample } from './saas-starter.ts'
import { tasklyExample } from './taskly.ts'
import { todotrackerExample } from './todotracker.ts'

export { blogExample } from './blog.ts'
export { bookclubExample } from './bookclub.ts'
export { bugtrailExample } from './bugtrail.ts'
export { cardstackExample } from './cardstack.ts'
export { crmliteExample } from './crmlite.ts'
export { gymlogExample } from './gymlog.ts'
export { invoicerExample } from './invoicer.ts'
export { examplePRD } from './prd-builder.ts'
export { recipeboxExample } from './recipebox.ts'
export {
	assembleSaasStarterSpec,
	saasStarterBundles,
	saasStarterExample,
} from './saas-starter.ts'
export { tasklyExample } from './taskly.ts'
export { todotrackerExample } from './todotracker.ts'

/** Every example app, in a stable order. */
export const examples = [
	tasklyExample,
	todotrackerExample,
	blogExample,
	cardstackExample,
	recipeboxExample,
	bugtrailExample,
	bookclubExample,
	invoicerExample,
	gymlogExample,
	crmliteExample,
	saasStarterExample,
] as const
