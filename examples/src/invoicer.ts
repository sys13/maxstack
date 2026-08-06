/**
 * Example app: invoicer (a freelancer’s clients + invoices tool).
 *
 * PRD grounding via the compact `examplePRD` builder. A
 * money-shaped domain with a status lifecycle (draft → sent → paid) — the kind
 * of workflow that accretes fields and states over a working life.
 *
 * Two of its frozen asks have been absorbed and both were split rather than
 * claimed whole: the branded PDF is a `documents.declare` since issue #176
 * (the *compliance* half stayed off-surface), and the client portal is a
 * `portals.declare` since issue #177 — the *viewing* half only. Nothing here
 * moves money, so the paying half returned to the backlog at full weight.
 */

import { examplePRD } from './deps.ts'
import {
	addField,
	addPage,
	crudExample,
	declareDocument,
	declarePortal,
	documentTemplate,
	ejectPage,
	entity,
	field,
	fillSlot,
	offSurface,
	page,
	portal,
	retitle,
	slot,
	table,
} from './kit.ts'

const entities = [
	entity('e-invoice', 'Invoice', 'A bill sent to a client.', [
		field('fld-invoice-number', 'number', 'string', true),
		field('fld-invoice-status', 'status', 'enum', true),
		field('fld-invoice-total', 'total', 'number'),
	]),
	entity('e-client', 'Client', 'A person or company being billed.', [
		field('fld-client-name', 'name', 'string', true),
		field('fld-client-email', 'email', 'string'),
	]),
	entity('e-lineitem', 'LineItem', 'A billable line on an invoice.', [
		field('fld-lineitem-label', 'label', 'string', true),
		field('fld-lineitem-amount', 'amount', 'number', true),
	]),
]

const invoicesPage = page({
	id: 'pg-invoices',
	name: 'Invoices',
	route: '/app/invoices',
	entityId: 'e-invoice',
	blocks: [
		table('blk-invoices-table'),
		slot('blk-invoices-status', 'statusPill'),
	],
	e2eTests: [
		'A freelancer can draft an invoice for a client',
		'Marking an invoice paid moves it out of the outstanding list',
	],
})

const clientsPage = page({
	id: 'pg-clients',
	name: 'Clients',
	route: '/app/clients',
	entityId: 'e-client',
	blocks: [
		table('blk-clients-table'),
		slot('blk-clients-actions', 'clientActions'),
	],
	e2eTests: [
		'A freelancer can add a client with an email',
		'A client with no invoices shows a zero balance',
	],
})

const lineItemsPage = page({
	id: 'pg-lineitems',
	name: 'Line Items',
	route: '/app/line-items',
	entityId: 'e-lineitem',
	blocks: [table('blk-lineitems-table')],
	e2eTests: [
		'A freelancer can add a billable line with an amount',
		'The empty state shows before any line items exist',
	],
})

export const invoicerExample = crudExample({
	id: 'invoicer',
	title: 'Invoicer — clients & invoices',
	prd: examplePRD({
		title: 'Invoicer — a freelancer’s billing tool',
		tldr: 'Track clients and send invoices without a full accounting suite.',
		problem:
			'Freelancers rebuild invoices in a document each month and lose track of what’s unpaid.',
		northStar: 'Invoices paid on time',
		persona: 'Independent freelancer',
		differentiation:
			'Just clients and invoices — no ledger, payroll, or tax engine to learn.',
	}),
	entities,
	pages: [invoicesPage, clientsPage],
	changes: [
		addField(
			'ch-invoice-due',
			'Add a due-date field to invoices (spec op).',
			'e-invoice',
			'fld-invoice-due',
			'dueDate',
			'date',
		),
		addField(
			'ch-invoice-currency',
			'Add a currency field to invoices (spec op).',
			'e-invoice',
			'fld-invoice-currency',
			'currency',
			'string',
		),
		addPage(
			'ch-add-lineitems',
			'Add the Line Items page (spec op).',
			lineItemsPage,
		),
		retitle(
			'ch-retitle-invoices',
			'Rename Invoices to “Invoices & Status” (regeneration-as-diff).',
			'invoice',
			'Invoices & Status',
		),
		fillSlot(
			'ch-status-pill-slot',
			'Fill the status-pill slot on the Invoices page (slot fill).',
			'invoice',
			'statusPill',
			[
				'// User-owned: a colored pill for the invoice status.',
				'export function statusPill() {',
				'\treturn <span aria-label="status">Draft</span>',
				'}',
			].join('\n'),
		),
		addField(
			'ch-client-taxid',
			'Add a tax-id field to clients (spec op).',
			'e-client',
			'fld-client-taxid',
			'taxId',
			'string',
		),
		addField(
			'ch-lineitem-quantity',
			'Add a quantity field to line items (spec op).',
			'e-lineitem',
			'fld-lineitem-quantity',
			'quantity',
			'number',
		),
		ejectPage(
			'ch-eject-lineitems',
			'Eject the Line Items page for a bespoke editable line grid (eject).',
			'lineitem',
		),
		declareDocument(
			// RECLASSIFIED 2026-07-28 by issue #176, from off-surface/unexpressible.
			// `documents.declare` is the op: a template bound to the invoice row,
			// composed from the same typed field metadata the forms use, rendering to
			// print-ready HTML and to PDF with no browser in the runtime image.
			'ch-invoice-pdf',
			'Render a branded, print-ready PDF of an invoice (spec op).',
			documentTemplate({
				id: 'doc-invoice',
				key: 'invoice',
				description: 'The invoice a client receives, on paper or as a PDF.',
				entityId: 'e-invoice',
				pageSize: 'a4',
				// The sections this example's own data model supports. It has no
				// foreign key from a line item back to an invoice, so the template
				// prints no line-item table — deliberately, because inventing that
				// relation to give the shipped op more surface to sit on is the kind of
				// corpus edit the integrity policy exists to prevent.
				sections: [
					{ kind: 'heading', level: 1, text: 'Invoice {number}' },
					{
						kind: 'fields',
						columns: 2,
						caption: 'Details',
						fieldIds: ['fld-invoice-status', 'fld-invoice-total'],
					},
					{ kind: 'rule' },
					{
						kind: 'text',
						text: 'Payment for invoice {number} is due on receipt.',
					},
					// The bespoke half of a *branded* document — a letterhead is a
					// design, not a declaration, and it is a slot fill rather than an
					// eject of the whole surface.
					{ kind: 'slot', name: 'letterhead' },
				],
				delivery: { download: true },
			}),
		),
		declarePortal(
			// RECLASSIFIED 2026-07-29 by issue #177, from off-surface/eject — and
			// only the VIEWING half. `portals.declare` is the op: a token-scoped,
			// row-scoped surface over one invoice, with an opt-in field projection,
			// an expiring revocable link, and the read gate every other caller
			// passes. The PAYING half does not reclassify and returns to the backlog
			// at full weight as `ch-invoice-checkout` below — claiming it would be
			// claiming work the platform did not do.
			'ch-client-portal',
			'A client portal to view an invoice online, from a link only that client was sent (spec op).',
			portal({
				id: 'ptl-client-invoice',
				key: 'client-invoice',
				description:
					'The invoice a client opens from the link on their emailed copy.',
				entityId: 'e-invoice',
				// A link only that client was sent — not a public URL, and not a
				// login. It expires and it can be revoked, both required by the
				// declaration rather than remembered by whoever mints it.
				audience: 'token',
				token: { ttlHours: 720, maxUses: null },
				scope: 'row',
				// This example's model has no foreign key from a line item back to
				// an invoice, so the portal shows the invoice and not its lines —
				// exactly as `ch-invoice-pdf`'s template does, and for the same
				// reason: adding that relation to give a shipped op more surface is
				// the kind of corpus edit the integrity policy exists to prevent.
				readFields: [
					'fld-invoice-number',
					'fld-invoice-status',
					'fld-invoice-total',
					'fld-invoice-due',
					'fld-invoice-currency',
				],
				writes: [],
				layout: 'detail',
				paused: false,
			}),
		),
		offSurface(
			// CORPUS HARDENING 2026-07-29 — the un-absorbed half of
			// `ch-client-portal`, returning at its full original weight, sourced from
			// the hosted checkout flows real billing products ship.
			'ch-invoice-checkout',
			'Let the client PAY from that link: a hosted checkout whose result arrives as an asynchronous webhook that must reconcile against the invoice under retry, out-of-order delivery, partial payment, overpayment and chargeback, idempotently and exactly once — no op models money moving through a third party and coming back as an event (off-surface, unexpressible).',
			'invoice',
			'unexpressible',
			'public-surface',
		),
		{
			// RECLASSIFIED 2026-07-27 by issue #181, from off-surface/unexpressible.
			// `schedules.declare` is the op: a named recurrence with the timezone it
			// is read in, a defined answer for "the 31st of a 30-day month", and the
			// identity every run carries.
			id: 'ch-recurring-invoices',
			description:
				'Recurring invoice schedules that auto-send monthly (spec op).',
			kind: 'spec-op',
			via: 'apply-op',
			op: {
				op: 'schedules.declare',
				args: {
					schedule: {
						id: 'sch-invoice-recurring',
						key: 'invoice.recurring',
						description:
							'Issue and send the recurring invoices for the period.',
						timezone: 'America/New_York',
						// The month-end case the ask is actually about: "monthly" for an
						// invoicer means the last day, not "skip February".
						recurrence: {
							kind: 'monthly',
							onDayOfMonth: 31,
							atTime: '09:00',
						},
						runAs: { kind: 'service', role: 'billing' },
						entityId: 'e-invoice',
					},
				},
			},
		},
		offSurface(
			// CORPUS HARDENING 2026-07-28 — replaces the residual
			// difficulty the ch-invoice-pdf reclassification above removed, in the same
			// product area, and sourced from a legal regime rather than from this
			// vocabulary.
			'ch-einvoice-compliance',
			'Issue each invoice as a compliant e-invoice: a PDF/A-3 carrying an embedded EN 16931 XML payload, validated against the buyer country\u2019s scheme and refused before sending if it fails, under a gap-free statutory numbering sequence \u2014 no op models a document whose *data* is legally specified and externally validated (off-surface, unexpressible).',
			'invoice',
			'unexpressible',
			'document-gen',
		),
		offSurface(
			// CORPUS HARDENING 2026-07-27 — replaces the residual
			// difficulty the reclassification above removed, in the same product
			// area and from a shipping product.
			'ch-dunning-ladder',
			'When a payment fails, escalate through a reminder sequence with per-step waits, and stop the instant the invoice is paid — no op models a multi-step stateful workflow with cancellation (off-surface, unexpressible).',
			'invoice',
			'unexpressible',
		),
	],
})
