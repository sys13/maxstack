# Flags and preferences

Two small bundles that both answer "this value varies per person" — and answer
it in deliberately different places.

| | Feature flags | Preferences |
| --- | --- | --- |
| Declared in | the **spec** (`flags.json`, `flags.*` ops) | **code** (`BUILT_IN_PREFERENCES`, extensible at the composition root) |
| Varies by | role, organization, or a percentage bucket | the user, with an organization default |
| Changes | which surfaces the app *composes* | what a value *is* |
| Lifecycle | declare → target → ramp → **remove** | declare → forever |

The split is not arbitrary. A flag changes the shape of the app — a page exists
or it does not — so the workbench has to be able to see it, which means it has
to be spec data. A preference changes a value inside a shape that is already
visible, so a spec layer would buy four more ops and a codec change for no new
visibility. ---

## Feature flags

### Declaring one

```jsonc
{
  "op": "flags.declare",
  "args": {
    "flag": {
      "id": "flg-checkout-v2",
      "key": "checkout-v2",
      "description": "The rebuilt checkout flow.",
      "default": false
    }
  }
}
```

`declaredAt` is stamped from the op, not authored — flag age is a reported
number, and a hand-written date drifts the moment someone copies an op file.

### Targeting

Targeting is an **allowlist over a default-off flag**. Every key is an OR: a
viewer matching any of them gets the flag.

```jsonc
{ "op": "flags.setTargeting",
  "args": { "flagId": "flg-checkout-v2",
            "targeting": { "roles": ["admin"], "rolloutPercent": 10 } } }
```

- `roles` / `organizations` — matched against the viewer's server-resolved role
  and active organization. Never against a header or a query parameter: a flag
  routinely gates an unreleased surface, and "send a header to see it" is not a
  rollout.
- `rolloutPercent` — an integer 0–100, bucketed by a stable FNV-1a hash of
  `subject:key`. The same subject always lands in the same bucket, so **ramping
  a rollout never turns anyone back off**, and a viewer with no subject id is
  never bucketed on.

Targeting a flag whose `default` is already `true` is **rejected**: it reads
like a rollout, changes no outcome, and is exactly the shape a half-finished
rollout leaves behind. Turn the default off instead.

`flags.setTargeting` is last-wins, and omitting `targeting` clears it — so
"pause the rollout" is one op.

### Gating a surface

```jsonc
{ "op": "flags.gate",
  "args": { "target": { "kind": "page", "id": "pg-checkout" },
            "flag": "checkout-v2" } }
```

`kind` is `page` or `block` (a block needs its page as `parentId`). Pass
`"flag": null` to ungate. A gate naming an undeclared flag is refused at the op,
so a spec can never carry a dangling gate.

At request time the running app composes a gated page only for viewers the flag
is on for, and **the URL 404s for everyone else** — hiding the nav entry alone
would be a link nobody can see and anybody can type. A gated block simply is not
part of the page.

Two defaults both point the same way: a flag nobody evaluated, and a gate naming
a flag that no longer exists, both read as **off**. A forgotten evaluation
context hides an unreleased page rather than leaking it.

### Determinism

> A flag that gates a derived surface must not break determinism. Generation
> output cannot depend on flag *values* — only on their declaration.

maxstack meets this in the stronger form: **generation does not depend on a flag
at all.** Evaluation happens per request against a viewer, in the running app;
the ownership generators import the spec and cannot reach an evaluation. So a
flag does not produce two code paths that must each stay deterministic — it
produces one, and the generated tree for a flagged app is byte-identical to the
tree for an unflagged one.

That is pinned against a corpus app in
`apps/maxstack/src/lib/flag-determinism.test.ts`: the same spec, generated under
flag states that demonstrably differ at runtime, must emit identical files.

### Retiring one

Stale flags are the standard failure mode of every flag system, so the flag
layer is enumerable rather than searchable:

- **What does this gate?** Computed from the spec (`flagGates`), shown in the
  workbench's flags pane.
- **Is anyone still asking?** `FlagService` records evaluations, coalesced in
  memory and written at most once per flush interval — a flag evaluated ten
  thousand times a minute costs one write, not ten thousand.
- **Should it go?** `FlagService.report()` returns every flag with its age,
  gate count and last use, plus a reason list: `gates-nothing`,
  `never-evaluated`, `not-evaluated-recently`, `rollout-complete`. Nothing is
  reported inside a grace window (default 14 days) — a report that fires on
  every new flag is a report people learn to ignore.

```jsonc
{ "op": "flags.remove", "args": { "flagId": "flg-checkout-v2" } }
```

`flags.remove` is the one deliberately non-additive structural op in the
vocabulary. It is **refused while any surface still gates on the flag**, naming
the surfaces — ungate them first. The removal itself stays auditable: the op log
keeps its diff.

### Who may change targeting

Owner and admin only (`assertCanManageFlags`), checked in the service rather
than at a route — the lesson from the rule is that routes are not the only way
into a service. An absent identity is a denial, not a bypass.

---

## Preferences

### Declaring one

```ts
{
  key: 'digest-frequency',
  label: 'Digest frequency',
  description: 'How often the activity digest is sent.',
  type: 'enum',
  options: [ { label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' } ],
  scopes: ['user', 'organization'],
  default: 'weekly',
  group: 'Notifications',
}
```

That entry is the whole change. It produces the storage (a key/value row per
scope), the type checking on read and write, and the form field — the settings
page names no preference at all.

### Resolution

**user → organization → declared default**, and only for scopes the declaration
names. `PreferencesService.resolve()` returns each value *and where it came
from*, so an inherited value renders as "from your organization" instead of
looking like a choice the user made.

This is why storage is one row per **set** value rather than a column per
preference: a column always has a value, so it cannot distinguish "chose false"
from "has not chosen" — and that distinction is the entire meaning of an
organization default. `clearUserPreference` is the operation "use the org
default again", which writing a value cannot express.

### Read cost

> Preference reads must be cheap — a per-request settings lookup on every page
> is a performance trap.

A resolve is **at most one query per scope, and normally zero**: values are
cached per scope with a short TTL (30s by default) and invalidated on write, so
a write shows up immediately rather than being waited out. The two scopes cache
separately, so an organization-wide change does not flush every member's entry.
`PreferencesService.queryCount()` exists so this is a test assertion rather than
a claim in a comment.

The service is a **singleton** at the composition root. A per-request instance
would start cold every time, which is the same as having no cache.

### Authorization

- A user may set **their own** preferences and nobody else's — not even an
  admin. An admin who can flip another person's notification settings can
  silence their alerts; the organization default is the supported way to steer
  members.
- Organization defaults require **owner or admin**
  (`canManageOrgPreferences`), enforced in the service.
- An **unknown key is refused** rather than stored. A typo'd preference that
  writes successfully and then reads back as its default is the most confusing
  failure this layer can have.

### The derived form

`PreferencesService.describe(scope, target, actor)` returns fields grouped as
declared, each with its value, its source, and whether this scope may write it;
`<PreferencesForm>` (`@maxstack/ui`) renders them. Two behaviors are load-bearing
and invisible in the markup:

- Every boolean field renders a hidden `off` input before its checkbox, because
  **an unchecked checkbox submits nothing** — without it, "turn this off and
  save" would silently leave the old value in place.
- A field the viewer may not write renders disabled, so a member sees their
  organization's defaults read-only rather than not at all.

### Upgrading from the one-column-per-preference table

The original `user_preference` was one row per user with a boolean column per
preference. `migrateLegacyUserPreferences()` renames it aside, creates the
key/value shape, copies each column across as a row, and drops the old table.
It is idempotent and runs on first use; a user's stored choice arrives as a
*choice*, not as a default.
