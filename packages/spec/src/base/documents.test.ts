/**
 * The `documents.*` op family and its validator.
 *
 * The organizing idea: almost everything this validator refuses is something
 * that would otherwise be **silent at render time**. A placeholder that does not
 * resolve, a `via` pointing at the wrong entity, a `json` column in a fields
 * block — none of them throws, none of them logs. The document comes out, it is
 * just wrong, and somebody's customer is holding it. So the tests below are
 * mostly about what cannot be declared, and each one names the paper failure it
 * is standing in front of.
 */

import { describe, expect, it } from 'vitest'
import { tasklyPRD } from '../fixtures/index.ts'
import {
	activeDocumentTemplates,
	type DocumentSection,
	type DocumentTemplateSpec,
	describeDelivery,
	describeDocumentTemplate,
	documentPlaceholders,
	findDocumentTemplate,
	hasActiveDelivery,
	MAX_DOCUMENT_SECTIONS,
} from './documents.ts'
import { manual, suggested } from './provenance.ts'
import { applyOp, diffOp, type SpecOp, validateOp } from './spec-ops.ts'
import { validateSpecSystem } from './spec-system.schema.ts'
import { newSpecSystem, type SpecSystem } from './spec-system.ts'

// ---------------------------------------------------------------------------
// A fixture with the shape every real document has: a parent, a child on a
// foreign key, a reference to a third entity, and a rollup.
// ---------------------------------------------------------------------------

function system(): SpecSystem {
	const s = newSpecSystem(tasklyPRD, { autoAccept: true })
	s.data.entities = [
		{
			id: 'e-client',
			name: 'Client',
			description: 'Someone being billed.',
			fields: [
				{
					id: 'fld-client-name',
					name: 'name',
					type: 'string',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-client-email',
					name: 'email',
					type: 'string',
					required: false,
					provenance: manual(),
				},
			],
			provenance: manual(),
		},
		{
			id: 'e-invoice',
			name: 'Invoice',
			description: 'A bill.',
			fields: [
				{
					id: 'fld-invoice-number',
					name: 'number',
					type: 'string',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-invoice-client',
					name: 'clientId',
					type: 'string',
					required: false,
					reference: 'e-client',
					provenance: manual(),
				},
				{
					id: 'fld-invoice-notes',
					name: 'notes',
					type: 'json',
					required: false,
					provenance: manual(),
				},
			],
			rollups: [
				{
					id: 'drv-invoice-total',
					name: 'total',
					over: 'e-lineitem',
					via: 'fld-lineitem-invoice',
					fn: 'sum',
					field: 'fld-lineitem-amount',
					provenance: manual(),
				},
			],
			provenance: manual(),
		},
		{
			id: 'e-lineitem',
			name: 'LineItem',
			description: 'A billable line.',
			fields: [
				{
					id: 'fld-lineitem-label',
					name: 'label',
					type: 'string',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-lineitem-amount',
					name: 'amount',
					type: 'number',
					required: true,
					provenance: manual(),
				},
				{
					id: 'fld-lineitem-invoice',
					name: 'invoiceId',
					type: 'string',
					required: false,
					reference: 'e-invoice',
					provenance: manual(),
				},
			],
			provenance: manual(),
		},
	]
	return s
}

const sections: DocumentSection[] = [
	{ kind: 'heading', level: 1, text: 'Invoice {number}' },
	{ kind: 'fields', columns: 2, fieldIds: ['fld-invoice-number'] },
	{
		kind: 'table',
		over: 'e-lineitem',
		via: 'fld-lineitem-invoice',
		fieldIds: ['fld-lineitem-label', 'fld-lineitem-amount'],
	},
	{ kind: 'rule' },
	// The total is a rollup, which is the whole reason this layer ships no
	// arithmetic of its own.
	{ kind: 'fields', columns: 1, fieldIds: ['drv-invoice-total'] },
	{ kind: 'slot', name: 'remittance' },
]

function declare(over: Partial<DocumentTemplateSpec> = {}): SpecOp {
	return {
		op: 'documents.declare',
		args: {
			template: {
				id: 'doc-invoice',
				key: 'invoice',
				description: 'A branded invoice.',
				entityId: 'e-invoice',
				pageSize: 'a4',
				sections,
				delivery: { download: true },
				...over,
			} as DocumentTemplateSpec,
		},
	}
}

const errorsFor = (s: SpecSystem, op: SpecOp): string[] => validateOp(s, op)

const applied = (s: SpecSystem, op: SpecOp): SpecSystem =>
	applyOp(s, op, {
		actor: { surface: 'harness' },
		id: 'op-1',
		origin: 'human',
		appliedAt: '2026-07-28',
	})

describe('documents.declare', () => {
	it('lands a template and stamps declaredAt from the op', () => {
		const next = applied(system(), declare())
		const template = next.documents?.templates[0]
		expect(template?.key).toBe('invoice')
		expect(template?.declaredAt).toBe('2026-07-28')
		expect(() => validateSpecSystem(next)).not.toThrow()
	})

	it('allows several templates on one entity — an invoice, a receipt and a statement', () => {
		// Deliberately unlike a search index, where one entity has one answer to
		// "what does searching this mean" and one physical index to pay for.
		const one = applied(system(), declare())
		const two = applied(
			one,
			declare({ id: 'doc-receipt', key: 'receipt', description: 'A receipt.' }),
		)
		expect(two.documents?.templates).toHaveLength(2)
		expect(
			errorsFor(one, declare({ id: 'doc-receipt', key: 'receipt' })),
		).toEqual([])
	})

	it('refuses a duplicate key — two templates with one key share a URL and an object path', () => {
		const one = applied(system(), declare())
		expect(errorsFor(one, declare({ id: 'doc-other' })).join('\n')).toContain(
			'already exists',
		)
	})

	it('refuses a placeholder that does not resolve, because it would print literally', () => {
		expect(
			errorsFor(
				system(),
				declare({
					sections: [
						{ kind: 'heading', level: 1, text: 'Invoice {invoiceNo}' },
					],
				}),
			).join('\n'),
		).toContain('placeholder "{invoiceNo}"')
	})

	it('accepts a placeholder naming a rollup — a total is a declaration that already exists', () => {
		expect(
			errorsFor(
				system(),
				declare({
					sections: [{ kind: 'text', text: 'Amount due: {total}' }],
				}),
			),
		).toEqual([])
	})

	it('refuses a json field, whose printed form is punctuation', () => {
		expect(
			errorsFor(
				system(),
				declare({
					sections: [
						{ kind: 'fields', columns: 1, fieldIds: ['fld-invoice-notes'] },
					],
				}),
			).join('\n'),
		).toContain('is a json')
	})

	it('refuses a via that is not the foreign key back to this row', () => {
		// The failure this stands in front of: a via pointing at another entity
		// resolves, fetches rows, and prints somebody else's line items under this
		// customer's letterhead.
		expect(
			errorsFor(
				system(),
				declare({
					sections: [
						{
							kind: 'table',
							over: 'e-lineitem',
							via: 'fld-lineitem-label',
							fieldIds: ['fld-lineitem-label'],
						},
					],
				}),
			).join('\n'),
		).toContain('references nothing, not "e-invoice"')
	})

	it('refuses ordering a table by a derived value', () => {
		expect(
			errorsFor(
				system(),
				declare({
					sections: [
						{
							kind: 'table',
							over: 'e-lineitem',
							via: 'fld-lineitem-invoice',
							fieldIds: ['fld-lineitem-label'],
							// The branded id type already refuses this at compile time;
							// the cast is what a hand-edited documents.json looks like,
							// which is the case the runtime validator is for.
							orderBy: 'drv-invoice-total' as never,
						},
					],
				}),
			).join('\n'),
		).toContain('not a stored field')
	})

	it('refuses two slots with one name, and an empty section list', () => {
		expect(
			errorsFor(
				system(),
				declare({
					sections: [
						{ kind: 'slot', name: 'foot' },
						{ kind: 'slot', name: 'foot' },
					],
				}),
			).join('\n'),
		).toContain('appears twice')
		expect(errorsFor(system(), declare({ sections: [] })).join('\n')).toContain(
			'at least one section',
		)
	})

	it('bounds the section list', () => {
		const many = Array.from({ length: MAX_DOCUMENT_SECTIONS + 1 }, () => ({
			kind: 'rule' as const,
		}))
		expect(
			errorsFor(system(), declare({ sections: many })).join('\n'),
		).toContain(`exceeds the maximum of ${MAX_DOCUMENT_SECTIONS}`)
	})

	it('refuses an unknown entity, page size and section kind', () => {
		expect(
			errorsFor(system(), declare({ entityId: 'e-nope' })).join('\n'),
		).toContain('unknown entity')
		expect(
			errorsFor(
				system(),
				declare({ pageSize: 'a3' as DocumentTemplateSpec['pageSize'] }),
			).join('\n'),
		).toContain('pageSize "a3"')
		expect(
			errorsFor(
				system(),
				declare({
					sections: [{ kind: 'sidebar' } as unknown as DocumentSection],
				}),
			).join('\n'),
		).toContain('unknown section kind')
	})
})

describe('delivery', () => {
	it('refuses a store path with no placeholder — every row would write one key', () => {
		expect(
			errorsFor(
				system(),
				declare({
					delivery: {
						download: true,
						store: { path: 'invoices/latest.pdf', format: 'pdf' },
					},
				}),
			).join('\n'),
		).toContain('has no {placeholder}')
	})

	it('accepts a row-derived store path', () => {
		expect(
			errorsFor(
				system(),
				declare({
					delivery: {
						download: true,
						store: { path: 'invoices/{number}.pdf', format: 'pdf' },
					},
				}),
			),
		).toEqual([])
	})

	it('follows exactly one reference hop to the recipient', () => {
		// The invoicer case: the address belongs to the client, and duplicating it
		// onto the invoice to satisfy a template would be the spec telling the data
		// model what shape to be.
		expect(
			errorsFor(
				system(),
				declare({
					delivery: {
						download: false,
						email: {
							template: 'invoice.sent',
							subject: 'Invoice {number}',
							to: { via: 'fld-invoice-client', fieldId: 'fld-client-email' },
							format: 'pdf',
						},
					},
				}),
			),
		).toEqual([])
	})

	it('refuses a hop through a non-reference field, and a non-string address', () => {
		const bad = (to: Record<string, string>) =>
			errorsFor(
				system(),
				declare({
					delivery: {
						download: false,
						email: {
							template: 't',
							subject: 's',
							to: to as never,
							format: 'pdf',
						},
					},
				}),
			).join('\n')
		expect(
			bad({ via: 'fld-invoice-number', fieldId: 'fld-client-email' }),
		).toContain('is not a reference')
		expect(bad({ fieldId: 'fld-invoice-notes' })).toContain('is a json')
	})

	it('refuses an email delivery with no recipient at all', () => {
		expect(
			errorsFor(
				system(),
				declare({
					delivery: {
						download: false,
						email: {
							template: 't',
							subject: 's',
							to: undefined as never,
							format: 'pdf',
						},
					},
				}),
			).join('\n'),
		).toContain('needs a "to"')
	})
})

describe('documents.setSections and setDelivery', () => {
	it('replaces the sections wholesale and re-validates them against the entity', () => {
		const one = applied(system(), declare())
		const next = applied(one, {
			op: 'documents.setSections',
			args: {
				templateId: 'doc-invoice',
				sections: [{ kind: 'heading', level: 1, text: 'Receipt {number}' }],
			},
		})
		expect(next.documents?.templates[0]?.sections).toHaveLength(1)
		expect(
			errorsFor(one, {
				op: 'documents.setSections',
				args: {
					templateId: 'doc-invoice',
					sections: [{ kind: 'heading', level: 1, text: '{nope}' }],
				},
			}).join('\n'),
		).toContain('placeholder "{nope}"')
	})

	it('changes delivery without touching the layout', () => {
		const one = applied(system(), declare())
		const next = applied(one, {
			op: 'documents.setDelivery',
			args: { templateId: 'doc-invoice', delivery: { download: false } },
		})
		expect(next.documents?.templates[0]?.delivery).toEqual({ download: false })
		expect(next.documents?.templates[0]?.sections).toEqual(sections)
	})

	it('refuses either op against an unknown template', () => {
		expect(
			errorsFor(system(), {
				op: 'documents.setDelivery',
				args: { templateId: 'doc-nope', delivery: { download: false } },
			}).join('\n'),
		).toContain('unknown document template')
	})
})

describe('documents.remove', () => {
	const remove: SpecOp = {
		op: 'documents.remove',
		args: { templateId: 'doc-invoice' },
	}

	it('is refused while any delivery target is still on', () => {
		const one = applied(system(), declare())
		expect(errorsFor(one, remove).join('\n')).toContain('still delivers')
	})

	it('lands once delivery is retired', () => {
		const retired = applied(applied(system(), declare()), {
			op: 'documents.setDelivery',
			args: { templateId: 'doc-invoice', delivery: { download: false } },
		})
		expect(errorsFor(retired, remove)).toEqual([])
		expect(applied(retired, remove).documents?.templates).toEqual([])
	})

	it('refuses an unknown template rather than silently succeeding', () => {
		expect(
			errorsFor(system(), {
				op: 'documents.remove',
				args: { templateId: 'doc-nope' },
			}).join('\n'),
		).toContain('unknown document template')
	})
})

describe('reading the layer', () => {
	it('grounds on accepted rows like every other layer', () => {
		const s = applied(system(), declare())
		const template = s.documents?.templates[0]
		if (template) template.provenance = suggested()
		// A suggestion nobody accepted does not start answering a public URL —
		// but with nothing else decided, accepted-else-all still returns it.
		expect(activeDocumentTemplates(s)).toHaveLength(1)
		expect(findDocumentTemplate(s, 'invoice')?.id).toBe('doc-invoice')
		expect(findDocumentTemplate(s, 'nope')).toBeUndefined()
	})

	it('describes a template and its delivery in one line each', () => {
		const template = applied(system(), declare()).documents?.templates[0]
		if (!template) throw new Error('expected a template')
		expect(describeDocumentTemplate(template)).toContain('a4 over e-invoice')
		expect(describeDocumentTemplate(template)).toContain('download')
		expect(describeDelivery({ download: false })).toContain('retired')
		expect(hasActiveDelivery({ download: false })).toBe(false)
		expect(
			hasActiveDelivery({
				download: false,
				store: { path: '{number}.pdf', format: 'pdf' },
			}),
		).toBe(true)
	})

	it('extracts placeholders in order, deduplicated', () => {
		expect(documentPlaceholders('{a} then {b} then {a}')).toEqual(['a', 'b'])
		expect(documentPlaceholders('none here')).toEqual([])
	})
})

describe('the diff', () => {
	it('summarizes what a reviewer needs to know, including what customers receive', () => {
		expect(diffOp(declare()).summary).toContain(
			'Declare document template "invoice"',
		)
		const s = applied(system(), declare())
		expect(
			diffOp({
				op: 'documents.setDelivery',
				args: {
					templateId: 'doc-invoice',
					delivery: {
						download: true,
						email: {
							template: 'invoice.sent',
							subject: 'x',
							to: { fieldId: 'fld-client-email' },
							format: 'pdf',
						},
					},
				},
			}).summary,
		).toContain('email (invoice.sent)')
		expect(
			diffOp({ op: 'documents.remove', args: { templateId: 'doc-invoice' } })
				.layer,
		).toBe('documents')
		expect(s.documents?.templates).toHaveLength(1)
	})
})

describe('the whole-spec validator', () => {
	it('refuses a hand-edited documents.json with two templates on one key', () => {
		const s = applied(system(), declare())
		const first = s.documents?.templates[0]
		if (!first) throw new Error('expected a template')
		s.documents?.templates.push({ ...first, id: 'doc-copy' })
		expect(() => validateSpecSystem(s)).toThrow(/duplicate template key/)
	})

	it('refuses a hand-edited template whose section names a missing field', () => {
		const s = applied(system(), declare())
		const template = s.documents?.templates[0]
		if (!template) throw new Error('expected a template')
		template.sections = [{ kind: 'fields', columns: 1, fieldIds: ['fld-gone'] }]
		expect(() => validateSpecSystem(s)).toThrow(/not a field or derived value/)
	})
})
