# API keys

Programmatic access to the derived REST API and the MCP endpoint — the
`api-keys` bundle. The generated catalog entry lives in
[`bundle-reference.md`](bundle-reference.md#api-keys--api-keys); this page is
the narrative half: what the design is and why it is shaped this way.

```sh
maxstack add api-keys
```

`auth` is a prerequisite. A key's whole safety story is "it can do no more than
the person who issued it", and without an identity table there is no person.

## Issuing

Keys are managed from `/api-keys`. A key carries:

| | |
| --- | --- |
| **name** | so the list is readable later |
| **scope** | resource → actions (`read`/`create`/`update`/`delete`) |
| **organization** | the issuer's active org at issue time, or none |
| **budget** | requests per minute, or the deployment default |
| **expiry** | optional; checked at verify time |

The plaintext token is displayed **once**, immediately after issue or rotation.
Only a SHA-256 hash is stored, so the product genuinely cannot show it to you
again — not as a policy, as a missing capability. Anything that can re-display
an existing key has already lost the argument about what it does with your
credentials at rest.

Present it as a bearer token:

```sh
curl -H "Authorization: Bearer mx_..." https://your-app/api/order
```

## The scope is a restriction, never a grant

This is the property everything else rests on, so it is worth being precise
about the mechanism.

A verified key resolves to an identity carrying **the holder's own role** plus
the key's scope. Both then apply:

```
allowed  =  scope names (resource, action)   AND   the resource's own rule allows the holder
```

The second half is why a key cannot escalate. A key scoped to `delete` on
`order` in a *member's* hands is still refused by an `admin`-gated delete rule,
because the rule is evaluated against the holder. The same scope in an admin's
hands succeeds. The scope only ever subtracts.

The first half is why a key cannot wander. Everything else in the permission
layer is **open by default** — an action with no rule is allowed — and a key is
the deliberate exception: a resource the scope does not name is denied *even if
that resource has no access rule at all*. Otherwise "we haven't written rules
for that table yet" would be the path by which a read-only integration key
reaches it.

Both checks live in `authorize()` / `canPerformAction()` in
`@maxstack/core`'s permission layer, not in the REST routes. That matters
because REST is not the only door: the MCP endpoint and the admin loaders reach
the ops layer without passing any route-level gate. Previously the scope was
checked in the REST routes only, which meant a key could drive the MCP tools
with no scope restriction at all. `checkApiKeyScope` still exists on the REST
surface, but only to return a specific `403 Out of scope` early — it delegates
to the same `scopeGrants` predicate, so the two cannot disagree.

## Organizations

A key's org comes from the key row and nowhere else. Session requests resolve
their active org from the `maxstack-org` cookie, verified against membership
when the project has a `member` resource — but a scripted caller has no session
for that check to run against, and in a project without the `members` bundle
there is nothing to verify against at all. So a key does not get to claim: it is
pinned at issue time to the issuer's active org, or to nothing.

A key with no org pin **reaches no tenant-scoped resource**. That is the
intended answer rather than a gap: a tenant-scoped read with no tenant is a
cross-tenant read waiting to happen.

## Revocation and rotation

Revocation takes effect on the next request. Verification reads the key row
every time, and there is deliberately no cache in front of it — a one-second
cache is a one-second window in which a key someone has just revoked in a panic
still works, in exchange for saving one indexed lookup on a unique column.

Rotation revokes the old token and issues a new one carrying the same name,
scope, org pin, budget and expiry. The old token stops working immediately; this
is the documented remediation for a leaked key.

## Budgets

Rate limiting buckets **per key**, not per user. Two keys held by the same
person have independent budgets, and neither can exhaust the budget of that
person's browser session — a runaway script should not be able to take its
owner's UI down with it. It also means revoking the key is the fix for the
noise, which is a fix an operator can actually apply.

Every REST response carries the budget, not just the `429`:

```
x-ratelimit-limit: 30
x-ratelimit-remaining: 27
x-ratelimit-reset: 1785000000
```

A client that can only discover its budget by being refused has to hit the wall
to find it. `429` additionally carries `retry-after`.

`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` set the deployment default. The
buckets live in the shared coordinator: one row per bucket in
Postgres when the store is Postgres, so every instance spends from one budget,
and this process's memory on pglite, where a second instance cannot exist. The
mode is logged at boot.

## Attribution

Audit entries record `origin` — `session`, `api-key`, `mcp` or `system` — and,
for a key, the `apiKeyId`. A bare `userId` cannot tell a person clicking in the
admin UI apart from a script running under their credentials, and those are
exactly the two things you need separated when a row changed unexpectedly. The
structured request log carries `apiKeyId` for the same reason: a traffic spike
should resolve to one credential you can revoke, not just to the account that
happens to hold it.

`audit_log` gained these two columns in `audit` **0.2.0**; a project installed
at 0.1.0 walks forward with `maxstack gen --upgrade`. Both are optional, so a
pre-upgrade row reads as "origin unknown" rather than silently as a human
session.

## Limits worth knowing

- **The scope vocabulary is resource + CRUD action.** There is no field-level
  projection and no row-level condition; a key that can read `order` can read
  every column of every `order` its holder can. Field projection is the portal layer's
  concept and belongs there rather than in a second implementation here.
- **Revoking a *user* does not cascade to their keys.** The holder's role is
  re-read on every request, so a demoted user's keys are demoted with them, and
  a deleted user's keys resolve to no role — but the key rows stay listed until
  revoked.
- **The limiter is per deployment on Postgres and per process on pglite**. It used to be per process unconditionally, so two app instances
  meant two budgets; pglite cannot have two instances, so the remaining case is
  not reachable.
- **`api_key` is not a spec entity**, so it has no admin CRUD surface and no
  REST resource. That is deliberate: a REST-reachable key table is a table a key
  could point at to widen its own scope.
