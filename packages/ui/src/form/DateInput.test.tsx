/**
 * `<DateInput>`.
 *
 * The reason this file can exist is the point of the change. #139 could not be
 * closed by a build because **Playwright cannot type into a Chrome date input at
 * all** — it sets the value rather than driving the segments — so the only way
 * to catch a regression was a person in a real browser. A text input has no
 * segments, so the behaviour is drivable here, and the bug is now pinned by an
 * ordinary test instead of by somebody remembering to check.
 *
 * What the bug actually was, reproduced in real Chrome before any of this was
 * written: the year segment accepts six digits and `-` is not a segment-advance
 * key, so typing `2026-07-10` — the very format the control displays as its own
 * hint — lands as `202607-10-dd`.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DateInput, formatDateTyping, isCompleteDate } from './DateInput.tsx'

describe('formatDateTyping', () => {
	/** The exact input from the issue. It used to produce `202607-10-10`. */
	it('accepts the ISO string a person actually types', () => {
		expect(formatDateTyping('2026-07-10')).toBe('2026-07-10')
	})

	it('inserts the dashes for digits alone', () => {
		expect(formatDateTyping('20260710')).toBe('2026-07-10')
	})

	/** Typed one character at a time, which is how the bug was found — every
	 * prefix has to be a sane thing to be looking at. */
	it('is stable through every prefix of a character-by-character type', () => {
		const seen = '2026-07-10'.split('').reduce<string[]>((acc, char) => {
			const prev = acc[acc.length - 1] ?? ''
			acc.push(formatDateTyping(prev + char))
			return acc
		}, [])
		expect(seen.at(-1)).toBe('2026-07-10')
		// Never longer than the target, and never with a stray separator — the two
		// shapes the native control got wrong.
		for (const step of seen) {
			expect(step.length).toBeLessThanOrEqual(10)
			expect(step).not.toMatch(/--|-$/)
		}
	})

	/** The year segment overflowing is *the* defect. It cannot happen here. */
	it('never lets the year run past four digits', () => {
		expect(formatDateTyping('202607101234')).toBe('2026-07-10')
		expect(formatDateTyping('2026071')).toBe('2026-07-1')
	})

	it('normalizes a paste with its own separators', () => {
		expect(formatDateTyping('2026/07/10')).toBe('2026-07-10')
	})
})

describe('isCompleteDate', () => {
	it('accepts a real date and rejects a well-shaped impossible one', () => {
		expect(isCompleteDate('2026-07-10')).toBe(true)
		// Matches the pattern and is not a day. Accepting it would push the problem
		// down to the column.
		expect(isCompleteDate('2026-02-31')).toBe(false)
		expect(isCompleteDate('2026-13-01')).toBe(false)
		expect(isCompleteDate('2026-07')).toBe(false)
	})
})

describe('<DateInput>', () => {
	/**
	 * `type="text"` is the assertion that keeps this drivable.
	 *
	 * It is not a styling preference: a segmented `type="date"` is the thing
	 * Playwright cannot type into, so the day somebody "tidies" this back to a
	 * native date input, the tests below stop testing anything and #139 comes
	 * back with no red anywhere. This is the tripwire for that.
	 */
	it('is a text input, which is what makes it drivable by a test at all', () => {
		render(<DateInput name="finishedOn" />)
		expect(
			(screen.getByPlaceholderText('YYYY-MM-DD') as HTMLInputElement).type,
		).toBe('text')
	})

	it('carries the typed value under the field name, so the form submits it', () => {
		render(<DateInput name="finishedOn" />)
		const input = screen.getByPlaceholderText('YYYY-MM-DD') as HTMLInputElement
		expect(input.name).toBe('finishedOn')
		fireEvent.change(input, { target: { value: '20260710' } })
		expect(input.value).toBe('2026-07-10')
	})

	it('round-trips a stored value into the field', () => {
		render(<DateInput name="finishedOn" defaultValue="2026-07-14" />)
		expect(
			(screen.getByPlaceholderText('YYYY-MM-DD') as HTMLInputElement).value,
		).toBe('2026-07-14')
	})

	it('reports each edit to the caller', () => {
		const onValueChange = vi.fn()
		render(<DateInput name="finishedOn" onValueChange={onValueChange} />)
		fireEvent.change(screen.getByPlaceholderText('YYYY-MM-DD'), {
			target: { value: '2026' },
		})
		expect(onValueChange).toHaveBeenCalledWith('2026')
	})

	/**
	 * The picker is kept, and it must not be a second value for the same field.
	 * A named hidden date input would submit twice and the server would take
	 * whichever the parser reached last.
	 */
	it('keeps a native picker that cannot submit its own value', () => {
		const { container } = render(<DateInput name="finishedOn" />)
		const picker = container.querySelector(
			'input[type="date"]',
		) as HTMLInputElement
		expect(picker).not.toBeNull()
		expect(picker.getAttribute('name')).toBeNull()
		expect(picker.tabIndex).toBe(-1)
		expect(screen.getByLabelText('Open calendar')).toBeInTheDocument()
	})

	it('feeds a picked date back into the text field', () => {
		const { container } = render(<DateInput name="finishedOn" />)
		const picker = container.querySelector(
			'input[type="date"]',
		) as HTMLInputElement
		fireEvent.change(picker, { target: { value: '2026-07-10' } })
		expect(
			(screen.getByPlaceholderText('YYYY-MM-DD') as HTMLInputElement).value,
		).toBe('2026-07-10')
	})

	/** An incomplete text value must not reach the picker, which would reject it
	 * and (in some browsers) clear itself, wiping what the person was typing. */
	it('holds a partial value in the text field without pushing it at the picker', () => {
		const { container } = render(<DateInput name="finishedOn" />)
		fireEvent.change(screen.getByPlaceholderText('YYYY-MM-DD'), {
			target: { value: '2026-0' },
		})
		const picker = container.querySelector(
			'input[type="date"]',
		) as HTMLInputElement
		expect(picker.value).toBe('')
	})

	it('disables the picker button with the field', () => {
		render(<DateInput name="finishedOn" disabled />)
		expect(screen.getByLabelText('Open calendar')).toBeDisabled()
	})
})
