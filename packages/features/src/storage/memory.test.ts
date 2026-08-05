/**
 * The in-memory double runs the same parity suite as the two real drivers
 *. It is a test double, but it is the one an app under test wires
 * in place of local disk — so a behaviour it gets wrong is a behaviour every
 * test built on it will assert incorrectly.
 */

import { describe } from 'vitest'
import { testStorageProviderConformance } from './conformance.ts'
import { createMemoryStorageProvider } from './memory.ts'

describe('memory driver parity', () => {
	testStorageProviderConformance({
		name: 'memory',
		create: () => createMemoryStorageProvider(),
		// Declared: `memory://…` is not a resolvable HTTP URL, on purpose — a test
		// that accidentally fetches one should fail loudly rather than 404.
		quirks: { syntheticUrls: true },
	})
})
