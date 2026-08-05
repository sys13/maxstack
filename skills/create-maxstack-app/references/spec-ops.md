# Spec-op vocabulary

Every change to a maxstack app is a typed op applied with `maxstack op --file
<op.json>` (or `--op '<inline-json>'`). The op is validated against the whole
system before it lands: dangling references, duplicate ids, and bad targets are
rejected with an exact message. After a successful op, run `maxstack gen` to
regenerate the app tree.

An op is always `{ "op": "<layer.name>", "args": { ... } }`.

**Provenance is optional.** Entities, fields, pages, blocks, and pricing tiers
all carry a `provenance` object internally, but you never have to write it by
hand — omit it (as every example below does) and `applyOp` stamps a sensible
default: `manual()` (accepted, protected from regeneration) for ops applied by
the CLI, `suggested()` (undecided, reviewable) for ops proposed over MCP. Pass
your own `provenance` only when you need to override that default.

## Data layer

### `data.addEntity`
Add an entity. This does not scaffold a route by itself — the entity is
reachable at the generic `/admin/:resource` surface right away, but a
dedicated CRUD page requires a separate `page.addPage` op (see below) before
the next `gen` will write route files for it.

```json
{
  "op": "data.addEntity",
  "args": {
    "entity": {
      "id": "e-invoice",
      "name": "Invoice",
      "fields": [
        { "id": "fld-total", "name": "total", "type": "number", "required": true }
      ]
    }
  }
}
```

### `data.addField`
Add a field to an existing entity.

```json
{
  "op": "data.addField",
  "args": {
    "entityId": "e-invoice",
    "field": { "id": "fld-status", "name": "status", "type": "enum", "required": true,
               "options": [{ "label": "Draft", "value": "draft" },
                           { "label": "Paid", "value": "paid" }] }
  }
}
```

**Field types:** `string` · `number` · `boolean` · `date` · `enum` · `json`.

- `type: "enum"` + `options: [{label, value}]` → form renders a select, read side
  renders a colored chip. Without `options`, an enum lands as free text.
- `reference: "<entityId>"` on a field makes it a belongs-to foreign key: it
  stores the target's id, the read side renders a `<ReferenceField>`, and the
  form renders an FK picker.

## Page layer

- `page.addPage` — add a page (optionally `entityId`-backed).
- `page.addBlock` — add a block to a page (`args.pageId`, `args.block`).
- `page.setBlockOrder` — set the sort order of an orderable **table** block:
  `args.pageId`, `args.blockId`, `args.order = { field, direction }`. The field
  must belong to the page's backing entity and the block must be a table.

## Product (PRD) layer

- `prd.addRequirement` — `intoPhaseId`, plus optional `servesMetricIds` /
  `enhancesRequirementIds` (validated against known metrics/requirements).
- `prd.addScopeItem` — optional `realizedByRequirementId`.
- `prd.addRisk` — `likelihood` and `impact` in 0–1; optional
  `threatensAssumptionIds`.
- `prd.addMetric` — optional `measuredByEventIds`.
- `prd.recordDecision` — append a decision to the ledger.

## Pricing layer

- `pricing.addTier` — add a pricing tier.

## Provenance

- `provenance.review` — record a review verdict on a target
  (`{ kind, id, parentId? }`). Provenance drives the suggest→accept model:
  regeneration grounds only on **accepted** items and never deletes items added
  manually.

## Tips

- **One op per file, named for the change.** They read as a changelog and each is
  validated independently.
- Ids are stable handles — prefix by kind (`e-` entity, `fld-` field, `p-` page)
  and keep them unique.
- If an op is rejected, the message names the exact offending id/reference. Fix
  the JSON; don't retry unchanged.
