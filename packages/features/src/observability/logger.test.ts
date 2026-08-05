import { describe, expect, it, vi } from 'vitest'
import { logRequest, nextRequestId } from './logger.ts'

describe('nextRequestId', () => {
	it('produces unique, prefixed ids', () => {
		const a = nextRequestId()
		const b = nextRequestId()
		expect(a).toMatch(/^req_/)
		expect(a).not.toBe(b)
	})
})

describe('logRequest', () => {
	it('writes one structured JSON line with the given fields', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
		logRequest({
			requestId: 'req_123',
			method: 'GET',
			path: '/api/task',
			status: 200,
			durationMs: 12,
			userId: 'u1',
		})
		expect(spy).toHaveBeenCalledTimes(1)
		const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string)
		expect(parsed).toMatchObject({
			level: 'info',
			type: 'request',
			requestId: 'req_123',
			method: 'GET',
			path: '/api/task',
			status: 200,
			durationMs: 12,
			userId: 'u1',
		})
		spy.mockRestore()
	})
})
