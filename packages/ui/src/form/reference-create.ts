/**
 * Creating the referenced record from inside the FK picker (#443).
 *
 * ## What was already there, and why it did nothing
 *
 * `<FormAutocomplete>` and `<FormReferenceArrayInput>` have both implemented
 * create-inline since Plan v5: an unmatched, non-exact query offers a "Create …"
 * row, an `onCreate` handler mints the option, and it is selected immediately.
 * `FieldRenderer` wired that handler to `uiOptions.onCreateReference` — and
 * nothing ever set `onCreateReference`. The capability was reachable from owned
 * code and dead in every generated app, which is a worse state than absent: it
 * is a feature nobody who has not read `form/types.ts` knows exists.
 *
 * ## The half that could not be derived
 *
 * #442 derived the *search* plan from the columns the form already carries, so
 * no loader had to remember to pass it. Create cannot be derived that way, and
 * the reason is the point of this module: the two questions that decide whether
 * the affordance may render at all are facts about a resource **this form is not
 * for**.
 *
 * 1. **May this viewer create one?** Picking a customer and creating a customer
 *    are different permissions, and a form for an invoice knows neither. Offering
 *    a "Create …" row that 403s on click is the #388 shape — an affordance that
 *    promises and then refuses. The row must be *absent*, and only the server can
 *    say so, via the same `canPerformAction` the write itself will run.
 * 2. **Can one be made from a name?** Most entities require more than their
 *    title. Minting from a single string then either fails validation or writes a
 *    half-record, so the affordance is offered only when every other field the
 *    target requires at create has a default or is nullable —
 *    `requiredCreateFields` in core, read from the very schema `opCreate`
 *    validates against.
 *
 * Both are answered once, server-side, in `referenceFieldOptions` — the one
 * helper all eight loaders already call, which is what keeps this from becoming a
 * second thing a surface can silently miss.
 *
 * ## The write is the ordinary write
 *
 * The handler this module builds posts through the `DataProvider` — `POST
 * /api/:resource` — so the create is `opCreate` on the target resource with its
 * own authz check, its own audit entry and its own origin attribution. It is not
 * a side door inheriting the parent form's permission, and, exactly as inline
 * edit has no inline-edit endpoint, **there is no create-inline endpoint**. If
 * every gate above were computed wrong, the create would be refused by the same
 * rule that refuses it on the target's own New form.
 */

import { useCallback } from 'react'
import { useOptionalDataProvider } from '../data/data-context.tsx'
import type { AutocompleteOption } from '../ui/form-fields.tsx'

/** What a picker needs to mint a record of the resource it points at. */
export interface ReferenceCreatePlan {
	/** The referenced resource, as the REST surface names it. */
	resource: string
	/** The referenced record's id column — the value the picker submits. */
	idField: string
	/** The one field the typed string becomes. Everything else the target
	 * requires at create must default or be nullable, or no plan is built. */
	labelField: string
}

/**
 * The `onCreate` handler for a picker, or `undefined` when it must not offer
 * one.
 *
 * `undefined` — rather than a handler that throws — because the components read
 * `onCreate`'s presence as "may this row render at all". A handler that existed
 * and failed would put the affordance on screen and take it back on click, which
 * is the thing gate 1 exists to prevent.
 *
 * With no `<DataProvider>` in context there is no way to reach the target
 * resource, so there is no handler either. That is the same degradation
 * `useReferenceSearch` makes, and it means a tree without a data layer behaves
 * exactly as it did before this module existed.
 */
export function useReferenceCreate(
	plan?: ReferenceCreatePlan,
): ((label: string) => Promise<AutocompleteOption>) | undefined {
	const dataProvider = useOptionalDataProvider()
	const create = useCallback(
		async (label: string): Promise<AutocompleteOption> => {
			// Narrowed by the guard below; both are non-null whenever the returned
			// handler is the one the caller got.
			if (!plan || !dataProvider) throw new Error('no create plan')
			const row = await dataProvider.create(plan.resource, {
				[plan.labelField]: label,
			})
			const value = String(row[plan.idField] ?? '')
			// The server's echo, not the typed string: a create that normalizes,
			// trims or titlecases its label would otherwise leave the picker showing
			// something the stored row does not say.
			const stored = row[plan.labelField]
			return { label: stored == null ? label : String(stored), value }
		},
		[dataProvider, plan],
	)
	if (!plan || !dataProvider) return undefined
	return create
}
