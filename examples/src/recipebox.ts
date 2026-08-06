/**
 * Example app: recipebox (a shared recipe & weekly meal-plan keeper).
 *
 * PRD grounding via the compact `examplePRD` builder. A domain with
 * a planning layer over the records (recipes → meal plans), so the change set
 * exercises a second CRUD surface that references the first.
 */

import { examplePRD } from './deps.ts'
import {
	addCalendar,
	addField,
	addPage,
	addRollup,
	addSlot,
	belongsTo,
	crudExample,
	ejectPage,
	entity,
	field,
	fillSlot,
	offSurface,
	page,
	retitle,
	slot,
	table,
} from './kit.ts'

// SPEC EDIT 2026-07-28: the relations this product always had and
// this spec never wrote down — a recipe is planned into a week, an ingredient
// line belongs to a recipe and states how much. The backlog is untouched.
const entities = [
	entity('e-recipe', 'Recipe', 'A dish with ingredients and steps.', [
		field('fld-recipe-name', 'name', 'string', true),
		field('fld-recipe-servings', 'servings', 'number'),
		field('fld-recipe-favorite', 'favorite', 'boolean'),
		belongsTo('fld-recipe-mealplan', 'mealPlanId', 'e-mealplan'),
		// SPEC EDIT 2026-07-28: the model already says a recipe is
		// planned into a *week*; which day of that week it is cooked was never
		// written down, and the planner ask presupposes it. Same argument as the
		// #170 relations above.
		field('fld-recipe-planned', 'plannedFor', 'date'),
	]),
	entity('e-mealplan', 'MealPlan', 'A week of planned meals.', [
		field('fld-mealplan-week', 'week', 'date', true),
		field('fld-mealplan-notes', 'notes', 'string'),
	]),
	entity('e-ingredient', 'Ingredient', 'A pantry item a recipe calls for.', [
		field('fld-ingredient-name', 'name', 'string', true),
		field('fld-ingredient-unit', 'unit', 'string'),
		field('fld-ingredient-quantity', 'quantity', 'number'),
		belongsTo('fld-ingredient-recipe', 'recipeId', 'e-recipe'),
	]),
]

const recipesPage = page({
	id: 'pg-recipes',
	name: 'Recipes',
	route: '/app/recipes',
	entityId: 'e-recipe',
	blocks: [
		table('blk-recipes-table'),
		slot('blk-recipes-scale', 'servingScaler'),
	],
	e2eTests: [
		'A cook can add a recipe and see it in the list',
		'Marking a recipe a favorite pins it to the top',
	],
})

const plansPage = page({
	id: 'pg-mealplans',
	name: 'Meal Plans',
	route: '/app/plans',
	entityId: 'e-mealplan',
	blocks: [
		table('blk-mealplans-table'),
		slot('blk-mealplans-actions', 'planActions'),
	],
	e2eTests: [
		'A cook can start a plan for the coming week',
		'An empty week shows a prompt to add the first meal',
	],
})

const ingredientsPage = page({
	id: 'pg-ingredients',
	name: 'Ingredients',
	route: '/app/ingredients',
	entityId: 'e-ingredient',
	blocks: [table('blk-ingredients-table')],
	e2eTests: [
		'A cook can add an ingredient with a unit',
		'The empty state shows before any ingredients exist',
	],
})

export const recipeboxExample = crudExample({
	id: 'recipebox',
	title: 'Recipebox — recipes & weekly meal plans',
	prd: examplePRD({
		title: 'Recipebox — a shared recipe & meal-plan keeper',
		tldr: 'Keep the household’s recipes in one place and plan the week from them.',
		problem:
			'Recipes live in screenshots and bookmarks, and planning the week means starting from scratch every time.',
		northStar: 'Weekly plans cooked',
		persona: 'Home cook planning the week',
		differentiation:
			'A recipe box that knows how to become a meal plan, not just a note app.',
	}),
	entities,
	pages: [recipesPage, plansPage],
	changes: [
		addField(
			'ch-recipe-cuisine',
			'Add a cuisine field to recipes (spec op).',
			'e-recipe',
			'fld-recipe-cuisine',
			'cuisine',
			'string',
		),
		addField(
			'ch-recipe-prep',
			'Add prep-time minutes to recipes (spec op).',
			'e-recipe',
			'fld-recipe-prep',
			'prepMinutes',
			'number',
		),
		addPage(
			'ch-add-ingredients',
			'Add the Ingredients pantry page (spec op).',
			ingredientsPage,
		),
		retitle(
			'ch-retitle-recipes',
			'Rename Recipes to “Recipes & Favorites” (regeneration-as-diff).',
			'recipe',
			'Recipes & Favorites',
		),
		fillSlot(
			'ch-serving-scaler-slot',
			'Fill the serving-scaler slot on the Recipes page (slot fill).',
			'recipe',
			'servingScaler',
			[
				'// User-owned: scale a recipe’s servings up or down.',
				'export function servingScaler() {',
				'\treturn <label>Servings <input type="number" defaultValue={4} /></label>',
				'}',
			].join('\n'),
		),
		addSlot(
			'ch-plan-shopping-slot',
			'Open a shopping-list slot on the Meal Plans page (spec op).',
			'pg-mealplans',
			'blk-mealplans-shopping',
			'planShopping',
		),
		addField(
			'ch-plan-servings',
			'Add a servings-per-meal field to meal plans (spec op).',
			'e-mealplan',
			'fld-mealplan-servings',
			'servings',
			'number',
		),
		addField(
			'ch-ingredient-category',
			'Add a pantry category to ingredients (spec op).',
			'e-ingredient',
			'fld-ingredient-category',
			'category',
			'string',
		),
		ejectPage(
			'ch-eject-ingredients',
			'Eject the Ingredients page for a bespoke pantry grid (eject).',
			'ingredient',
		),
		addRollup(
			// RECLASSIFIED 2026-07-28 by issue #170, from off-surface/unexpressible.
			// `data.addRollup` is the op: a two-hop path (ingredient → recipe →
			// meal plan) summing quantities per ingredient name, with the group cap
			// stated.
			'ch-shopping-aggregate',
			'Auto-build a week’s shopping list by aggregating ingredients across every planned recipe (spec op).',
			'e-mealplan',
			{
				id: 'drv-mealplan-shopping',
				name: 'shoppingList',
				over: 'e-ingredient',
				// ingredient → recipe, recipe → meal plan: the multi-hop case this
				// ask is the reason for.
				via: ['fld-ingredient-recipe', 'fld-recipe-mealplan'],
				fn: 'sum',
				field: 'fld-ingredient-quantity',
				// One line per ingredient name — a shopping list, not a single total.
				groupBy: { field: 'fld-ingredient-name' },
				limit: 200,
			},
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and, deliberately, in the same *shape*: it is the half of the
			// shopping-list problem a `sum` cannot do.
			'ch-shopping-unit-merge',
			'Merge the shopping list across incompatible units and scale it to the plan’s servings — 2 tbsp + ¼ cup is one line, and doubling a recipe doubles only its own lines — no op models unit-aware aggregation (off-surface, unexpressible).',
			'mealplan',
			'unexpressible',
		),
		addCalendar(
			// RECLASSIFIED 2026-07-28 by issue #171, from off-surface/eject. The
			// planner is a week grid of the planned recipes with drag (and keyboard)
			// rescheduling, so the meal-plans surface no longer has to be ejected for
			// it.
			'ch-calendar-planner',
			'A drag-and-drop weekly calendar planner (spec op).',
			'pg-recipes',
			'blk-recipes-planner',
			{
				dateField: 'plannedFor',
				display: 'week',
				timezone: 'America/Chicago',
				titleField: 'name',
				reschedule: true,
			},
		),
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the reclassification above removed, in the same product area
			// and in the shape a *view* is not: a series of occurrences with an
			// identity of its own.
			'ch-repeating-meals',
			'Repeating meals: “taco Tuesday every week until the end of term” is planned once and edited as a series, but a single week can be moved or skipped without detaching the rest, and the shopping list counts the occurrences rather than the rule — no op models a recurring occurrence set (off-surface, unexpressible).',
			'mealplan',
			'unexpressible',
			'calendar',
		),
	],
})
