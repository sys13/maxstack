import { useCallback, useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

/**
 * "Describe it, we'll fill the form" — a free-text box that posts to the
 * page's `POST /:page/parse` action (`entity-parse.server`) and hands the
 * extracted `{ fields }` to the parent, which prefills its form with them.
 * Every failure mode (no AI configured, unparseable reply, nothing
 * recognized) degrades to the same message: fill the form by hand — the form
 * below is always the source of truth, this only saves typing.
 *
 * Two modes. With no `existing` values this is the create-form
 * panel it started as. Given `existing`, it becomes "paste an update": the
 * extraction is a *patch*, and {@link mergeFields} decides whether the fields
 * the text never mentioned survive.
 *
 * Dictation is the same endpoint by another route — the Web Speech API
 * transcribes in the browser and only the transcript is posted, so audio never
 * reaches the server. Unsupported browsers simply do not get the button.
 *
 * With no AI provider configured the panel does not render at all.
 * `isAiConfigured` decides that from the environment in the loader, so the
 * answer is in the first byte of markup rather than at the end of a round-trip
 * the user reached by typing a description first. Dictation made that worse:
 * Web Speech runs entirely in the browser, so the button worked, recorded, and
 * stranded a transcript in a box whose only consumer was unreachable.
 */

/**
 * Apply an extraction to the values already in the form.
 *
 * `merge` keeps every current value the text did not mention, which is what
 * "paste an update" means — describing a status change must not blank the
 * fields you didn't talk about. `replace` starts from the record's identity
 * (the key fields the caller pins) and drops the rest, for when the text is
 * meant to be the whole record.
 *
 * Extracted keys always win over current values in both modes; that is the
 * point of running it.
 */
export function mergeFields(
	existing: Record<string, unknown>,
	extracted: Record<string, unknown>,
	mode: 'merge' | 'replace',
	keep: readonly string[] = [],
): Record<string, unknown> {
	const base =
		mode === 'merge'
			? { ...existing }
			: Object.fromEntries(
					keep
						.filter((k) => k in existing)
						.map((k) => [k, existing[k]] as const),
				)
	return { ...base, ...extracted }
}

/** The vendor-prefixed constructor, still the only one Chrome and Safari ship. */
function speechRecognition(): (new () => SpeechRecognitionLike) | null {
	if (typeof window === 'undefined') return null
	const w = window as unknown as {
		SpeechRecognition?: new () => SpeechRecognitionLike
		webkitSpeechRecognition?: new () => SpeechRecognitionLike
	}
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** The sliver of the Web Speech API this uses — the DOM lib does not declare it. */
interface SpeechRecognitionLike {
	continuous: boolean
	interimResults: boolean
	lang: string
	start(): void
	stop(): void
	onresult:
		| ((event: {
				resultIndex: number
				results: ArrayLike<
					ArrayLike<{ transcript: string }> & { isFinal: boolean }
				>
		  }) => void)
		| null
	onerror: (() => void) | null
	onend: (() => void) | null
}

interface DescribePrefillProps {
	/** The parse endpoint, e.g. `/contacts/parse`. */
	action: string
	/** Called with the fields to prefill whenever a parse succeeds. */
	onFields: (fields: Record<string, unknown>) => void
	/**
	 * Whether an AI provider is configured, from the loader's `isAiConfigured`.
	 * Required rather than defaulted to `true`, so a new form that forgets to
	 * thread it fails to compile instead of quietly re-offering the dead end.
	 */
	available: boolean
	/**
	 * The record's current values. Present on an edit form, absent on a create
	 * form — which is also what switches the copy and reveals the merge control.
	 */
	existing?: Record<string, unknown>
	/** Fields that survive a `replace` — the primary key and friends. */
	keepOnReplace?: readonly string[]
}

/**
 * The unavailable case is handled here rather than by an early `return null`
 * inside the panel: hooks cannot be skipped, and one of the panel's effects
 * holds a microphone. Not rendering the panel at all is the only way for "no
 * provider" to mean no recognizer, no fetcher and no markup.
 */
export function DescribePrefill(props: DescribePrefillProps) {
	if (!props.available) return null
	return <DescribePrefillPanel {...props} />
}

function DescribePrefillPanel({
	action,
	onFields,
	existing,
	keepOnReplace = [],
}: DescribePrefillProps) {
	const fetcher = useFetcher<
		{ fields?: Record<string, unknown> } & { error?: string }
	>()
	const [text, setText] = useState('')
	const [mode, setMode] = useState<'merge' | 'replace'>('merge')
	const [listening, setListening] = useState(false)
	const [supportsVoice, setSupportsVoice] = useState(false)
	const recognition = useRef<SpeechRecognitionLike | null>(null)
	const busy = fetcher.state !== 'idle'
	const fields = fetcher.data?.fields
	const editing = existing !== undefined

	// Feature detection runs after mount: the server render cannot know, and
	// deciding during render would emit markup the client immediately contradicts.
	useEffect(() => {
		setSupportsVoice(speechRecognition() !== null)
	}, [])

	// `existing`/`mode` are read at apply time but deliberately not dependencies —
	// re-running this on every keystroke in the form would re-apply a stale
	// extraction over what the user has since typed.
	const latest = useRef({ existing, mode, keepOnReplace, onFields })
	latest.current = { existing, mode, keepOnReplace, onFields }
	useEffect(() => {
		if (!fields || Object.keys(fields).length === 0) return
		const {
			existing: current,
			mode: how,
			keepOnReplace: keep,
			onFields: emit,
		} = latest.current
		emit(current ? mergeFields(current, fields, how, keep) : fields)
	}, [fields])

	const stopListening = useCallback(() => {
		recognition.current?.stop()
		recognition.current = null
		setListening(false)
	}, [])

	// A live recognizer holds the microphone; unmounting the panel without
	// stopping it leaves the browser's recording indicator on.
	useEffect(() => () => recognition.current?.stop(), [])

	const startListening = useCallback(() => {
		const Recognition = speechRecognition()
		if (!Recognition) return
		const engine = new Recognition()
		engine.continuous = true
		engine.interimResults = true
		engine.lang = navigator.language || 'en-US'
		// Only final segments are appended. Interim results are re-emitted as they
		// are revised, so appending them duplicates every phrase as it settles.
		engine.onresult = (event) => {
			let settled = ''
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i]
				if (result?.isFinal) settled += result[0]?.transcript ?? ''
			}
			if (settled) {
				setText((prior) =>
					(prior ? `${prior.trimEnd()} ${settled}` : settled).trimStart(),
				)
			}
		}
		// A denied microphone permission and a silence timeout arrive the same way.
		// Neither is worth an error message: the textarea is right there.
		engine.onerror = () => stopListening()
		engine.onend = () => setListening(false)
		recognition.current = engine
		setListening(true)
		try {
			engine.start()
		} catch {
			stopListening()
		}
	}, [stopListening])

	const count = fields ? Object.keys(fields).length : 0
	// `ai-unavailable` is not an outage — it is "no key is configured", and it
	// will still be true tomorrow. Saying "right now" sent people away to wait
	// for a service that was never coming back, with nothing in `init`, the
	// `.env.example` or this message naming `ANTHROPIC_API_KEY`.
	// A model that answered but answered badly (`unparseable`) genuinely is
	// transient, so the two no longer share a sentence.
	const status = busy
		? 'Reading…'
		: fetcher.data == null
			? null
			: fetcher.data.error === 'ai-unavailable'
				? 'No AI provider is configured — set ANTHROPIC_API_KEY in this project’s .env and restart. Until then, fill the form by hand.'
				: fields == null
					? 'The AI reply could not be read — try again, or fill the form by hand.'
					: count === 0
						? 'Nothing recognized — fill the form by hand.'
						: `${editing ? 'Updated' : 'Filled'} ${count} field${count === 1 ? '' : 's'} below — review before saving.`

	return (
		<section className="mb-6 rounded-md border border-dashed border-border p-3">
			<label
				htmlFor="describe-prefill"
				className="mb-1.5 block text-sm font-medium"
			>
				{editing ? 'Describe the change' : 'Describe it'}
			</label>
			<textarea
				id="describe-prefill"
				value={text}
				onChange={(e) => setText(e.target.value)}
				rows={3}
				placeholder={
					editing
						? "Paste an update in your own words — we'll adjust the fields it mentions."
						: "In your own words — we'll fill in the form for you."
				}
				className="mb-1.5 w-full box-border rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
			/>
			{editing ? (
				<fieldset className="mb-2 flex flex-wrap items-center gap-3 border-0 p-0 text-sm">
					<legend className="sr-only">
						What to do with fields your text does not mention
					</legend>
					{(
						[
							['merge', 'Keep the fields it does not mention'],
							['replace', 'Clear the fields it does not mention'],
						] as const
					).map(([value, label]) => (
						<label key={value} className="flex items-center gap-1.5">
							<input
								type="radio"
								name="describe-prefill-mode"
								value={value}
								checked={mode === value}
								onChange={() => setMode(value)}
							/>
							<span className="text-muted-foreground">{label}</span>
						</label>
					))}
				</fieldset>
			) : null}
			{/* Wrapping, with unshrinkable buttons: a long status string used to
			    compress its siblings instead of moving to the next line, folding
			    "Fill the form" into three stacked words. */}
			<div className="flex flex-wrap items-center gap-3">
				<button
					type="button"
					disabled={busy || text.trim() === ''}
					onClick={() =>
						fetcher.submit(
							{ text },
							{ method: 'post', action, encType: 'application/json' },
						)
					}
					className="shrink-0 rounded-md border border-border bg-muted px-3 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
				>
					{editing ? 'Apply to the form' : 'Fill the form'}
				</button>
				{supportsVoice ? (
					<button
						type="button"
						onClick={() => (listening ? stopListening() : startListening())}
						aria-pressed={listening}
						className="shrink-0 rounded-md border border-border bg-muted px-3 py-1 text-sm hover:bg-accent"
					>
						{listening ? '◼ Stop' : '● Dictate'}
					</button>
				) : null}
				{status ? (
					<span className="text-sm text-muted-foreground">{status}</span>
				) : null}
			</div>
		</section>
	)
}
