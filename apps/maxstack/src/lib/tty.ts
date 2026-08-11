/**
 * The terminal presentation layer: color, glyphs, and the two questions
 * everything else asks before writing to a terminal — *is anyone watching*, and
 * *can they render this character*.
 *
 * A tiny ANSI + glyph module instead of a color dependency, which is the same
 * trade the CLI makes everywhere else. It exists as a module rather than as a
 * block at the bottom of a command because it had already been copied twice
 * (`init.ts` and `start.ts`, the second annotated "mirrors init.ts"), and the
 * copies had drifted: one evaluated its glyphs lazily and the other froze them
 * at import time, so under `LANG=C` the two commands disagreed about whether
 * this terminal can draw `✔`. Lazy is the correct half — the environment is not
 * knowable at module-load time, least of all in a test — so that is what is
 * here.
 *
 * Two independent switches, deliberately not collapsed into one:
 *
 *   - **color** follows `process.stdout.isTTY` and `NO_COLOR`, so piped output
 *     is clean plain text.
 *   - **glyphs** follow the locale, so a legacy shell gets ASCII rather than
 *     mojibake.
 *
 * A pipe on a UTF-8 machine still gets `✔`: it is a character, not a color
 * code, and stripping it would change what a script downstream reads.
 */

/**
 * Whether to emit ANSI color. False when output is redirected (a pipe, CI, the
 * test mocks) or the user set `NO_COLOR`.
 *
 * Read per call, never cached: `process.stdout.isTTY` is not stable across a
 * test that swaps the stream, and the cost is a property read.
 */
export const useColor = (): boolean =>
	Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const wrap =
	(open: number, close: number) =>
	(s: string): string =>
		useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : s

export const dim = wrap(2, 22)
export const bold = wrap(1, 22)
export const green = wrap(32, 39)
export const cyan = wrap(36, 39)
export const yellow = wrap(33, 39)
export const red = wrap(31, 39)

/**
 * Whether the terminal's locale can be expected to render non-ASCII. An unset
 * locale is treated as UTF-8: that is the modern default, and the failure it
 * risks (a stray `?`) is milder than the one it avoids (ASCII output on every
 * machine that simply does not export `LANG`).
 */
export const isUtf8 = (): boolean => {
	const enc = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG
	return !enc || /utf-?8/i.test(enc)
}

/**
 * Box-drawing and status glyphs, with an ASCII fallback each.
 *
 * Getters, not constants: the locale is read at the moment of rendering. The
 * frozen-at-import spelling this replaces could not be tested at all without
 * re-importing the module.
 */
export const glyphs = {
	get check() {
		return isUtf8() ? '✔' : 'ok'
	},
	get cross() {
		return isUtf8() ? '✖' : 'x'
	},
	get mid() {
		return isUtf8() ? '·' : '-'
	},
	get dash() {
		return isUtf8() ? '—' : '--'
	},
	get branch() {
		return isUtf8() ? '├' : '|'
	},
	get pointer() {
		return isUtf8() ? '›' : '>'
	},
}
