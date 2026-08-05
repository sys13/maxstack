import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createConsoleErrorReporter,
	createDefaultErrorReporter,
	createMemoryErrorReporter,
	createRemoteErrorReporter,
} from './errors.ts'

describe('createMemoryErrorReporter', () => {
	it('captures an Error with message + stack', () => {
		const reporter = createMemoryErrorReporter()
		reporter.capture(new Error('boom'), { route: '/api/task' })
		expect(reporter.errors).toHaveLength(1)
		expect(reporter.errors[0]?.message).toBe('boom')
		expect(reporter.errors[0]?.stack).toBeDefined()
		expect(reporter.errors[0]?.context).toEqual({ route: '/api/task' })
	})

	it('coerces a non-Error throw into a message', () => {
		const reporter = createMemoryErrorReporter()
		reporter.capture('a plain string')
		expect(reporter.errors[0]?.message).toBe('a plain string')
	})
})

describe('createConsoleErrorReporter', () => {
	it('writes a structured JSON line to stderr', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const reporter = createConsoleErrorReporter()
		reporter.capture(new Error('boom'))
		expect(spy).toHaveBeenCalledTimes(1)
		const line = spy.mock.calls[0]?.[0] as string
		const parsed = JSON.parse(line)
		expect(parsed.level).toBe('error')
		expect(parsed.message).toBe('boom')
		spy.mockRestore()
	})
})

describe('createRemoteErrorReporter', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('POSTs the captured error to the DSN and still logs to console', () => {
		const reporter = createRemoteErrorReporter('https://example.com/hook')
		reporter.capture(new Error('boom'))
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/hook',
			expect.objectContaining({ method: 'POST' }),
		)
		expect(console.error).toHaveBeenCalledTimes(1)
	})

	it('a fetch rejection does not throw back to the caller', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
		const reporter = createRemoteErrorReporter('https://example.com/hook')
		expect(() => reporter.capture(new Error('boom'))).not.toThrow()
		// let the swallowed rejection's microtask settle
		await Promise.resolve()
	})
})

describe('createDefaultErrorReporter', () => {
	it('picks the console reporter with no DSN env vars set', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const reporter = createDefaultErrorReporter({})
		reporter.capture(new Error('boom'))
		expect(spy).toHaveBeenCalledTimes(1)
		spy.mockRestore()
	})

	it('picks the remote reporter when SENTRY_DSN is set', () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const reporter = createDefaultErrorReporter({
			SENTRY_DSN: 'https://sentry.example.com/ingest',
		})
		reporter.capture(new Error('boom'))
		expect(fetch).toHaveBeenCalled()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('falls back to ERROR_TRACKING_DSN when SENTRY_DSN is unset', () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const reporter = createDefaultErrorReporter({
			ERROR_TRACKING_DSN: 'https://example.com/hook',
		})
		reporter.capture(new Error('boom'))
		expect(fetch).toHaveBeenCalledWith(
			'https://example.com/hook',
			expect.anything(),
		)
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})
})
