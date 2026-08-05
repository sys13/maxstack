import { beforeEach, describe, expect, it } from 'vitest'
import { loadAiClusterSnapshot, runAiClustering } from './ai-cluster.server'

const scope = globalThis as typeof globalThis & {
	__maxstackFeedback?: unknown[]
	__maxstackAiClusters?: unknown
}

describe('runAiClustering (the explicit Cluster trigger, #11)', () => {
	beforeEach(() => {
		scope.__maxstackFeedback = []
		scope.__maxstackAiClusters = undefined
		delete process.env.MOCK_AI
		delete process.env.ANTHROPIC_API_KEY
		delete process.env.OPENAI_API_KEY
	})

	it('has no snapshot until explicitly triggered', async () => {
		expect(await loadAiClusterSnapshot()).toBeNull()
	})

	it('runs the mock clusterer under MOCK_AI and persists a snapshot the queue can read back', async () => {
		process.env.MOCK_AI = '1'
		// No captured feedback → falls back to the demo backlog (feedback-source.server).
		const result = await runAiClustering()
		expect(result.error).toBeUndefined()
		expect(result.feedbackCount).toBeGreaterThan(0)
		expect(result.clusterCount).toBeGreaterThan(0)

		const snapshot = await loadAiClusterSnapshot()
		expect(snapshot).not.toBeNull()
		expect(snapshot?.length).toBe(result.clusterCount)
	})

	it('degrades to a reported error rather than throwing when no AI is configured', async () => {
		// Neither MOCK_AI nor an API key set — selectAiClient() falls through to
		// the OpenAI transport, which fails fast on the missing key.
		const result = await runAiClustering()
		expect(result.error).toBeTruthy()
		expect(result.clusterCount).toBe(0)
		// A failed run must not clobber "no snapshot yet".
		expect(await loadAiClusterSnapshot()).toBeNull()
	})
})
