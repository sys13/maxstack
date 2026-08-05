/**
 * The three built-in import readers, and the one property they all
 * have: **they never hold the file.**
 *
 * Each is an async generator from a stream of chunks to a stream of records, so
 * memory is proportional to the widest single record rather than to the upload.
 * That is a gating bullet of the issue ("bounded memory on large files —
 * streaming, not read-whole-file") and it is structural here rather than
 * aspirational: none of these functions is handed the whole input, so none of
 * them can retain it. The *plan* built downstream is bounded separately, by the
 * importer's declared `maxRows`.
 *
 * ## Every parser yields the same thing
 *
 * `Record<string, string>` — a record keyed by column name, with **string
 * values**, from CSV, from NDJSON, from a JSON array, and from a user-owned
 * parser slot alike. Non-string JSON values are re-serialized on the way out
 * (objects and arrays as JSON, scalars as their text form).
 *
 * That uniformity is the point rather than a simplification. It is what lets the
 * bespoke half of this feature stop at *parsing*: a `.apkg` reader hands back the
 * same shape a CSV does, so the mapping, the per-row validation, the upsert
 * lookup and the write path downstream are byte-for-byte the same code. If a
 * custom parser could return richer values, it would be able to reach places a
 * CSV cannot, and the slot would have become a bypass — which is the same
 * argument #173 makes about re-typing a refiner's return value.
 *
 * A cell's *meaning* is recovered downstream from the target column's declared
 * type, exactly as `SourceMapping` recovers it from the column rather than from a
 * second type declaration that could drift.
 */

/** One parsed record: column name → raw cell text. */
export type ImportRecord = Record<string, string>

/**
 * A parser: chunks in, records out.
 *
 * This is also the type of the user-owned slot a `format: 'custom'` importer
 * names. The signature is deliberately the *whole* contract — a parser gets
 * bytes and returns records, and has no access to the store, the registry, the
 * user or the plan. It cannot write, and it cannot see a row.
 */
export type ImportParser = (
	chunks: AsyncIterable<Uint8Array>,
) => AsyncIterable<ImportRecord>

/**
 * Chunks of bytes (or of already-decoded text) as a string stream.
 *
 * `TextDecoder` in streaming mode is what makes a multi-byte character split
 * across a chunk boundary survive: decoding each chunk independently would
 * corrupt exactly one character somewhere in the middle of a large file, which
 * is the kind of bug that gets reported as "the import mangled one row".
 */
export async function* decodeChunks(
	chunks: AsyncIterable<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<string> {
	const decoder = new TextDecoder('utf-8')
	for await (const chunk of chunks) {
		if (typeof chunk === 'string') yield chunk
		else yield decoder.decode(chunk, { stream: true })
	}
	// The flush is not optional: a truncated multi-byte sequence at EOF has to
	// surface as a replacement character rather than being dropped silently.
	const tail = decoder.decode()
	if (tail) yield tail
}

/** A JSON value as a cell: objects and arrays re-serialized, scalars as text. */
export function cellText(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'object') return JSON.stringify(value)
	return String(value)
}

/** A decoded JSON object as an {@link ImportRecord}. Non-objects are refused. */
function recordOf(value: unknown, what: string): ImportRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error(
			`${what} is not an object — an import record maps column names to values, and an array or a scalar has no column names`,
		)
	const out: ImportRecord = {}
	for (const [key, raw] of Object.entries(value as Record<string, unknown>))
		out[key] = cellText(raw)
	return out
}

// ===========================================================================
// CSV
// ===========================================================================

/**
 * RFC 4180 CSV, read a character at a time.
 *
 * The state machine is small on purpose and handles the three things real
 * exports actually contain: quoted fields with embedded commas and newlines,
 * `""` as an escaped quote, and `\r\n` line endings. What it does **not** do is
 * guess — no delimiter sniffing, no encoding detection, no "looks like a
 * semicolon-separated European export". A guess that is right most of the time
 * is a guess that mis-parses one customer's file into plausible-looking wrong
 * rows, which the dry-run would then faithfully report as fine.
 *
 * The first record is the header. A file whose header repeats a column name is
 * refused rather than resolved by position: two columns called `Front` in one
 * file means the mapping's `Front` is ambiguous, and picking either one silently
 * is how the wrong column gets imported.
 */
export async function* parseCsv(
	chunks: AsyncIterable<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<ImportRecord> {
	let header: string[] | null = null
	for await (const row of csvRows(chunks)) {
		if (header === null) {
			header = row.map((h) => h.trim())
			const seen = new Set<string>()
			for (const name of header) {
				if (seen.has(name))
					throw new Error(
						`the file's header repeats the column "${name}" — which of the two a mapping means is not decidable, and picking one silently is how the wrong column gets imported`,
					)
				seen.add(name)
			}
			continue
		}
		// A wholly empty line is separator noise, not a row of empty values. Every
		// spreadsheet tool emits a trailing one.
		if (row.length === 1 && (row[0] ?? '').trim() === '') continue
		const record: ImportRecord = {}
		header.forEach((name, i) => {
			record[name] = row[i] ?? ''
		})
		yield record
	}
}

/** The character-level half of {@link parseCsv}: chunks → arrays of cells. */
async function* csvRows(
	chunks: AsyncIterable<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<string[]> {
	let row: string[] = []
	let cell = ''
	let quoted = false
	// True immediately after a closing quote, so `""` inside a quoted cell is one
	// literal quote and `"a"b` is a parse the reader does not silently accept.
	let closed = false
	let started = false
	let pendingCr = false

	const endCell = () => {
		row.push(cell)
		cell = ''
		closed = false
	}

	for await (const text of decodeChunks(chunks)) {
		for (const char of text) {
			if (pendingCr) {
				pendingCr = false
				// `\r\n` is one terminator; a lone `\r` (classic Mac) is also one.
				if (char === '\n') continue
			}
			if (quoted) {
				if (closed) {
					closed = false
					if (char === '"') {
						cell += '"'
						closed = false
						continue
					}
					quoted = false
					// fall through: this character terminates the cell or the row
				} else if (char === '"') {
					closed = true
					continue
				} else {
					cell += char
					continue
				}
			}
			if (char === '"' && cell === '') {
				quoted = true
				started = true
				continue
			}
			if (char === ',') {
				endCell()
				started = true
				continue
			}
			if (char === '\n' || char === '\r') {
				pendingCr = char === '\r'
				endCell()
				yield row
				row = []
				started = false
				continue
			}
			cell += char
			started = true
		}
	}
	if (started || cell !== '' || row.length > 0) {
		endCell()
		yield row
	}
}

// ===========================================================================
// NDJSON
// ===========================================================================

/**
 * Newline-delimited JSON: one object per line, parsed as the line completes.
 *
 * The naturally streaming format, and the one worth preferring for a large
 * export — which the docs say, because the alternative is somebody discovering
 * the JSON-array reader's constant factor on a 400MB file.
 */
export async function* parseNdjson(
	chunks: AsyncIterable<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<ImportRecord> {
	let buffer = ''
	let line = 0
	const emit = function* (raw: string): Generator<ImportRecord> {
		const text = raw.trim()
		if (text === '') return
		line++
		let value: unknown
		try {
			value = JSON.parse(text)
		} catch {
			throw new Error(`line ${line} is not valid JSON`)
		}
		yield recordOf(value, `line ${line}`)
	}
	for await (const text of decodeChunks(chunks)) {
		buffer += text
		let newline = buffer.indexOf('\n')
		while (newline !== -1) {
			yield* emit(buffer.slice(0, newline))
			buffer = buffer.slice(newline + 1)
			newline = buffer.indexOf('\n')
		}
	}
	yield* emit(buffer)
}

// ===========================================================================
// A JSON array
// ===========================================================================

/**
 * A top-level JSON array of objects, scanned incrementally.
 *
 * `JSON.parse` on the whole document would be the two-line version and is the
 * thing this deliberately is not: it materializes the entire file *and* its
 * parsed form at once, so a 200MB export costs upwards of a gigabyte before a
 * single row is validated. The scanner below tracks depth, string state and
 * escapes to find each element's boundaries, then parses **one element at a
 * time** — so the peak cost is one record, matching CSV and NDJSON.
 *
 * It is a scanner rather than a full streaming JSON parser because it only ever
 * has to answer one question: where does this element end. Everything else is
 * still `JSON.parse`'s job, which is what keeps this ~60 lines instead of a
 * dependency, and keeps the *parsing* of a value byte-identical to the other two
 * readers.
 *
 * A document that is not an array is refused with the sentence saying so —
 * pointing at NDJSON, because "my export is one big object" is a real shape and
 * the honest answer is a different format, not a nested path expression.
 */
export async function* parseJsonArray(
	chunks: AsyncIterable<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<ImportRecord> {
	let buffer = ''
	let started = false
	let done = false
	let index = 0

	/** Scan `buffer` for whole elements, yielding and consuming each. */
	function* drain(final: boolean): Generator<ImportRecord> {
		let cursor = 0
		while (cursor < buffer.length) {
			// Between elements: skip whitespace and separators.
			while (cursor < buffer.length && /[\s,]/.test(buffer[cursor] ?? ''))
				cursor++
			if (cursor >= buffer.length) break
			if (buffer[cursor] === ']') {
				done = true
				cursor = buffer.length
				break
			}
			const end = elementEnd(buffer, cursor)
			if (end === -1) break // incomplete — wait for more bytes
			const text = buffer.slice(cursor, end)
			index++
			let value: unknown
			try {
				value = JSON.parse(text)
			} catch {
				throw new Error(`element ${index} is not valid JSON`)
			}
			yield recordOf(value, `element ${index}`)
			cursor = end
		}
		buffer = buffer.slice(cursor)
		if (final && !done && buffer.trim() !== '' && buffer.trim() !== ']')
			throw new Error(
				'the file ended in the middle of a JSON value — it is truncated',
			)
	}

	for await (const text of decodeChunks(chunks)) {
		buffer += text
		if (!started) {
			const open = buffer.search(/\S/)
			if (open === -1) continue
			if (buffer[open] !== '[')
				throw new Error(
					'a "json" import expects a top-level ARRAY of objects. A single object, or an array nested under a key, is a different shape — export it as NDJSON (one object per line), which streams anyway',
				)
			buffer = buffer.slice(open + 1)
			started = true
		}
		if (done) continue
		yield* drain(false)
	}
	if (!started)
		throw new Error('the file is empty — there is nothing to import')
	if (!done) yield* drain(true)
}

/**
 * The index just past the JSON value starting at `from`, or `-1` when the buffer
 * does not yet contain all of it.
 *
 * Only structural characters matter: a `{`/`[` deepens, a `}`/`]` shallows, and
 * everything inside a string is opaque. The escape handling is the part that has
 * to be right — a `"` preceded by a backslash does not close a string, and a
 * `\\` at the end of one does.
 */
function elementEnd(text: string, from: number): number {
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = from; i < text.length; i++) {
		const char = text[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === '\\') escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
			continue
		}
		if (char === '{' || char === '[') depth++
		else if (char === '}' || char === ']') {
			depth--
			if (depth === 0) return i + 1
			if (depth < 0) return i // the array's own closing bracket
		} else if (depth === 0 && (char === ',' || /\s/.test(char ?? ''))) {
			// A scalar element (which `recordOf` will reject) ends at the separator.
			return i
		}
	}
	return -1
}

/** The reader for a declared format, or `null` for `custom` (the slot's job). */
export function builtinParser(format: string): ImportParser | null {
	switch (format) {
		case 'csv':
			return parseCsv
		case 'ndjson':
			return parseNdjson
		case 'json':
			return parseJsonArray
		default:
			return null
	}
}
