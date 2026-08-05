# Declared documents

An invoice, a receipt, a statement, a packing slip: one row of your data, laid
out for paper, delivered as print-ready HTML or as a PDF. Declared with
`documents.declare`, rendered through the same read gate a `GET` on the row
passes, and delivered by the `storage` and `email` bundles you already have.

The ask it closes is invoicer's *"render a
branded, print-ready PDF of an invoice"* — which, before this, was an eject
every time.

## Why it is not just a page you print

The obvious objection first, because everything else follows from the answer. A
generated admin page and a printed invoice are not the same artifact with
different CSS:

| | a page | a document |
|---|---|---|
| bound to | a route and a viewer | one primary key |
| paginates by | scrolling | paper |
| has | interaction | a page size and margins |
| read by | somebody logged in | somebody who will never log in |

Printing a generated page gives you a screenshot of an app. That is why the ask
sat off-surface even though the platform could obviously *display* an invoice.

## The four ops

| op | what it changes |
|---|---|
| `documents.declare` | a new template: the entity, the paper, the sections, the delivery |
| `documents.setSections` | the layout, wholesale — the sections are only correct relative to each other |
| `documents.setDelivery` | where it goes; the outward-facing half, so it reviews on its own |
| `documents.remove` | the declaration — refused while any delivery target is still on |

`documents.setDelivery` with everything `false` is how you retire a template.
Removing the declaration first would turn a bookmarked link into a 404 and an
archive write into an error, with nothing left in the spec that names either —
the same ordering rule `search.remove` follows, pointed outward.

## A template

```json
{
  "id": "doc-invoice",
  "key": "invoice",
  "description": "The invoice a client receives, on paper or as a PDF.",
  "entityId": "e-invoice",
  "pageSize": "a4",
  "sections": [
    { "kind": "heading", "level": 1, "text": "Invoice {number}" },
    { "kind": "fields", "columns": 2, "caption": "Bill to",
      "fieldIds": ["fld-invoice-client", "fld-invoice-due"] },
    { "kind": "table", "caption": "Line items",
      "over": "e-lineitem", "via": "fld-lineitem-invoice",
      "fieldIds": ["fld-lineitem-label", "fld-lineitem-amount"],
      "orderBy": "fld-lineitem-label" },
    { "kind": "rule" },
    { "kind": "fields", "columns": 1, "fieldIds": ["drv-invoice-total"] },
    { "kind": "slot", "name": "letterhead" }
  ],
  "delivery": {
    "download": true,
    "store": { "path": "invoices/{number}.pdf", "format": "pdf" },
    "email": {
      "template": "invoice.sent",
      "subject": "Invoice {number} from Acme",
      "to": { "via": "fld-invoice-client", "fieldId": "fld-client-email" },
      "format": "pdf"
    }
  }
}
```

Several templates per entity is normal and expected — an invoice, a receipt and
a statement are three documents about one row. (Unlike a search index, where one
entity has exactly one answer to "what does searching this mean".)

## The six sections

`heading` · `text` · `fields` · `table` · `rule` · `slot`

That is the whole vocabulary, and the shortness is the design. There is no
nesting, no width, no color, no layout language — because a component model here
would be the beginning of a second UI framework, which is the thing this
gates against. What it reuses instead:

- **Relations are `over`/`via`,** spelled exactly as `data.addRollup` spells
  them and meaning exactly the same thing. `over` is the entity on the many
  side; `via` is the foreign key on it pointing back at this row.
- **A total is a rollup.** `fields` and `table` sections take derived-value ids
  (`drv-…`) alongside field ids, so an invoice total is the `sum` rollup you
  already declared — the same number the app shows. This layer ships no
  arithmetic of its own, because two answers to "what does this invoice come to"
  eventually disagree in front of a customer.
- **Labels are the field's own name.** Rename the field, rename the label. There
  is no parallel set of captions to keep in step.
- **Styling is `theme.set`.** See below.

### Placeholders

`{fieldName}` in a heading, a paragraph, a caption, an email subject or a stored
object path resolves against the row, through the same formatter the `fields`
sections use. Names are validated at declare time, so a renamed field fails the
op rather than printing `{number}` on something a customer receives.

**There is no `{today}`.** Same row plus same template must give the same bytes;
a document whose output changes every time you ask for it cannot be diffed,
cached, or compared against the copy a customer says they received. An issue
date is a `date` *field* on the row, which is where it belongs anyway.

### The slot

`{ "kind": "slot", "name": "letterhead" }` is the escape hatch for the part of a
document that is a design rather than a declaration. The fill returns layout
blocks, not HTML and not PDF operators — so a bespoke region still renders to
both targets, and still cannot reach a row the caller may not read. A
heavily-designed document is a slot fill, not an eject of the whole surface.

## Theming

A template declares no color, no font and no spacing. Rendering resolves the
app's `theme.set`: the accent becomes the title color and the table
rule, the font becomes a CSS stack in HTML and a base-14 family in PDF, and
density and type scale set the rhythm. "Make the invoice match the product" is a
change you already know how to make.

The five theme fonts collapse to three (`sans` / `serif` / `mono`) because a
printed page has three kinds of typeface; `rounded` and `humanist` are
distinctions webfonts make, and a document ships no webfont.

## Rendering, and why there is no browser in the image

**The recorded decision.** PDFs are written directly, by a dependency-free
PDF 1.4 writer using the base-14 fonts. There is no headless Chromium, no font
file and no npm dependency, and this is a decision rather than an implementation
detail:

| | this writer | headless Chromium |
|---|---|---|
| runtime image | **+0 MB** (measured: +81 KiB of app code, 0 new deps) | +150–300 MB |
| a non-Latin script | bind a font file — see below | included |
| deterministic | byte-identical, no timestamp in the file | varies with browser build |
| in the request path | a pure function | a sandboxed process that can fetch URLs |
| renders | the six block kinds | anything |

The last row is the price, stated plainly: this is not a CSS engine and will
never render an arbitrary page. That is the same bargain the six-section
vocabulary makes.

Both targets are produced from **one compiled layout**. Neither backend reads
the template, so they can disagree about pixels and never about content: there
is exactly one place that decides how a number prints, one that resolves a
placeholder, and one that decides a table was truncated.

### Character sets, and the font you can bind

The base-14 fonts use **WinAnsiEncoding** — ASCII, Latin-1, and the typographic
extras real text contains (curly quotes, en/em dashes, the euro sign). Text
outside that set (Greek, Cyrillic, CJK, Devanagari, Hebrew, Arabic, Thai) has no
byte to be written as and renders as `?`. That is still the default, because it
is what costs nothing.

**Bind a font and the limit goes away.**

```sh
MAXSTACK_PDF_FONT=/srv/fonts/NotoSans-Regular.ttf
MAXSTACK_PDF_FONT_BOLD=/srv/fonts/NotoSans-Bold.ttf   # optional
```

The PDF then embeds a **subset** of that font — a `Type0` font with `Identity-H`
encoding over a `CIDFontType2` descendant — carrying outlines for the glyphs the
document actually draws and nothing else. A `ToUnicode` CMap ships with it, so
the text stays selectable, copyable and searchable; without one, the text in the
file *is* glyph ids and copying an invoice number yields nonsense.

It is an **environment variable rather than a spec op** on purpose. A bound font
answers "which scripts can this container print", which is a property of the
image in the same category as `DATABASE_URL` — declaring it in the spec would
make the spec render correctly only on machines that happen to have the file.

A path that is missing, or is an `.otf`/CFF or a `.ttc` collection, is **reported
with the reason and falls back to base-14** rather than failing every document.
A Latin invoice still renders, and the operator learns from their own log rather
than from a support ticket.

Bold is optional. Without it, bold text renders in the regular face and the
document embeds one copy of the font — the alternative, a synthesized bold, is
what a reader does for a font it is *missing*, and it reads as a bug.

#### The measured cost

The measured number — `+81 KiB image, zero new dependencies` — is the
number for a deployment that binds nothing, and this change does not move it:
no font ships in the image, no dependency was added, and a base-14 document is
byte-for-byte what it was.

| Bound | Font file | Per-document PDF |
| --- | --- | --- |
| nothing (the default) | — | **1.2 KiB**, unchanged |
| a Latin face (Geneva) | 737 KiB | **25 KiB** |
| a full-Unicode face (Arial Unicode, 50,377 glyphs) | 23 MiB | **313 KiB** |

The image cost is the font file the operator puts there, and nothing else.

The per-document figure is dominated by `loca` and `hmtx` rather than by
outlines: the subsetter keeps every glyph **id** where it was and empties the
outlines it does not need, so the two tables stay proportional to the *original*
face. That is deliberate. A renumbering subset would be smaller and has to
rewrite composite-glyph references — the accented letters a European invoice is
full of — inside the outline data, and getting that wrong produces a letter made
of the wrong pieces, silently. `hmtx` is truncated after the highest glyph used,
which is what takes a CJK document from 835 KiB to 313 KiB.

Determinism survives: the glyph set is subsetted **sorted** rather than in the
order the document happened to draw them, and the six-letter subset tag PDF
requires is derived from the subset's own bytes rather than from a counter. Two
renders of the same row are byte-identical with a font bound exactly as they are
without one, and that is asserted.

One thing does not change and is worth stating: the PDF's `Info` dictionary —
the title a file browser shows — is always a base-14 string, because it is
metadata rather than text drawn on a page and has no font to be encoded against.
A non-Latin title prints correctly on the page and still shows `?` in the file
properties.

**The HTML target has never had any of this limit**, because a browser has every
font the reader has.

### Numbers and dates

Locale-free by construction, because `Intl` output depends on the ICU build and
the process's locale — an invoice rendered in Frankfurt would differ byte-for-
byte from the same invoice rendered in Ohio, and "the copy we have on file does
not match the copy you received" is the one failure a document feature cannot
have.

- numbers keep the digits they have, grouped in threes: `1,234.5`. No forced two
  decimals — this layer does not know a column is money, and printing
  `Quantity: 3.00` to imply it would be worse than printing `3`.
- dates print `YYYY-MM-DD`, unambiguous in every country. `03/04` is not.
- booleans print `Yes`/`No`; enums print their declared label; an absent value
  prints an em dash.

Currency symbols and locale-aware formatting are deliberately absent: they are a
*declaration* somebody has to make, not something to infer from the process the
render happened to run in.

## Access

**Rendering a document is a read of the row**, and that is structural rather
than a rule anybody has to remember. `opRenderDocument` is built out of `opGet`
and `opList` — it has no other way to fetch a row — so:

- a caller who may not read the row gets the same refusal a `GET` would give
  them, never a blank document;
- each `table` section's rows pass **that resource's own** read gate, so a
  document can never print rows from a table the viewer may not list;
- a refusal on the child propagates rather than silently emptying the table,
  because a document that omits billable lines looks complete and is not;
- tenant and soft-delete scoping apply exactly as everywhere else.

This holds for a **stored or emailed** copy too, for the same structural reason:
the delivery functions take a compiled layout, and the only thing that produces
one is `opRenderDocument`.

## Delivery

```
GET /documents/:key/:id.html
GET /documents/:key/:id.pdf
```

The format is the extension, not a query parameter, so a saved file is named
after the document rather than after the route segment. Responses are
`private, no-store`: a document renders live rows, so the gate has to run for
every viewer rather than once for the first one.

**`delivery.download` decides whether that URL exists at all**, and it did not
used to. The flag was dropped at grounding, so the route served
every declared template: turning it off retired a template from the exposure
report and from nothing else, and a template delivered only by email kept a
working public URL the declaration said it did not have. The check now lives in
`opRenderDocument`, not in the route — a route-level gate is a gate the other
callers skip, and there are three callers. `via` defaults to
`'download'`, the checked value, so a caller that has not thought about it gets
the strict answer; a storage or email delivery says `via: 'store' | 'email'` and
renders a template that has no URL.

### Finding one

A declared template appears as **PDF** and **HTML** links on the record page in
the admin, under *Documents*. Previously it appeared nowhere at all: you
reached a working, access-controlled, print-ready document only by typing
`/documents/<key>/<id>.pdf` with a row id in it, which made a shipped feature
indistinguishable from one that had not been built. Every other op produces a
surface you can navigate to; so does this one.

A retired template is not linked, from the same flag that removes its URL. And
there is no second read check on the link: reaching the record page means
`opGet` already returned the row through the identical gate the document route
runs, so a second check would be a second copy of an answer already in hand.

### The MCP tool, and why it returns no bytes

`render_document`, taking the template key as an argument — offered whenever
some template declares a download, gated on `read` exactly as `get_record` is.
(One tool rather than one per template since a change that made the whole
generated tool surface fixed-size; `describe_resources` lists the templates each
resource declares.)

It shipped no tool deliberately, and the reasoning was that a document is
*bytes*: an MCP tool returning a base64 PDF is a large opaque payload in a
context window. That is right about PDF and wrong about documents. Both formats
are serializations of a `DocumentLayout`, which is structured text — headings,
paragraphs, label/value pairs, tables — so the tool returns **the layout, the
title, and the two links**. An agent driving a billing workflow wants to read
the invoice and hand a person a link to it; both are served, and neither is
served by base64 no model can read.

There is no `format` argument, because there is nothing to choose between: the
caller gets the content in the one shape it can act on, and links for the shapes
it cannot.

**Storage.** `delivery.store` writes the rendered bytes to the storage bundle
under the declared path with the row's values substituted. At least one
`{placeholder}` is required — a constant path is one object key for every row,
so the archive would hold exactly one document however many were sent. Values
are slugged, so a row value cannot introduce a directory level or climb out of
the prefix.

**Email.** `delivery.email` attaches the document to a registered email
template. The recipient is a field path of at most **one hop**: `{ fieldId }`
reads from the row, `{ via, fieldId }` follows one reference (an invoice's
client). Two hops is a query, and an outbound email should not traverse a path
nobody wrote down.

This is what "bundles compose" looks like in practice, and the evidence is what
did *not* have to change: `storage` needed nothing at all (a document reaches it
as bytes and a content type, which is `put`'s existing signature), and `email`
grew exactly one field — `OutgoingEmail.attachments`, a general capability that
a receipt, a report or a CSV export wants too. Nothing in either bundle learned
what a document is.

## Bounds

| | limit | why |
|---|---|---|
| sections per template | 32 | rendered in one pass, in memory, for a caller who supplied one row id |
| fields per `fields` block | 24 | |
| columns per `table` | 8 | |
| rows per `table` | 500 | forty pages is not paper |
| template key | 48 chars | it becomes a URL segment and an object-key prefix |

A table past 500 rows prints **"Showing the first 500 of 812 rows."** on the
page. It is never silent: a document that quietly omits billable lines is the
worst bug this feature could ship.

## What is deliberately not here

- **A layout language** — no columns beyond one-or-two, no absolute positioning,
  no page-break control. Each is the first step of the second UI system; the
  slot is the answer.
- **Uploaded logos.** A logo is a `file` field on some settings row, and
  reaching arbitrary rows from a template would mean a second data-access path
  with its own gate. Logos arrive through a slot.
- **Compliance formats.** A PDF/A-3 carrying an embedded EN 16931 XML payload,
  validated against a national scheme, under a gap-free statutory numbering
  sequence, is a legally-specified *data* problem rather than a layout one. It
  is the corpus's remaining document-generation ask
  (`docs/corpus/invoicer-einvoice-compliance.md`).
