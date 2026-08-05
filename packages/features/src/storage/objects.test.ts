/**
 * The `file_object` registry and the orphan *report*.
 *
 * The gating requirement is that "orphan cleanup must be explicit and
 * reviewable, never an automatic delete" — so the thing under test is a
 * function that returns a report and touches no storage, and the interesting
 * cases are all the ways a naive sweep would report something live.
 */

import { describe, expect, it } from 'vitest'
import {
	fileObjectRow,
	findOrphanedObjects,
	recordKeys,
	referencedFileKeys,
} from './objects.ts'

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

const record = (
	key: string,
	overrides: Partial<ReturnType<typeof fileObjectRow>> = {},
) => ({
	...fileObjectRow({
		key,
		contentType: 'image/png',
		size: 100,
		originalName: 'photo.png',
		now: () => new Date(NOW - 2 * HOUR),
	}),
	...overrides,
})

describe('fileObjectRow', () => {
	it('records the uploader, the field it was for, and the display name', () => {
		const row = fileObjectRow({
			key: 'abc.png',
			contentType: 'image/png',
			size: 42,
			originalName: 'My Holiday Photo.png',
			uploadedBy: 'user-1',
			resource: 'post',
			field: 'cover',
			derivatives: [
				{
					name: 'thumb',
					key: 'abc@thumb.png',
					size: 10,
					contentType: 'image/png',
					generator: 'sharp',
				},
			],
		})
		// The display name is kept, and is visibly not the key.
		expect(row.originalName).toBe('My Holiday Photo.png')
		expect(row.key).toBe('abc.png')
		expect(row.uploadedBy).toBe('user-1')
		expect(row.resource).toBe('post')
		expect(row.field).toBe('cover')
	})

	it('defaults an anonymous, unattached upload to nulls rather than guesses', () => {
		const row = fileObjectRow({
			key: 'abc.png',
			contentType: 'image/png',
			size: 42,
			originalName: 'x.png',
		})
		expect(row.uploadedBy).toBeNull()
		expect(row.resource).toBeNull()
		expect(row.derivatives).toEqual([])
	})
})

describe('recordKeys', () => {
	it('counts the original plus every materialized variant', () => {
		expect(
			recordKeys(
				record('abc.png', {
					derivatives: [
						{
							name: 'thumb',
							key: 'abc@thumb.png',
							size: 1,
							contentType: 'image/png',
							generator: 'sharp',
						},
					],
				}),
			),
		).toEqual(['abc.png', 'abc@thumb.png'])
	})
})

describe('referencedFileKeys', () => {
	it('collects non-empty values from the declared file columns only', () => {
		const keys = referencedFileKeys(
			[
				{ id: '1', cover: 'a.png', title: 'not-a-key' },
				{ id: '2', cover: '', avatar: 'b.png' },
				{ id: '3', cover: null },
			],
			['cover', 'avatar'],
		)
		expect([...keys].sort()).toEqual(['a.png', 'b.png'])
	})
})

describe('findOrphanedObjects', () => {
	it('reports a record nothing references, with its keys and byte total', () => {
		const orphan = record('gone.png', {
			derivatives: [
				{
					name: 'thumb',
					key: 'gone@thumb.png',
					size: 25,
					contentType: 'image/png',
					generator: 'sharp',
				},
			],
		})
		const report = findOrphanedObjects({
			records: [record('live.png'), orphan],
			referencedKeys: ['live.png'],
			now: () => NOW,
		})

		expect(report.orphans.map((o) => o.key)).toEqual(['gone.png'])
		expect(report.keys).toEqual(['gone.png', 'gone@thumb.png'])
		expect(report.bytes).toBe(125)
	})

	it('never reports an in-flight upload — the grace period is the point', () => {
		// A file uploaded ten minutes ago that no row references yet is the normal
		// state of a form someone has not submitted. Without this, every report
		// would invite deleting live work.
		const fresh = record('fresh.png', {
			createdAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
		})
		expect(
			findOrphanedObjects({
				records: [fresh],
				referencedKeys: [],
				now: () => NOW,
			}).orphans,
		).toEqual([])
	})

	it('honors an explicit grace period', () => {
		const fresh = record('fresh.png', {
			createdAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
		})
		expect(
			findOrphanedObjects({
				records: [fresh],
				referencedKeys: [],
				minimumAgeMs: 60_000,
				now: () => NOW,
			}).orphans.map((o) => o.key),
		).toEqual(['fresh.png'])
	})

	it('treats an unreadable timestamp as new, never as garbage', () => {
		expect(
			findOrphanedObjects({
				records: [record('weird.png', { createdAt: 'not a date' })],
				referencedKeys: [],
				now: () => NOW,
			}).orphans,
		).toEqual([])
	})

	it('reports a referenced key with no record as dangling, not as fine', () => {
		// The opposite failure and the more alarming one: a column pointing at
		// bytes the app has no metadata for.
		const report = findOrphanedObjects({
			records: [record('known.png')],
			referencedKeys: ['known.png', 'mystery.png'],
			now: () => NOW,
		})
		expect(report.orphans).toEqual([])
		expect(report.danglingReferences).toEqual(['mystery.png'])
	})

	it('does not count a derivative key as a reference to its original', () => {
		// Rows store the original's key; a report must not be fooled into keeping
		// an orphan alive because something references only its thumbnail.
		const report = findOrphanedObjects({
			records: [
				record('a.png', {
					derivatives: [
						{
							name: 'thumb',
							key: 'a@thumb.png',
							size: 1,
							contentType: 'image/png',
							generator: 'sharp',
						},
					],
				}),
			],
			referencedKeys: ['a@thumb.png'],
			now: () => NOW,
		})
		expect(report.orphans.map((o) => o.key)).toEqual(['a.png'])
		expect(report.danglingReferences).toEqual(['a@thumb.png'])
	})

	it('is a pure report — the empty case is empty, not an error', () => {
		expect(
			findOrphanedObjects({ records: [], referencedKeys: [], now: () => NOW }),
		).toEqual({ orphans: [], keys: [], bytes: 0, danglingReferences: [] })
	})
})
