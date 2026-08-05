/**
 * The worked invoicer example (exit criterion 2).
 *
 * The corpus ask this primitive closes is invoicer's: *"render a branded,
 * print-ready PDF of an invoice."* This file is that invoice, end to end, on a
 * real database — a spec with three entities, a declared template, the row and
 * its line items fetched through the ordinary read gates, and the result
 * delivered three ways.
 *
 * It is a test rather than a demo app for one reason: the interesting claims are
 * all *negative*, and a demo cannot make a negative claim. That a reader who may
 * not see the invoice gets a refusal rather than a blank page; that a reader who
 * may see the invoice but not the line items gets an empty table rather than
 * somebody else's; that the stored copy and the emailed copy are byte-identical
 * to the downloaded one. Each of those is a thing that must *not* happen, and
 * the only way to show it does not is to try.
 */

import type { PGlite } from '@electric-sql/pglite'
import {
	type DocumentPlan,
	type OpContext,
	opRenderDocument,
	opUpdate,
	PermissionError,
	ResourceRegistry,
	UnsupportedOperationError,
	withMeta,
} from '@maxstack/core'
import { createDrizzleStore } from '@maxstack/core/demo'
import { bootPglite } from '@maxstack/core/testing'
import { numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryMailer } from '../email/mailer.ts'
import { EmailRegistry } from '../email/registry.ts'
import { createMemoryStorageProvider } from '../storage/memory.ts'
import { emailDocument, renderDocument, storeDocument } from './index.ts'

// ---------------------------------------------------------------------------
// The app: three entities, exactly the invoicer benchmark's.
// ---------------------------------------------------------------------------

const client = pgTable('client', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: withMeta(text('name'), { label: 'Name', required: true }).notNull(),
	email: withMeta(text('email'), { label: 'Email' }),
})

const invoice = pgTable('invoice', {
	id: uuid('id').primaryKey().defaultRandom(),
	number: withMeta(text('number'), {
		label: 'Number',
		required: true,
	}).notNull(),
	status: withMeta(text('status'), { label: 'Status' }),
	clientId: withMeta(uuid('clientId'), { label: 'Client' }),
	total: withMeta(numeric('total'), { label: 'Total' }),
})

const lineitem = pgTable('lineitem', {
	id: uuid('id').primaryKey().defaultRandom(),
	label: withMeta(text('label'), { label: 'Label', required: true }).notNull(),
	amount: withMeta(numeric('amount'), { label: 'Amount' }),
	invoiceId: withMeta(uuid('invoiceId'), { label: 'Invoice' }),
})

const DDL = `
CREATE TABLE "client" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "email" text
);
CREATE TABLE "invoice" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "number" text NOT NULL,
  "status" text,
  "clientId" uuid,
  "total" numeric
);
CREATE TABLE "lineitem" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" text NOT NULL,
  "amount" numeric,
  "invoiceId" uuid
);
`

/**
 * The grounded template — what `documents.declare` becomes after the app's
 * grounding resolves field ids to columns and the app's theme to a style.
 */
const invoicePlan: DocumentPlan = {
	key: 'invoice',
	description: 'A branded invoice for a client.',
	resource: 'invoice',
	// Declared downloadable — a template without it has no URL.
	download: true,
	pageSize: 'a4',
	style: {
		font: 'serif',
		accent: '#1d4ed8',
		density: 'comfortable',
		typeScale: 'default',
	},
	values: {
		number: { column: 'number', label: 'Number', type: 'string' },
		status: {
			column: 'status',
			label: 'Status',
			type: 'enum',
			options: { sent: 'Sent', paid: 'Paid' },
		},
		total: { column: 'total', label: 'Total', type: 'number' },
	},
	sections: [
		{ kind: 'heading', level: 1, text: 'Invoice {number}' },
		{
			kind: 'fields',
			columns: 2,
			caption: 'Details',
			fields: [
				{
					column: 'status',
					label: 'Status',
					type: 'enum',
					options: { sent: 'Sent', paid: 'Paid' },
				},
				{ column: 'total', label: 'Total', type: 'number' },
			],
		},
		{
			kind: 'table',
			caption: 'Line items',
			resource: 'lineitem',
			via: 'invoiceId',
			orderBy: 'label',
			direction: 'asc',
			fields: [
				{ column: 'label', label: 'Description', type: 'string' },
				{ column: 'amount', label: 'Amount', type: 'number' },
			],
		},
		{ kind: 'rule' },
		{ kind: 'text', text: 'Payment for {number} is due within 30 days.' },
	],
}

const admin = { id: 'u-admin', role: 'admin' }
const outsider = { id: 'u-outsider', role: 'member' }

let db: PGlite
let ctx: OpContext
let outsiderCtx: OpContext
let invoiceId: string
let clientId: string

beforeAll(async () => {
	db = await bootPglite()
	await db.exec(DDL)
	const registry = new ResourceRegistry()
	registry.register(client)
	// The template is declared on the resource, which is the layer `authorize()`
	// guards — see `ResourceConfig.documents`.
	registry.register(invoice, { documents: [invoicePlan] })
	// The line items are readable only by an admin. That asymmetry is the point
	// of the second access test below.
	registry.register(lineitem, { access: { read: 'admin' } })
	const store = createDrizzleStore(drizzle({ client: db }), registry)
	ctx = { registry, store, user: admin }
	outsiderCtx = { registry, store, user: outsider }

	const row = await db.query<{ id: string }>(
		`INSERT INTO "client" ("name", "email") VALUES ('Größe & Sons, Ltd.', 'ap@grosse.example') RETURNING id`,
	)
	clientId = row.rows[0]?.id ?? ''
	const inv = await db.query<{ id: string }>(
		`INSERT INTO "invoice" ("number", "status", "clientId", "total") VALUES ('INV-1042', 'sent', $1, 1234.50) RETURNING id`,
		[clientId],
	)
	invoiceId = inv.rows[0]?.id ?? ''
	await db.query(
		`INSERT INTO "lineitem" ("label", "amount", "invoiceId") VALUES ('Design work', 1000, $1), ('Revisions', 234.50, $1)`,
		[invoiceId],
	)
})

afterAll(async () => {
	await db.close()
})

describe('the worked invoicer example', () => {
	it('renders the invoice and its line items from one row id', async () => {
		const { layout } = await opRenderDocument(ctx, 'invoice', invoiceId)
		expect(layout.title).toBe('Invoice INV-1042')
		const table = layout.blocks.find((b) => b.kind === 'table')
		expect(table?.kind === 'table' && table.rows).toEqual([
			['Design work', '1,000'],
			['Revisions', '234.5'],
		])
	})

	it('orders the line items by the declared key, not by table order', async () => {
		// Determinism: a document whose rows move between renders is not
		// byte-identical, which is the whole archive story.
		const { layout } = await opRenderDocument(ctx, 'invoice', invoiceId)
		const table = layout.blocks.find((b) => b.kind === 'table')
		expect(table?.kind === 'table' && table.rows.map((r) => r[0])).toEqual([
			'Design work',
			'Revisions',
		])
	})

	it('refuses a reader who may not read the row, rather than rendering a blank document', async () => {
		const registry = new ResourceRegistry()
		registry.register(invoice, {
			access: { read: 'admin' },
			documents: [invoicePlan],
		})
		registry.register(lineitem)
		const store = createDrizzleStore(drizzle({ client: db }), registry)
		await expect(
			opRenderDocument(
				{ registry, store, user: outsider },
				'invoice',
				invoiceId,
			),
		).rejects.toBeInstanceOf(PermissionError)
	})

	it('propagates the child resource’s refusal rather than printing an invoice with the lines missing', async () => {
		// The line items are admin-only and the invoice is not, so a member can read
		// the invoice itself. They still get a refusal, because a document that
		// silently omits billable lines is worse than no document — it looks
		// complete. Same argument `opSearch` makes about denial versus zero results.
		await expect(
			opRenderDocument(outsiderCtx, 'invoice', invoiceId),
		).rejects.toBeInstanceOf(PermissionError)
	})

	/**
	 * Issue #222. `delivery.download` reached the runtime not at all, so the
	 * document route served every declared template: turning `download` off
	 * retired a template from the exposure report and from nothing else, and a
	 * template delivered only by email kept a working public URL the declaration
	 * said it did not have.
	 *
	 * The check lives in the op rather than in the route on issue #186's finding
	 * — there is now more than one caller (the route, the admin link, the MCP
	 * tool) and a route-level gate is a gate the others skip.
	 */
	it('refuses to render a template that declares no download, unless another delivery asks', async () => {
		const registry = new ResourceRegistry()
		registry.register(invoice, {
			documents: [{ ...invoicePlan, download: false }],
		})
		registry.register(lineitem)
		const store = createDrizzleStore(drizzle({ client: db }), registry)
		const retiredCtx = { registry, store, user: admin }

		await expect(
			opRenderDocument(retiredCtx, 'invoice', invoiceId),
		).rejects.toBeInstanceOf(UnsupportedOperationError)

		// `via` defaults to the checked value, so a caller that has not thought
		// about it gets the strict answer; a delivery that legitimately renders a
		// non-downloadable template says so out loud and still works.
		const { layout } = await opRenderDocument(
			retiredCtx,
			'invoice',
			invoiceId,
			{
				via: 'email',
			},
		)
		expect(layout.title).toBe('Invoice INV-1042')
	})

	it('is byte-identical across renders of the same row', async () => {
		const first = await opRenderDocument(ctx, 'invoice', invoiceId)
		const second = await opRenderDocument(ctx, 'invoice', invoiceId)
		const a = renderDocument(first.layout, invoicePlan, 'pdf')
		const b = renderDocument(second.layout, invoicePlan, 'pdf')
		expect(Buffer.from(a.bytes)).toEqual(Buffer.from(b.bytes))
	})

	it('reflects a change to the row on the next render — the document is a view, not a snapshot', async () => {
		await opUpdate(ctx, 'invoice', invoiceId, { status: 'paid' })
		const { layout } = await opRenderDocument(ctx, 'invoice', invoiceId)
		const pairs = layout.blocks.find((b) => b.kind === 'pairs')
		expect(pairs?.kind === 'pairs' && pairs.pairs[0]?.value).toBe('Paid')
		await opUpdate(ctx, 'invoice', invoiceId, { status: 'sent' })
	})
})

describe('composition with the storage bundle', () => {
	it('writes the PDF under the declared, row-derived key', async () => {
		const provider = createMemoryStorageProvider()
		const { layout, row } = await opRenderDocument(ctx, 'invoice', invoiceId)
		const rendered = renderDocument(layout, invoicePlan, 'pdf')
		const stored = await storeDocument({
			provider,
			plan: invoicePlan,
			row,
			path: 'invoices/{number}.pdf',
			rendered,
		})
		expect(stored.key).toBe('invoices/INV-1042.pdf')
		expect(stored.contentType).toBe('application/pdf')

		const readBack = await provider.read(stored.key)
		expect(Buffer.from(readBack?.bytes ?? new Uint8Array())).toEqual(
			Buffer.from(rendered.bytes),
		)
	})

	it('overwrites its own object rather than accumulating copies', async () => {
		const provider = createMemoryStorageProvider()
		const { layout, row } = await opRenderDocument(ctx, 'invoice', invoiceId)
		const rendered = renderDocument(layout, invoicePlan, 'pdf')
		const a = await storeDocument({
			provider,
			plan: invoicePlan,
			row,
			path: 'invoices/{number}.pdf',
			rendered,
		})
		const b = await storeDocument({
			provider,
			plan: invoicePlan,
			row,
			path: 'invoices/{number}.pdf',
			rendered,
		})
		expect(a.key).toBe(b.key)
	})

	it('did not require the storage bundle to learn what a document is', async () => {
		// The composition proof, stated as an assertion on the contract: a document
		// reaches storage as bytes and a content type, which is `put`'s existing
		// signature.
		const provider = createMemoryStorageProvider()
		expect(typeof provider.put).toBe('function')
		expect(provider).not.toHaveProperty('putDocument')
	})
})

describe('composition with the email bundle', () => {
	const registry = new EmailRegistry()
	registry.register({
		name: 'invoice.sent',
		subject: () => 'Your invoice',
		render: (props: { document?: { filename?: string } }) =>
			`<p>Your invoice is attached as ${props.document?.filename ?? 'a file'}.</p>`,
	})

	it('attaches the same bytes the download would have served', async () => {
		const mailer = createMemoryMailer()
		const { layout, row } = await opRenderDocument(ctx, 'invoice', invoiceId)
		const rendered = renderDocument(layout, invoicePlan, 'pdf')
		const clientRow = await ctx.store.get('client', clientId)
		const sent = await emailDocument({
			mailer,
			registry,
			template: 'invoice.sent',
			subject: 'Invoice {number} from Acme',
			to: String(clientRow?.email),
			plan: invoicePlan,
			row,
			rendered,
		})

		expect(sent.to).toBe('ap@grosse.example')
		const message = mailer.sent[0]
		// The declared subject wins over the template's generic one — an invoice
		// email's subject has to carry the number, which the template cannot know.
		expect(message?.subject).toBe('Invoice INV-1042 from Acme')
		expect(message?.attachments?.[0]?.filename).toBe('Invoice-INV-1042.pdf')
		expect(message?.attachments?.[0]?.contentType).toBe('application/pdf')
		expect(
			Buffer.from(message?.attachments?.[0]?.bytes ?? new Uint8Array()),
		).toEqual(Buffer.from(rendered.bytes))
		expect(message?.html).toContain('Invoice-INV-1042.pdf')
	})

	it('can attach the HTML rendering instead, from the same layout', async () => {
		const mailer = createMemoryMailer()
		const { layout, row } = await opRenderDocument(ctx, 'invoice', invoiceId)
		const rendered = renderDocument(layout, invoicePlan, 'html')
		await emailDocument({
			mailer,
			registry,
			template: 'invoice.sent',
			subject: 'Invoice {number}',
			to: 'ap@grosse.example',
			plan: invoicePlan,
			row,
			rendered,
		})
		const attachment = mailer.sent[0]?.attachments?.[0]
		expect(attachment?.filename).toBe('Invoice-INV-1042.html')
		expect(
			Buffer.from(attachment?.bytes ?? new Uint8Array()).toString('utf8'),
		).toContain('Invoice INV-1042')
	})
})
