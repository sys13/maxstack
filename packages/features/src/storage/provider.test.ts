import { describe, expect, it } from 'vitest'
import {
	derivativeKey,
	formatBytes,
	limitsForField,
	makeStorageKey,
	parseDerivativeKey,
	validateUpload,
} from './provider.ts'

describe('validateUpload', () => {
	it('accepts a file within the default size + type limits', () => {
		expect(validateUpload('image/png', 1024)).toEqual({ ok: true })
	})

	it('rejects a file over the size limit', () => {
		const result = validateUpload('image/png', 20 * 1024 * 1024)
		expect(result.ok).toBe(false)
		expect(result.ok ? '' : result.error).toMatch(/exceeds/)
	})

	it('rejects a disallowed MIME type', () => {
		const result = validateUpload('application/x-executable', 100)
		expect(result.ok).toBe(false)
		expect(result.ok ? '' : result.error).toMatch(/not allowed/)
	})

	it('matches wildcard MIME patterns like image/*', () => {
		expect(validateUpload('image/webp', 100).ok).toBe(true)
	})

	it('honors a custom limits config', () => {
		const limits = { maxSizeBytes: 10, allowedTypes: ['text/plain'] }
		expect(validateUpload('text/plain', 5, limits).ok).toBe(true)
		expect(validateUpload('text/plain', 50, limits).ok).toBe(false)
		expect(validateUpload('image/png', 5, limits).ok).toBe(false)
	})

	it('allows any type when allowedTypes is empty', () => {
		expect(
			validateUpload('application/x-anything', 5, {
				maxSizeBytes: 1000,
				allowedTypes: [],
			}).ok,
		).toBe(true)
	})
})

describe('makeStorageKey', () => {
	// Issue #183's non-negotiable: a stored filename is never derived from user
	// input. The extension comes from the content type the *server* validated,
	// so nothing the client sent survives into the key.
	it('takes its extension from the validated content type', () => {
		expect(makeStorageKey('photo.png', 'image/png')).toMatch(
			/^[0-9a-f-]{36}\.png$/,
		)
		expect(makeStorageKey('photo.png', 'image/jpeg')).toMatch(/\.jpg$/)
		expect(makeStorageKey('sheet.csv', 'text/csv; charset=utf-8')).toMatch(
			/\.csv$/,
		)
	})

	it('ignores the uploaded filename entirely', () => {
		// The classic double-extension and traversal attempts, all inert: the
		// filename is not consulted, so there is nothing to sanitize.
		for (const name of [
			'avatar.png.php',
			'../../etc/passwd',
			'shell.jsp;.png',
			'a\u0000.png',
			'archive.tar.gz.exe.reallyverylongext',
		]) {
			expect(makeStorageKey(name, 'image/png')).toMatch(/^[0-9a-f-]{36}\.png$/)
		}
	})

	it('emits no extension for a type it has no entry for', () => {
		expect(makeStorageKey('x.bin', 'application/x-httpd-php')).toMatch(
			/^[0-9a-f-]{36}$/,
		)
		expect(makeStorageKey('x.bin')).toMatch(/^[0-9a-f-]{36}$/)
	})

	it('produces unique keys per call', () => {
		expect(makeStorageKey('a.txt', 'text/plain')).not.toBe(
			makeStorageKey('a.txt', 'text/plain'),
		)
	})
})

describe('derivative keys', () => {
	it('slots the variant name before the extension, and round-trips', () => {
		expect(derivativeKey('abc.png', 'thumb')).toBe('abc@thumb.png')
		expect(derivativeKey('abc', 'thumb')).toBe('abc@thumb')
		expect(parseDerivativeKey('abc@thumb.png')).toEqual({
			original: 'abc.png',
			name: 'thumb',
		})
		expect(parseDerivativeKey('abc@thumb')).toEqual({
			original: 'abc',
			name: 'thumb',
		})
	})

	it('reports a plain key as not a derivative', () => {
		expect(parseDerivativeKey('abc.png')).toBeNull()
	})
})

describe('formatBytes', () => {
	// Per-field caps made this matter: the old MB-only message told a user who
	// hit a 200KB avatar limit that their file "exceeds the 0MB limit".
	it('reports a cap in the unit a person would say it in', () => {
		expect(formatBytes(200_000)).toBe('195.3KB')
		expect(formatBytes(5 * 1024 * 1024)).toBe('5MB')
		expect(formatBytes(1536 * 1024)).toBe('1.5MB')
		expect(formatBytes(2048)).toBe('2KB')
		expect(formatBytes(512)).toBe('512 bytes')
		expect(formatBytes(1)).toBe('1 byte')
	})

	it('never reports a real cap as zero', () => {
		for (const cap of [1, 999, 1024, 200_000, 10 * 1024 * 1024]) {
			expect(formatBytes(cap)).not.toMatch(/^0[A-Z]/)
		}
	})
})

describe('limitsForField', () => {
	it('turns a spec declaration into the wall the server enforces', () => {
		const limits = limitsForField({
			accept: ['image/png', 'image/jpeg'],
			maxSizeBytes: 1024,
		})
		expect(validateUpload('image/png', 500, limits).ok).toBe(true)
		expect(validateUpload('application/pdf', 500, limits).ok).toBe(false)
		expect(validateUpload('image/png', 2048, limits).ok).toBe(false)
	})

	// The point of per-field limits: two fields in one app disagree, and each
	// gets its own wall rather than sharing one app-wide default.
	it('is per field, not per app', () => {
		const avatar = limitsForField({ accept: ['image/png'], maxSizeBytes: 200 })
		const attachment = limitsForField({
			accept: ['application/pdf'],
			maxSizeBytes: 10_000,
		})
		expect(validateUpload('image/png', 5000, avatar).ok).toBe(false)
		expect(validateUpload('application/pdf', 5000, attachment).ok).toBe(true)
	})
})
