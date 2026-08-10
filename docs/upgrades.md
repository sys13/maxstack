# Upgrading an app you already shipped

```sh
maxstack upgrade          # identically: maxstack gen --upgrade
```

One verb, two moves, in this order:

1. **Migrate the installed bundles.** Every bundle you installed is
   version-pinned in `maxstack.json` at the version it was added at. When the
   catalog ships a newer version, `upgrade` finds the gap and runs the
   registered **codemods** across it — each one a typed, idempotent
   `spec → spec` transform expressed as [spec-ops](spec-ops.md), landing in the
   op log like any other change — then moves the pin.
2. **Regenerate against the current framework.** The migrated spec is redrawn
   through the same never-clobber writer `maxstack gen` uses, so the newer
   framework's output lands and **a file you took ownership of is left exactly
   where it is**.

This is the difference between a feature bundle and a starter kit, and it is
the reason the two moves are one verb: a migrated spec that is never
regenerated is a spec describing an app that does not exist yet.

## What it looks like

A real run against a project pinned at `billing@0.1.0`, `members@0.1.0` and
`audit@0.1.0`, with `routes/subscription.tsx` **ejected** and hand-edited
first — the case that matters, because a pristine project proves nothing:

```console
$ maxstack upgrade
migrating installed bundles to the current catalog:

  billing 0.1.0 → 0.4.0
      · Add the `currentPeriodEnd` date field to the `subscription` mirror (0.1.0 tracked only status; 0.2.0 records when the period ends).
      · Materialize the `usage_event` ledger the metered quota check totals over, and the `/usage` admin page that reads it (0.2.0 mirrored subscriptions only; 0.3.0 adds usage metering). Idempotent: a spec that already has the entity and the page is left untouched. The page half was missing at first — an upgraded 0.3.0 project had the ledger table and no way to look at it, which is a state neither version recognizes.
      · Declare both `subject` columns OPEN over `e-user` and `e-organization` . 0.3.0 shipped them as bare strings with the loss recorded as a "cannot": the billing subject is a user in a per-seat app and an organization in a per-workspace one, and a reference names exactly one. The candidates are the catalog’s to declare and the choice is the project’s — narrow with `data.setFieldReference`. Idempotent, and a no-op on a field a project has already narrowed. The emitted column is unchanged (`text` either way), so this needs no data migration.
  members 0.1.0 → 0.2.0
      · Declare the organization foreign keys. 0.1.0 modelled `member.organizationId`, `member.userId` and `invitation.organizationId` as bare strings, so the platform could not resolve them to a name, could not see the relation in the graph, and could not roll anything up through them. This declares what was already true of the data. The organization columns change type (`text` → `uuid`) when the schema is next synced; the migration does that behind a guard and fails loudly if a row holds something that is not an id — which would mean the column was never really a foreign key.
  audit 0.1.0 → 0.3.0
      · Add `origin` and `apiKeyId` to `audit_log`. 0.1.0 recorded only a `userId`, which cannot distinguish a person in the admin UI from a script running under their api key or an agent driving MCP as them. Both fields are optional: existing rows keep reading, and an entry with no origin is a pre-upgrade entry rather than a claim that it was human.
      · Add `orgId` and `sourceKey` to `audit_log`. Both facts already reached the sink and neither reached the row: an upgraded trail can say which tenant a write landed in, and that a declared source’s own run made it rather than a person. Optional, so pre-upgrade rows keep reading — an entry with no `orgId` is an entry recorded before the column existed, not a claim that the write was tenant-less.

regenerating against the current framework generators…

  created     routes/usage_event.tsx
  preserved   routes/subscription.tsx (owned — left as-is)

1 created · 1 owned file(s) preserved · 2 artifact(s) refreshed
✔ upgrade clean — never-clobber held; your owned code is untouched
· 1 owned file(s) have drifted from the current derivation — "maxstack drift" shows what changed (nothing will be applied)
```

Three things in that output are the whole argument:

- **The per-step description is the changelog**, printed at the moment it
  applies to *your* spec rather than filed in a release post you have to map
  onto your project yourself. `billing` walked three hops in one command.
- **`preserved … (owned — left as-is)`.** The ejected route is not merged, not
  three-way diffed, not handed to you as a conflict. It is skipped, by
  construction — the writer cannot write an owned path.
- **The drift line.** "Your owned code is untouched" is true and incomplete: an
  upgrade is precisely when a file you own falls further behind what the
  platform would emit today. So the last line points at
  [`maxstack drift`](ownership.md), which reports that gap and writes nothing.
  Nothing is applied to a file you own, ever, without you asking.

## What ships today

Six codemods, across three bundles:

| Bundle | Chain |
| --- | --- |
| `members` | 0.1.0 → 0.2.0 |
| `audit` | 0.1.0 → 0.2.0 → 0.3.0 |
| `billing` | 0.1.0 → 0.2.0 → 0.3.0 → 0.4.0 |

The per-step descriptions are in
[`bundle-reference.md`](bundle-reference.md), which is generated from
`BUNDLE_CODEMODS` and is the source of truth for that list. A bundle version
gap with no registered codemod is a **clean version bump**, not an error — it
means nothing in the spec had to move.

The chain is not optional: `checkBundleContract` fails the build on a bundle
whose codemods do not form an unbroken path from its first release to its
current version, so "you can upgrade" is a gate rather than a promise.

## The rules it plays by

- **Multi-hop.** A project four versions behind runs the intermediate steps in
  order, in one command. You never have to find and replay releases yourself.
- **Idempotent.** Every codemod must be a no-op against a spec that already has
  its change, so running `upgrade` twice, or against a half-migrated project,
  converges. The [upgrade-safety gate](upgrade-safety.md) asserts exactly that:
  a second plan finds nothing to do and a second regeneration writes nothing.
- **Convergent.** An upgraded project must be the app a *fresh install* is —
  same entities, fields and pages, and a byte-identical generated tree. That is
  a gate, over prerequisite-closed subsets of the whole catalog, not a claim.
- **Never-clobber.** If the regeneration ever did rewrite a file you own, the
  command fails with `✖ upgrade clobbered owned files` and exits non-zero. That
  branch is a bug report, not a state you are asked to resolve.
- **Reviewable.** Codemod ops land in the op log stamped
  `actor.surface: 'codemod'`, so a declaration you never wrote is attributable
  to the upgrade that made it rather than looking like a human edit.

## See also

- [`upgrade-safety.md`](upgrade-safety.md) — the gate behind all of the above:
  pinned old project trees carrying real user modifications, plus a
  rewind-and-upgrade sweep over catalog subsets.
- [`bundle-reference.md`](bundle-reference.md) — the catalog, each bundle's
  version, and its full codemod chain.
- [`ownership.md`](ownership.md) — what "owned" means, and what `maxstack drift`
  reports after an upgrade.
