/**
 * `examplePRD` — the example set's PRD builder over `@maxstack/spec`'s
 * {@link minimalPRD}. The skeleton was promoted into the spec package
 * so `maxstack init` can seed a new project's spec from the same valid-PRD
 * builder; the example-specific framing (author + background prose) lives
 * here so it never leaks into real projects.
 */

import { type MinimalPrdInput, minimalPRD, type PRD } from '@maxstack/spec'

export type ExamplePrdInput = Omit<MinimalPrdInput, 'author' | 'background'>

export function examplePRD(input: ExamplePrdInput): PRD {
	return minimalPRD({
		...input,
		author: 'ExampleApp fixtures',
		background:
			'Authored as a example fixture: a long-lived app under sustained change (the maintainer ICP), so the change set carries the signal.',
	})
}
