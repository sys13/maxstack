/**
 * Day arithmetic for the date-arranged views.
 *
 * Everything here speaks **day keys** — `YYYY-MM-DD`, the day a row falls on in
 * the view's *declared* timezone — and never `Date` objects in the ambient one.
 * That is the whole point: a calendar that buckets rows by the browser's zone
 * renders two different grids for two people looking at the same screen, and a
 * calendar that buckets by the server's renders one that is wrong for everybody
 * who is not in it. `dayKeyOf` is the only function that converts an instant to
 * a day, it takes the timezone as a required argument, and the rest of the
 * module is pure string/number arithmetic over the result.
 *
 * The reverse conversion — a day key back to an instant, which is where DST
 * gaps and overlaps live — deliberately does **not** live here. It happens
 * server-side against the spec's declared zone (`@maxstack/spec`'s
 * `zonedWallClockToInstant`), because it is a *write*, and the UI package does
 * not own writes.
 */

/** A `YYYY-MM-DD` day, in some declared timezone. */
export type DayKey = string

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A date/time string carrying **no zone** — a bare date, or the
 * `YYYY-MM-DD HH:mm:ss` a `timestamp` column reads back as.
 *
 * These are not instants. The runtime maps a spec `date` field to a
 * `timestamp` (without time zone), so the stored value is a wall clock and
 * nothing more: it already *is* the local reading, and re-projecting it through
 * a zone would move it by the offset — the "my 9am meeting shows at 4am" bug,
 * arrived at from the other direction. Only a value that carries an offset (or a
 * `Z`) is converted, because only that one names an instant.
 */
const ZONELESS_RE =
	/^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/

const formatters = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(timezone: string): Intl.DateTimeFormat {
	let fmt = formatters.get(timezone)
	if (!fmt) {
		// `en-CA` renders exactly `YYYY-MM-DD`, which is the day key format.
		fmt = new Intl.DateTimeFormat('en-CA', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		})
		formatters.set(timezone, fmt)
	}
	return fmt
}

/**
 * The day a stored date value falls on, read in `timezone`, or `null` when the
 * value is absent or unparseable.
 *
 * A **zone-less** value — a bare `YYYY-MM-DD`, or the `YYYY-MM-DD HH:mm:ss` a
 * `timestamp` column reads back as — is already a local reading, so its date
 * part is returned unchanged. Parsing it as UTC and re-zoning is how "the 1st"
 * becomes "the 31st" in every timezone west of UTC.
 */
export function dayKeyOf(value: unknown, timezone: string): DayKey | null {
	if (value == null) return null
	if (typeof value === 'string') {
		const zoneless = ZONELESS_RE.exec(value)
		if (zoneless) return zoneless[1] as DayKey
	}
	const at =
		value instanceof Date
			? value
			: typeof value === 'string' || typeof value === 'number'
				? new Date(value)
				: null
	if (!at || Number.isNaN(at.getTime())) return null
	return dayFormatter(timezone).format(at)
}

/** `2026-08-04` → `{ year: 2026, month: 8, day: 4 }`. */
function parts(day: DayKey): { year: number; month: number; day: number } {
	const [year, month, date] = day.split('-').map(Number)
	return { year: year ?? 1970, month: month ?? 1, day: date ?? 1 }
}

/** A day key as a UTC-noon timestamp — the arithmetic carrier. Noon, not
 * midnight, so nothing here can be knocked into an adjacent day by rounding. */
function noon(day: DayKey): number {
	const { year, month, day: d } = parts(day)
	return Date.UTC(year, month - 1, d, 12)
}

function keyOfNoon(ms: number): DayKey {
	return new Date(ms).toISOString().slice(0, 10)
}

/** Whether `value` is a well-formed day key naming a real calendar day. */
export function isDayKey(value: unknown): value is DayKey {
	if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false
	return keyOfNoon(noon(value)) === value
}

/** `n` days after `day` (negative goes back). Pure calendar arithmetic — no
 * zone is involved, because a day key names a day and not an instant. */
export function addDays(day: DayKey, n: number): DayKey {
	return keyOfNoon(noon(day) + n * 86_400_000)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: DayKey, to: DayKey): number {
	return Math.round((noon(to) - noon(from)) / 86_400_000)
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export function weekday(day: DayKey): number {
	return new Date(noon(day)).getUTCDay()
}

/**
 * The Monday of `day`'s week.
 *
 * Monday rather than Sunday, unconditionally: a *weekly planner* is the corpus
 * ask this view exists for, the working week is the unit people plan in, and a
 * per-locale first day would make the same spec render a different grid for two
 * viewers — which is the class of bug the declared timezone exists to prevent.
 */
export function weekStart(day: DayKey): DayKey {
	const dow = weekday(day)
	return addDays(day, dow === 0 ? -6 : 1 - dow)
}

/** The first day of `day`'s month. */
export function monthStart(day: DayKey): DayKey {
	const { year, month } = parts(day)
	return keyOfNoon(Date.UTC(year, month - 1, 1, 12))
}

/** Days in `day`'s month. */
export function daysInMonth(day: DayKey): number {
	const { year, month } = parts(day)
	return new Date(Date.UTC(year, month, 0, 12)).getUTCDate()
}

/** `n` consecutive days starting at `from`. */
export function daySpan(from: DayKey, n: number): DayKey[] {
	return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(from, i))
}

/**
 * The full weeks covering `anchor`'s month — always whole Monday→Sunday rows, so
 * the grid is rectangular and the leading/trailing days of the neighbouring
 * months are real days an entry can be dropped on rather than blank padding.
 */
export function monthGrid(anchor: DayKey): DayKey[] {
	const first = weekStart(monthStart(anchor))
	const lastDay = addDays(monthStart(anchor), daysInMonth(anchor) - 1)
	const weeks = Math.ceil((daysBetween(first, lastDay) + 1) / 7)
	return daySpan(first, weeks * 7)
}

/** The 7 days of `anchor`'s week, Monday first. */
export function weekGrid(anchor: DayKey): DayKey[] {
	return daySpan(weekStart(anchor), 7)
}

/**
 * The trailing `weeks` full weeks ending with `anchor`'s week — the
 * contribution-graph window a heatmap draws.
 */
export function heatmapGrid(anchor: DayKey, weeks = 53): DayKey[] {
	const end = weekStart(anchor)
	return daySpan(addDays(end, -(weeks - 1) * 7), weeks * 7)
}

/**
 * The days an entry occupies: `[start]` when it has no end, or every day from
 * start to end inclusive. An end *before* the start is treated as a single day
 * rather than an empty range — stored data can always disagree with itself, and
 * a row that silently disappears from a calendar is worse than one drawn short.
 */
export function entryDays(start: DayKey, end?: DayKey | null): DayKey[] {
	if (!end) return [start]
	const span = daysBetween(start, end)
	return span <= 0 ? [start] : daySpan(start, span + 1)
}

/** Human day label, e.g. `Tue 4 Aug` — rendered from the key, never re-zoned. */
export function formatDayLabel(
	day: DayKey,
	options: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
	},
): string {
	// The key is already the local day, so it is formatted as a UTC instant to
	// keep the formatter from shifting it back into another zone.
	return new Intl.DateTimeFormat(undefined, {
		...options,
		timeZone: 'UTC',
	}).format(new Date(noon(day)))
}
