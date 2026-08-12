/**
 * Searching the referenced resource from an FK picker (#442).
 *
 * ## The bug this exists for
 *
 * A loader lists the referenced table into `{ label, value }` choices and hands
 * them to the picker, which filtered them **client-side**. That list is one
 * page — `REFERENCE_OPTION_PAGE` rows — so on any referenced table bigger than
 * a page:
 *
 *  - a record past the page could not be selected at all. Typing its exact name
 *    said "No matches"; the FK was unsettable through the UI, and the only way
 *    to point at it was REST or MCP.
 *  - a record whose FK already pointed past the page opened with a **blank**
 *    picker, because no loaded option carried that id's label. The form was
 *    telling the user something false about stored data.
 *
 * Neither was announced. A short list looks exactly like a complete one.
 *
 * ## What replaces it
 *
 * The picker keeps the loader's page as what it shows before anyone types, and
 * asks the server for anything else — through the ordinary `DataProvider`, which
 * is `GET /api/:resource?search=&searchField=`, the query that route already
 * documents as existing "for the FK autocomplete". Two consequences worth being
 * explicit about:
 *
 * 1. **Nothing widens.** The search goes through `opList`, so the tenant scope,
 *    the soft-delete scope and a portal's declared bound are all still forced
 *    last, exactly as they are for the loader's own page. A picker cannot become
 *    a way to read a row the viewer's list would not show.
 * 2. **The page is a page, and says so.** When the loader's list is full there
 *    is no way to know from here whether one more row exists or a million, so
 *    the picker states what it has rather than implying it is everything.
 *
 * The provider is read with {@link useOptionalDataProvider}: with no data layer
 * in context the picker behaves exactly as it did before this module existed.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalDataProvider } from '../data/data-context.tsx'
import type { IntrospectedColumn } from '../fields/field-semantics.ts'
import type { AutocompleteOption } from '../ui/form-fields.tsx'

/**
 * How many referenced records a loader preloads into a picker, and how many one
 * search returns.
 *
 * Shared rather than restated: `referenceFieldOptions` in `apps/web` reads the
 * same constant, so "is this list a full page?" — the question that decides
 * whether the picker admits to being truncated — is answered against the number
 * that actually produced the list.
 */
export const REFERENCE_OPTION_PAGE = 100

/** How long typing settles before a search goes out. */
const SEARCH_DEBOUNCE_MS = 200

/** What a picker needs to ask the server about the resource it points at. */
export interface ReferenceSearchPlan {
	/** The referenced resource, as the REST surface names it. */
	resource: string
	/** The referenced record's id column — the value the picker submits. */
	idField: string
	/** The column a person reads. Absent when the target has no title field, and
	 * then there is nothing to substring-match, so no plan is built at all. */
	labelField: string
}

/**
 * The plan for one column, or `undefined` when the picker cannot search.
 *
 * Two reasons it may not be able to. A column that references nothing is not a
 * picker. And a reference with no display field has only ids to show, so a
 * substring query would match nothing and `?searchField=` naming a column that
 * does not exist is *skipped* by the store — a search that silently returns the
 * unfiltered table. Refusing to build a plan keeps that case on the old
 * client-side path, where at least the list is honest about being the loader's.
 */
export function referenceSearchPlan(
	column: IntrospectedColumn,
): ReferenceSearchPlan | undefined {
	const ref = column.references ?? column.meta?.arrayReference
	if (!ref?.table || !ref.column) return undefined
	if (!ref.displayField) return undefined
	return {
		resource: ref.table,
		idField: ref.column,
		labelField: ref.displayField,
	}
}

/** Map one row of the referenced resource onto a picker choice. */
function toOption(
	row: Record<string, unknown>,
	plan: ReferenceSearchPlan,
): AutocompleteOption {
	const value = String(row[plan.idField] ?? '')
	const label = row[plan.labelField]
	return { label: label == null ? value : String(label), value }
}

export interface ReferenceSearchState {
	/** The choices to render: the loader's page, or the server's answer. */
	options: AutocompleteOption[]
	/** These options ARE the answer to the current query, so the caller must not
	 * filter them again — the server matched the declared search field, and a
	 * second pass over the rendered label would narrow by a different rule and
	 * drop rows the server said match. False whenever the list is still local,
	 * including when a plan exists but no data layer does. */
	fromServer: boolean
	/** A request is in flight for the current query. */
	searching: boolean
	/** The search failed. The picker says so instead of rendering "No matches",
	 * which would be a claim about the data rather than about the request. */
	failed: boolean
	/** The loader's page is full, so there may be records not in it. Only ever
	 * true while idle — once a query is typed the list is the server's answer,
	 * and its own fullness is the same statement one level down. */
	pageIsFull: boolean
	/** Typing reaches the server. False with no plan or no data layer, and then
	 * a full page is a wall rather than a starting point — which is a different
	 * sentence to say to the user. */
	canSearch: boolean
}

/**
 * The options a picker should show for `query`, and what it may honestly say
 * about them.
 *
 * `extra` is the caller's locally-minted options (create-inline's), kept visible
 * across searches because a record created a second ago and then filtered out by
 * a stale server page would look like a failed create.
 */
export function useReferenceSearch({
	plan,
	options,
	query,
	extra = [],
}: {
	plan?: ReferenceSearchPlan
	options: readonly AutocompleteOption[]
	query: string
	extra?: readonly AutocompleteOption[]
}): ReferenceSearchState {
	const dataProvider = useOptionalDataProvider()
	const trimmed = query.trim()
	const canSearch = plan !== undefined && dataProvider !== null
	const [result, setResult] = useState<{
		query: string
		options: AutocompleteOption[]
	}>()
	const [searching, setSearching] = useState(false)
	const [failed, setFailed] = useState(false)
	// Only the newest query may write state: a slow request for "ab" landing
	// after a fast one for "abc" would repopulate the list with the wrong page.
	const latest = useRef(0)

	useEffect(() => {
		if (!canSearch || trimmed === '') {
			setSearching(false)
			setFailed(false)
			return
		}
		const ticket = ++latest.current
		setSearching(true)
		setFailed(false)
		const timer = setTimeout(() => {
			void dataProvider
				.getList(plan.resource, {
					search: trimmed,
					searchFields: [plan.labelField],
					pagination: { page: 1, perPage: REFERENCE_OPTION_PAGE },
				})
				.then((page) => {
					if (ticket !== latest.current) return
					setResult({
						query: trimmed,
						options: page.data.map((row) => toOption(row, plan)),
					})
					setSearching(false)
				})
				.catch(() => {
					if (ticket !== latest.current) return
					setFailed(true)
					setSearching(false)
				})
		}, SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [canSearch, dataProvider, plan, trimmed])

	return useMemo(() => {
		const local = [...options, ...extra]
		if (!canSearch) {
			// No data layer: the loader's page, filtered where it stands. Unchanged
			// behaviour, including its limits.
			return {
				options: local,
				fromServer: false,
				searching: false,
				failed: false,
				// Still worth saying. Without a search this page is a wall, not a
				// starting point, and a wall the user cannot see is the whole bug.
				pageIsFull: trimmed === '' && options.length >= REFERENCE_OPTION_PAGE,
				canSearch: false,
			}
		}
		if (trimmed === '')
			return {
				options: local,
				fromServer: false,
				searching: false,
				failed: false,
				pageIsFull: options.length >= REFERENCE_OPTION_PAGE,
				canSearch: true,
			}
		// A query with no answer yet keeps showing the local page rather than
		// blanking — the previous result would be a lie about a query nobody typed,
		// and an empty list would read as "no such record".
		const fresh = result?.query === trimmed
		const server = fresh ? result.options : undefined
		const merged = server
			? [
					...server,
					...extra.filter((o) => !server.some((s) => s.value === o.value)),
				]
			: local
		return {
			options: merged,
			fromServer: server !== undefined,
			searching,
			failed,
			pageIsFull: false,
			canSearch: true,
		}
	}, [canSearch, extra, failed, options, result, searching, trimmed])
}

/**
 * The label for a selected id that is not in any loaded option — the blank-
 * picker half of #442.
 *
 * A record whose FK points past the loader's page has an id and no label here,
 * and the picker used to render the placeholder for it, which reads as "unset".
 * One `getOne` for the referenced record fixes it. A failure resolves to
 * `undefined`, and the caller falls back to showing the raw id: an id is ugly
 * and true, where a placeholder is tidy and false.
 */
export function useResolvedReferenceLabel({
	plan,
	value,
	known,
}: {
	plan?: ReferenceSearchPlan
	value: string
	known: boolean
}): AutocompleteOption | undefined {
	const dataProvider = useOptionalDataProvider()
	const [resolved, setResolved] = useState<AutocompleteOption>()
	const missing =
		plan !== undefined && dataProvider !== null && !known && value !== ''

	useEffect(() => {
		if (!missing) return
		if (resolved?.value === value) return
		let live = true
		void dataProvider
			.getOne(plan.resource, value)
			.then((row) => {
				if (live) setResolved(toOption(row, plan))
			})
			.catch(() => {
				// Unreadable or gone — the caller shows the id.
			})
		return () => {
			live = false
		}
	}, [dataProvider, missing, plan, resolved, value])

	return resolved?.value === value ? resolved : undefined
}
