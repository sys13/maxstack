# Refusals — one envelope, every surface

A declared resource emits three callers' worth of surface from one declaration:
the admin UI, `POST /api/:resource/...`, and the MCP tools. This page is the
contract for what all three say when the answer is **no**.

## The shape

Every refusal the framework constructs carries these fields, beside whatever
per-refusal detail that particular refusal already had:

```jsonc
{
  "code": "forbidden",           // the closed vocabulary below
  "message": "Permission denied: update on book",
  "fault": "policy",             // caller | policy | platform
  "rule": "access.book.update",  // what refused, by declared id — when known
  "retry": { "retryable": false, "after": 3600 },
  "next": "This identity is not permitted this action. …"
}
```

A status code carries one bit of what a caller needs. Two more decide what
happens next, and neither is derivable from the status:

**`fault` — whose rule this was.** `caller` means the request was wrong and
changing it will help. `policy` means the request was well-formed and a rule
refused it: changing the request changes nothing, so the next move is to change
the permission or ask someone who can. `platform` means it was not the caller's
request that failed at all.

**`retry` — whether it clears by itself.** A *separate* field from `fault`,
because the two do not line up. A spent portal budget is a `policy` refusal that
lifts in an hour; a client reading the 429 alone gives up forever on a refusal
that would have cleared. Conversely `forbidden` is never retryable — repeating
the request with the same identity gets the same answer, and a caller who
acquires a role is making a different request, not a retry.

`after` is in seconds and is the source of the `Retry-After` header, rather than
a second decision beside it. A refusal that is retryable but cannot honestly say
*when* gets no header: `Retry-After: 0` means "retry immediately", which is the
opposite of what an unbounded platform failure wants.

`rule` names what refused, using the id the spec uses. It matters most on the
`403`, where four different gates produce a byte-identical status and the
caller's next move differs for every one of them:

| `rule` | what to change |
| --- | --- |
| `api-key.scope.<resource>.<action>` | the key's scope, or use a different key |
| `portal.scope.<resource>.<action>` | the portal link — this one does not reach that |
| `access.<resource>.<action>` | the resource's declared rule, or the row's owner |
| `access.default` | the app declared `deny` and no held role grants it: bind a role |

`next` is one sentence on what the caller may do. It is derived from the code
and written once, never per throw site — the field most likely to rot into a lie
is the one written by hand at forty call sites and reviewed at none.

## The vocabulary

Closed, deliberately: a surface cannot invent a code no client knows how to
read. Status and fault come from one table in
`packages/maxstack-core/src/sprout/refusal.ts`, so REST, MCP and this page
cannot disagree.

| code | status | fault | retryable |
| --- | --- | --- | --- |
| `empty_update` | 400 | caller | no |
| `validation_failed` | 422 | caller | no |
| `limit_exceeded` | 422 | policy | no |
| `conflict` | 409 | caller | no |
| `constraint_violation` | 422 | caller | no |
| `forbidden` | 403 | policy | no |
| `not_found` | 404 | caller | no |
| `unknown_resource` | 404 | caller | no |
| `unsupported_operation` | 422 | caller | no |
| `rate_limited` | 429 | policy | **yes**, after 3600s |
| `selection_too_large` | 400 | caller | no |
| `invalid_action_choice` | 400 | caller | no |
| `unknown_action` | 404 | caller | no |
| `internal` | 500 | platform | yes, time unknown |

`not_found` is also the answer for a row you may not see. That is deliberate:
a `403` on a by-id read confirms the row exists.

## Per surface

**REST.** The envelope's fields sit at the top level of the JSON body, beside
`error` (still the message, still first — every existing client reads it) and
beside the detail that refusal already returned: `fieldErrors`, `fields`,
`conflict`, `constraint`, `limit`, `options`, `maxSelection`, `errorId`. Those
are shapes clients already walk and they did not move. `Retry-After` is set when
and only when the envelope names a delay.

**MCP.** The tool error's text is the message, unchanged, on the first line —
several of these messages *are* the repair instruction — followed by a line
naming the code, the fault, the rule and the retry:

```
Permission denied: update on book
[forbidden] fault=policy rule=access.book.update retry=no
This identity is not permitted this action. …
```

The one exception is `validation_failed`, whose MCP text is already a JSON
object of field → problems that clients parse. There the envelope is merged into
that object under `_refusal` rather than appended after it: a trailing prose line
would turn a parseable reply into a `SyntaxError` for every existing agent. A
leading underscore is not a legal field id, so the key cannot shadow one of the
app's own fields.

This surface is where a bare status cost the most. An agent reading
`403 Forbidden` has three options — retry, give up, or invent a reason — and all
three are bad.

## Notes for anyone extending it

`refusal.ts` **imports nothing**, and must keep importing nothing. A refusal is
rendered into a toast by a component, so anything it imports lands in the client
bundle; reaching for `instanceof` against the error classes would drag the
database client in behind it. The class → code mapping therefore lives at each
boundary that already imports those classes (`api.ts`, `mcp.ts`), and what lives
in `refusal.ts` is the part that is the same everywhere.

Because the classification is a total function of a code — no request, no
session, no clock — the contract is asserted as a table of inputs in
`refusal.test.ts` rather than by provoking each refusal against a database.

Related: [security-baseline.md](security-baseline.md) for what a `500` may and
may not say, [api-keys.md](api-keys.md) and [portals.md](portals.md) for the two
gates that are closed by default.
