/**
 * @vitest-environment jsdom
 *
 * One cache per app, and a loud complaint when there is not.
 *
 * `DataProvider` does `queryClient ?? new QueryClient()`, which is right for the
 * root and catastrophic one level down: a nested provider silently forks the
 * cache. Two trees then both work, and disagree. A create in the inner one does
 * not invalidate the outer one's lists; two slots on a page can render different
 * values for the same row; and the symptom shows up nowhere near the cause.
 *
 * That is not hypothetical — it was the *documented workaround*, because the
 * provider was mounted only in the admin frame, so a slot on a spec-declared page
 * had no data context and the only way forward was to build a second one.
 *
 * These tests pin the three things that make the fixed shape hold:
 *
 *   1. one provider serves arbitrarily deep children — a slot inherits it;
 *   2. nesting without a shared client forks the cache, and says so;
 *   3. nesting *with* a shared client does not warn, because that is the
 *      supported way to compose trees (tests do it).
 */

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataProvider, useQueryClient } from './data-context.tsx'
import { createMemoryDataProvider } from './memory-provider.ts'
import { QueryClient } from './query-client.ts'

let warnings: string[] = []

beforeEach(() => {
	warnings = []
	vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(' '))
	})
})
afterEach(() => vi.restoreAllMocks())

const provider = () => createMemoryDataProvider({ data: { book: [] } })

/** Reports the identity of the cache it can see, so two can be compared. */
function CacheProbe({ label }: { label: string }) {
	const client = useQueryClient()
	;(globalThis as Record<string, unknown>)[`__cache_${label}`] = client
	return <span data-testid={label}>seen</span>
}

/** A slot is just a component someone else wrote, mounted deep in the tree. */
function DeepSlot() {
	return (
		<div>
			<div>
				<CacheProbe label="slot" />
			</div>
		</div>
	)
}

describe('one provider serves the whole tree', () => {
	it('reaches a component nested arbitrarily deep', () => {
		render(
			<DataProvider dataProvider={provider()}>
				<CacheProbe label="host" />
				<DeepSlot />
			</DataProvider>,
		)
		expect(screen.getByTestId('slot')).toBeTruthy()
		const scope = globalThis as Record<string, unknown>
		// The identity is the point: same object, so an invalidation in the slot is
		// an invalidation the host's lists hear about.
		expect(scope.__cache_slot).toBe(scope.__cache_host)
		expect(warnings).toEqual([])
	})
})

describe('a second provider forks the cache, and says so', () => {
	it('warns, and names what breaks', () => {
		render(
			<DataProvider dataProvider={provider()}>
				<CacheProbe label="outer" />
				{/* Exactly the workaround #259 reports slot authors being pushed into. */}
				<DataProvider dataProvider={provider()}>
					<CacheProbe label="inner" />
				</DataProvider>
			</DataProvider>,
		)
		const scope = globalThis as Record<string, unknown>
		expect(scope.__cache_inner).not.toBe(scope.__cache_outer)
		expect(warnings.join('\n')).toMatch(/OWN cache/)
		expect(warnings.join('\n')).toMatch(/#259/)
	})

	it('stays silent when the client is shared on purpose', () => {
		const shared = new QueryClient()
		render(
			<DataProvider dataProvider={provider()} queryClient={shared}>
				<DataProvider dataProvider={provider()} queryClient={shared}>
					<CacheProbe label="shared" />
				</DataProvider>
			</DataProvider>,
		)
		expect((globalThis as Record<string, unknown>).__cache_shared).toBe(shared)
		expect(warnings).toEqual([])
	})
})

describe('the missing-provider error names the fix', () => {
	it('points at the root and refuses the repair that splits the cache', () => {
		// The old message was "must be used within a <DataProvider>", which reads as
		// an instruction to mount one — the single repair that introduces the bug.
		expect(() => render(<CacheProbe label="orphan" />)).toThrow(
			/Do NOT add a second <DataProvider>/,
		)
	})
})
