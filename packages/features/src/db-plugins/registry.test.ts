import { describe, expect, it } from 'vitest'
import { type DatabasePlugin, DatabasePluginRegistry } from './registry.ts'

function trackingPlugin(name: string, log: string[]): DatabasePlugin<unknown> {
	return {
		name,
		models: [name],
		seed: async () => {
			log.push(`seed:${name}`)
		},
		clear: async () => {
			log.push(`clear:${name}`)
		},
	}
}

describe('DatabasePluginRegistry', () => {
	it('registers and resolves plugins by name', () => {
		const registry = new DatabasePluginRegistry()
		const p = trackingPlugin('blog', [])
		registry.register(p)
		expect(registry.get('blog')).toBe(p)
		expect(registry.getAll()).toHaveLength(1)
	})

	it('load skips unknown plugin names', () => {
		const registry = new DatabasePluginRegistry()
		registry.register(trackingPlugin('blog', []))
		expect(registry.load(['blog', 'missing']).map((p) => p.name)).toEqual([
			'blog',
		])
	})

	it('seeds enabled plugins in order', async () => {
		const log: string[] = []
		const registry = new DatabasePluginRegistry()
		registry.register(trackingPlugin('a', log))
		registry.register(trackingPlugin('b', log))
		await registry.seed({}, ['a', 'b'])
		expect(log).toEqual(['seed:a', 'seed:b'])
	})

	it('clears in reverse order (children before parents)', async () => {
		const log: string[] = []
		const registry = new DatabasePluginRegistry()
		registry.register(trackingPlugin('a', log))
		registry.register(trackingPlugin('b', log))
		await registry.clear({}, ['a', 'b'])
		expect(log).toEqual(['clear:b', 'clear:a'])
	})

	it('seed fails fast on the first error', async () => {
		const registry = new DatabasePluginRegistry()
		registry.register({
			name: 'boom',
			models: [],
			seed: async () => {
				throw new Error('nope')
			},
			clear: async () => {},
		})
		await expect(registry.seed({}, ['boom'])).rejects.toThrow('nope')
	})

	it('clear attempts all plugins then rethrows the first error', async () => {
		const log: string[] = []
		const registry = new DatabasePluginRegistry()
		registry.register({
			name: 'ok',
			models: [],
			seed: async () => {},
			clear: async () => {
				log.push('clear:ok')
			},
		})
		registry.register({
			name: 'bad',
			models: [],
			seed: async () => {},
			clear: async () => {
				throw new Error('teardown failed')
			},
		})
		// reverse order: bad first (throws, captured), then ok still runs.
		await expect(registry.clear({}, ['ok', 'bad'])).rejects.toThrow(
			'teardown failed',
		)
		expect(log).toEqual(['clear:ok'])
	})
})
