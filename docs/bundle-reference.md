<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Source: `BUNDLES` in `packages/features/src/bundle/catalog.ts` + `BUNDLE_CODEMODS`
     Regenerate: pnpm docs:reference   (the validate gate checks this is current) -->

# Bundle reference

The 17 installable feature bundles — 15 user-facing capabilities
plus 2 pieces of plumbing that are catalog entries only because
their install record drives composition-root wiring.

```sh
maxstack add <slug>   # prerequisites first, each through the same spec-op path
maxstack upgrade      # walk installed bundles forward through their codemods
```

## The contract

Every entry below satisfies seven requirements, enforced in
`packages/features/src/bundle/contract.test.ts` — not reviewed by eye:

1. **Honest prerequisites**, proven by installing the bundle alone into a bare project.
2. **A versioned upgrade codemod path** — an unbroken chain from first release to today,
   so a project installed at any version can walk forward. This is the whole difference
   from a starter kit, so it is a hard gate.
3. **Its own eval artifacts** — a PRD fragment and at least one honestly-sourced change
   ask, so a bundle’s cost is measured like everything else.
4. **Idempotent install** that never clobbers what it previously wrote.
5. **Uninstall, or a documented reason there is none.**
6. **Generated reference docs** — this file, drift-checked in the validate gate.
7. **A declared ownership footprint** (tables, page routes, and owned-code routes)
   collision-checked at install
   against everything already there.

## Catalog

| Bundle | Kind | Version | Prerequisites | What it gives you |
| --- | --- | --- | --- | --- |
| [`auth`](#auth--authentication) | capability | `0.1.0` | — | Authentication |
| [`audit`](#audit--audit-log) | capability | `0.3.0` | — | Audit log |
| [`email`](#email--transactional-email) | capability | `0.1.0` | — | Transactional email |
| [`db-plugins`](#db-plugins--seed-plugins) | plumbing | `0.1.0` | — | Seed plugins |
| [`di`](#di--dependency-injection) | plumbing | `0.1.0` | — | Dependency injection |
| [`storage`](#storage--file-storage) | capability | `0.1.0` | — | File storage |
| [`jobs`](#jobs--scheduled-work) | capability | `0.1.0` | `auth` | Scheduled work |
| [`webhooks`](#webhooks--webhooks) | capability | `0.1.0` | `auth`, `audit` | Webhooks |
| [`observability`](#observability--observability) | capability | `0.1.0` | — | Observability |
| [`compliance`](#compliance--data-compliance) | capability | `0.1.0` | `auth`, `audit` | Data compliance |
| [`api-keys`](#api-keys--api-keys) | capability | `0.1.0` | `auth` | API keys |
| [`flags`](#flags--feature-flags) | capability | `0.1.0` | `auth` | Feature flags |
| [`members`](#members--organizations--members) | capability | `0.2.0` | `auth` | Organizations & members |
| [`preferences`](#preferences--preferences) | capability | `0.1.0` | `auth`, `members` | Preferences |
| [`notifications`](#notifications--notifications) | capability | `0.1.0` | `auth`, `email`, `preferences` | Notifications |
| [`billing`](#billing--billing--entitlements) | capability | `0.4.0` | `auth` | Billing & entitlements |
| [`admin`](#admin--admin-metrics) | capability | `0.1.0` | `auth`, `audit` | Admin metrics |

## Bundles

### `auth` — Authentication

better-auth sessions + password login and the canonical identity tables (user/session/account/verification), with a non-input `role` field as the RBAC bridge. Materialized as infra DDL, not a spec entity.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | none |
| Entitlement | — |
| Tables owned | `user`, `session`, `account`, `verification`, `two_factor` |
| Routes owned | none |
| Owned-code routes | none |
| DI bindings | `auth` |
| Uninstall | not supported |

**No uninstall.** Identity is load-bearing for everything downstream: members, billing subjects, audit rows, and the op-log author column all reference `user`. Dropping the identity tables would orphan them, and the spec vocabulary has no remove-entity op to unwind the dependents. Start a new project instead of uninstalling auth.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Let people sign in with an emailed magic link instead of a password. _(real-product: better-auth ships a magicLink plugin; Notion and Vercel both default to passwordless email sign-in.)_
- Give the scaffolded app a real /login page wired to the session. _(issue-report: a dogfooded project installed auth and had nowhere to sign in.)_

### `audit` — Audit log

A write-only audit trail. Contributes the `audit_log` table and an `auditSink` binding services record mutations through. Every entry records how the caller reached the app — a browser session, an api key (with the key id), or an agent over MCP — the organization the write happened in, and the declared source whose run made it, when one did.

| | |
| --- | --- |
| Version | `0.3.0` (first shipped `0.1.0`) |
| Prerequisites | none |
| Entitlement | — |
| Tables owned | `audit_log` |
| Routes owned | none |
| Owned-code routes | none |
| DI bindings | `auditSink` |
| Uninstall | not supported |

**No uninstall.** The audit trail is append-only by design and the admin bundle aggregates over it. Removing it would delete the record of who did what, which is the one thing an audit log must not offer as a button.

**Upgrade path.**

| From | To | Migration |
| --- | --- | --- |
| `0.1.0` | `0.2.0` | Add `origin` and `apiKeyId` to `audit_log`. 0.1.0 recorded only a `userId`, which cannot distinguish a person in the admin UI from a script running under their api key or an agent driving MCP as them. Both fields are optional: existing rows keep reading, and an entry with no origin is a pre-upgrade entry rather than a claim that it was human. |
| `0.2.0` | `0.3.0` | Add `orgId` and `sourceKey` to `audit_log`. Both facts already reached the sink and neither reached the row: an upgraded trail can say which tenant a write landed in, and that a declared source’s own run made it rather than a person. Optional, so pre-upgrade rows keep reading — an entry with no `orgId` is an entry recorded before the column existed, not a claim that the write was tenant-less. |

**Eval asks.** The change asks this bundle is measured with:

- Show the audit log filtered to one resource, newest first. _(real-product: Stripe Dashboard → Developers → Events: filtered by resource type, reverse chronological.)_

### `email` — Transactional email

A name-keyed template registry (custom overrides default) plus a mailer transport. Exposes `emailRegistry` and `mailer` bindings.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | none |
| Entitlement | — |
| Tables owned | none |
| Routes owned | none |
| Owned-code routes | none |
| DI bindings | `emailRegistry`, `mailer` |
| Uninstall | supported |

**Uninstall.** Contributes no schema and no routes: removing the install record and the `emailRegistry`/`mailer` bindings at the composition root is the whole uninstall. Anything that sends mail must be removed first, or its required binding fails loud at boot (which is the intended behaviour).

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Rewrite the password-reset email copy without ejecting the registry. _(real-product: Postmark and Resend onboarding both treat "replace the default copy" as the first thing a team does before launch.)_

### `db-plugins` — Seed plugins

The FK-ordered seed-plugin registry that runs installed bundles’ seeds at boot. Exposes the `dbPlugins` binding.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | none |
| Entitlement | — |
| Tables owned | none |
| Routes owned | none |
| Owned-code routes | none |
| DI bindings | `dbPlugins` |
| Uninstall | supported |

**Uninstall.** Registry only — dropping the `dbPlugins` binding leaves installed bundles’ seeds unloaded, which is a data-freshness change, not a schema one.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Seed my own demo rows after the bundles’ seeds without hitting FK errors. _(dogfood: 2026-07 demo-seeding session: project seeds had to run after the members bundle’s organization row existed.)_

### `di` — Dependency injection

The typed DI-bindings contract (`createBindings` + missing-binding guard) and its React `<BindingsProvider>`/`useBindings` wiring.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | none |
| Entitlement | — |
| Tables owned | none |
| Routes owned | none |
| Owned-code routes | none |
| DI bindings | none |
| Uninstall | not supported |

**No uninstall.** The bindings contract is how every other bundle reaches the composition root. Removing it is removing the seam, not a feature — eject the app instead if you want different wiring.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Swap the console mailer for a real transport in exactly one place. _(dogfood: apps/web/app/sprout.server.ts composition-root work — the binding swap is the change every dogfood project made first.)_

### `storage` — File storage

Declared `file` fields on entities — a MIME allowlist and a size cap per field, uploads through the validated write path, and viewer-bound expiring reads. Local disk in dev and S3-compatible in deploy, at tested parity. Image derivatives (thumbnails) are declared in the spec.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | none |
| Entitlement | — |
| Tables owned | `file_object` |
| Routes owned | none |
| Owned-code routes | `/api/upload`, `/files/:key` |
| DI bindings | `storage`, `imageTransformer` |
| Uninstall | not supported |

**No uninstall.** Uninstalling would orphan the bytes: every `file` field in the project stores a key this bundle’s registry is the only record of, and the spec vocabulary has no remove-entity op to unwind either the registry or the fields that point into it. Deleting the objects instead is exactly the automatic mass delete this feature refuses to offer — see the orphan report in `storage/objects.ts`, which is a report on purpose.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Let people upload a profile photo and show a 64px thumbnail in the members list. _(real-product: GitHub, Linear and Slack all store one avatar upload and render several sizes of it; none of them resize in the browser at render time.)_
- Attach a PDF to an invoice that only that invoice’s owner can download. _(real-product: Stripe invoice PDFs and Xero attachments are both fetched through a signed, expiring link rather than a public bucket URL.)_

### `jobs` — Scheduled work

Declared recurrence — a named schedule with an IANA timezone, a defined answer for "monthly on the 31st", and an identity every run carries — over a durable job runtime with retries, a dead-letter view and run history. Delivery is at-least-once and the handler is handed the idempotency key that makes a repeat a no-op. Domain logic lives in a generated handler slot the platform never overwrites, so "reorder the queue by an SM-2 grade" is code you own rather than an operator we invented.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth` |
| Entitlement | — |
| Tables owned | `job` |
| Routes owned | none |
| Owned-code routes | `/jobs` |
| DI bindings | `jobQueue`, `scheduler` |
| Uninstall | not supported |

**No uninstall.** The `job` table is the run history and, through `idempotency_key`, the record of which occurrences have already been claimed. Dropping it un-claims every one of them at once, so the next tick re-runs whatever the catch-up window still reaches — the exact duplicate-delivery failure the key exists to prevent. The op vocabulary has no drop-table op, and the operation people actually want is "stop this job", which is `schedules.pause`: reversible, per-schedule, and it keeps the history you need in order to turn it back on.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Issue the recurring invoices on the last day of every month, in the customer’s timezone — and not twice if the worker restarts. _(external-corpus: The `invoicer` benchmark’s frozen `ch-recurring-invoices` ask, which stood as off-surface/unexpressible from the 2026-07-26 corpus freeze until this bundle absorbed it.)_
- Our nightly export has been failing silently for a week — I want to see what died, why, and retry just those. _(real-product: Sidekiq’s Dead set and Oban’s "discarded" state both exist for exactly this: a retry budget that ends somewhere a human can see, with a per-job retry action rather than a re-run of everything.)_

### `webhooks` — Webhooks

Signed outbound delivery and verified inbound receivers, both directions over one signature scheme. Outbound: declared events delivered to subscriber endpoints, signed with a timestamp and a nonce, retried with backoff, with a delivery log — over URLs validated against every internal address range at subscribe time and again before each attempt. Payloads are scoped by a default-deny field projection, so adding a column to an entity cannot widen what an existing subscriber receives. Inbound: declared receivers whose signature check is unskippable by construction, with replay protection and a uniform 401 that tells an attacker nothing.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth`, `audit` |
| Entitlement | — |
| Tables owned | `webhook_subscription`, `webhook_delivery` |
| Routes owned | none |
| Owned-code routes | `/webhooks`, `/api/webhooks/:receiver` |
| DI bindings | `webhookService`, `webhookReceivers` |
| Uninstall | not supported |

**No uninstall.** The subscription table holds live signing secrets that third-party systems are configured against; dropping it silently stops every integration that depends on this app, with no signal on either side. The delivery log is also the evidence of what was sent to whom, which is the record a data-protection question is answered from. The op vocabulary has no drop-table op. The operation people want is "stop this subscription", which is `unsubscribe` — per-subscription, reversible by re-subscribing, and it keeps the log.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Notify our Zapier endpoint whenever an invoice is paid, and let us verify the request really came from you. _(real-product: Stripe, GitHub and Shopify all ship the same scheme: a shared secret, an HMAC over a signed payload that includes a timestamp, and a documented verification snippet — because a subscriber who cannot verify has to trust the source IP.)_
- Mark the subscription active when the payment provider calls us back — without opening a write endpoint anyone can POST to. _(issue-report: the gating clause ("inbound webhooks are an unauthenticated write path"), and the concrete need in the `billing` bundle, whose provider callbacks have no other way in.)_

### `observability` — Observability

Structured request logs with a correlating request id, error capture with a pluggable reporter, in-process rate limiting, and health / readiness endpoints wired to the runtime by default. Every log line and every captured error is redacted **by default** — declared-sensitive fields first, an over-eager name backstop under them, and query strings stripped entirely, because a password-reset link is a credential shaped like a path. The health endpoint answers reachable / not reachable and tells an unauthenticated caller nothing about internal topology.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | none |
| Entitlement | — |
| Tables owned | none |
| Routes owned | none |
| Owned-code routes | `/health` |
| DI bindings | `errorReporter`, `rateLimiter` |
| Uninstall | supported |

**Uninstall.** Contributes no schema and no data. Removing the install record and the `errorReporter` / `rateLimiter` bindings is the whole uninstall — but note what goes with them: the rate limiter is a real control, not only a diagnostic, so removing this bundle removes a defense as well as a signal.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- A customer says the app was slow at 14:20 — I want to find that exact request and see what it did. _(real-product: The request-id-per-request pattern every hosted platform ships (Heroku `X-Request-Id`, Cloudflare `cf-ray`, Vercel `x-vercel-id`) exists because correlating by timestamp alone stops working at any real traffic level.)_
- Our logs are shipped to a third-party vendor — make sure a password-reset link can never end up in one. _(issue-report: the gating clause ("observability must not leak PII into logs or traces by default"), and the concrete shape it takes here: signed file URLs and unsubscribe links are both credentials carried in a query string that a naive request log writes out verbatim.)_

### `compliance` — Data compliance

Export-my-data and delete-my-data **derived from the relation graph**, not hand-listed: a row two relation hops from the subject with no owner column of its own is still theirs, and the flow finds it. Every table carries a declared retention class, and an unclassified one makes both flows refuse to run rather than quietly skip it. Deletion goes in foreign-key order; a table on legal hold is pseudonymized rather than deleted. Versioned terms and cookie consent are recorded append-only, and a retention purge job clears soft-deleted rows.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth`, `audit` |
| Entitlement | — |
| Tables owned | `consent` |
| Routes owned | none |
| Owned-code routes | `/settings/export-data`, `/settings/consent` |
| DI bindings | `consentService`, `retentionPolicies` |
| Uninstall | not supported |

**No uninstall.** The consent table is the record of what each person agreed to and when — the lawful basis for processing that already happened. Dropping it does not undo the processing, it deletes the proof that it was permitted. Removing the bundle would also remove the export and erasure surfaces while the obligation to honor those requests continues, which is a worse position than never having offered them: the flows were advertised and are now silently absent.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- A user asked us to delete their account and everything attached to it — including the comments they left on other people’s posts. _(real-product: The GDPR Article 17 request every consumer product receives, and the specific shape that breaks a naive implementation: the comment rows carry a `postId`, not a `userId`, so an owner-column sweep misses them and reports success.)_
- Legal says the audit log has to survive a deletion request. Both things cannot be true — which is it? _(issue-report: the gating clause ("the audit log is append-only *by design* — the interaction with a deletion request needs a recorded decision, not an improvised one").)_

### `api-keys` — API keys

Programmatic access to the derived REST API and MCP endpoint: keys scoped per resource and action, hashed at rest and shown exactly once, rotatable and revocable immediately, with a per-key request budget and its own line in the audit log. A key can never do more than the person who issued it.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth` |
| Entitlement | — |
| Tables owned | `api_key`, `portal_token` |
| Routes owned | none |
| Owned-code routes | `/api-keys` |
| DI bindings | `apiKeyService` |
| Uninstall | not supported |

**No uninstall.** Uninstalling would leave a table of live credentials behind that nothing in the project manages any more — the op vocabulary has no drop-table op, and removing the management page while the bearer-token path stays mounted is the worst of both. The operation people actually want is "stop all programmatic access", which is revoking every key: that is reversible, visible in the audit log, and already supported.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Give our data team a key that can read orders and nothing else, and show me when it was last used. _(real-product: Stripe restricted keys and GitHub fine-grained PATs both scope per resource with read/write granularity and surface a last-used timestamp in the key list.)_
- A key got committed to a public repo — rotate it and make sure the old one stops working right away. _(real-product: GitHub secret scanning’s documented remediation is rotate-then-revoke; Stripe’s dashboard offers "roll key" with an immediate-expiry option for exactly this incident.)_

### `flags` — Feature flags

Declared feature flags with server-side targeting by role, organization, or a stable percentage rollout. The declaration lives in the spec, so a flagged page or block is visible in the workbench instead of buried in code — and generation never reads a flag’s value, so a gated surface cannot break determinism. Flag age, last use, and what each flag still gates are reported, and removal is a first-class op.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth` |
| Entitlement | — |
| Tables owned | `flag_evaluation` |
| Routes owned | none |
| Owned-code routes | none |
| DI bindings | `flagService` |
| Uninstall | supported |

**Uninstall.** Removing the bundle drops the telemetry table and the `flagService` binding. Declared flags are spec data and survive; ungate the surfaces (`flags.gate {flag: null}`) and remove the declarations (`flags.remove`) first, or every gated page stays hidden — an unevaluated gate reads as off, which is the safe direction but not a working app.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Put the new checkout behind a flag, turn it on for our own staff, then ramp it to 10% of customers. _(real-product: LaunchDarkly and Flagsmith both lead their docs with the same three steps — internal-only, then a percentage ramp on a stable bucket, then full release.)_
- Which flags are still on in production but nothing checks any more? _(real-product: GitHub’s and Slack’s published flag-cleanup practice both key on the same two signals: age since declaration and time since last evaluation.)_

### `members` — Organizations & members

Multi-tenant org model: organizations, members (with roles), and invitations, plus an organizations admin page. Members reference auth’s `user`, so it depends on the auth bundle.

| | |
| --- | --- |
| Version | `0.2.0` (first shipped `0.1.0`) |
| Prerequisites | `auth` |
| Entitlement | — |
| Tables owned | `organization`, `member`, `invitation` |
| Routes owned | `/organizations` |
| Owned-code routes | none |
| DI bindings | `memberService`, `auditSink` |
| Uninstall | not supported |

**No uninstall.** Tenancy is referenced by everything scoped to an organization once it is installed, and the spec vocabulary has no remove-entity op, so an uninstall could not unwind the schema it contributed. Tracked for the catalog-wide uninstall story.

**Upgrade path.**

| From | To | Migration |
| --- | --- | --- |
| `0.1.0` | `0.2.0` | Declare the organization foreign keys. 0.1.0 modelled `member.organizationId`, `member.userId` and `invitation.organizationId` as bare strings, so the platform could not resolve them to a name, could not see the relation in the graph, and could not roll anything up through them. This declares what was already true of the data. The organization columns change type (`text` → `uuid`) when the schema is next synced; the migration does that behind a guard and fails loudly if a row holds something that is not an id — which would mean the column was never really a foreign key. |

**Eval asks.** The change asks this bundle is measured with:

- Show each organization’s member count on the organizations table. _(real-product: GitHub’s organization list and Linear’s workspace switcher both show a member count next to the org name.)_
- Expire invitations after seven days and mark the stale ones in the list. _(real-product: Slack workspace invites expire; better-auth’s organization plugin carries `invitation.expiresAt` for exactly this.)_

### `preferences` — Preferences

Typed per-user and per-organization settings, declared once and resolved user → organization → default. The settings UI is derived from the declarations rather than hand-built beside them, so adding a preference is one entry instead of a column, a form field, a loader and an action. Reads are cached per scope, so settings do not cost a query on every page.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth`, `members` |
| Entitlement | — |
| Tables owned | `user_preference`, `organization_preference` |
| Routes owned | none |
| Owned-code routes | `/settings` |
| DI bindings | `preferencesService` |
| Uninstall | not supported |

**No uninstall.** The tables hold choices people made — notification opt-outs among them. The op vocabulary has no drop-table op, and removing the settings page while `NotificationService` still reads the channel preferences would leave users emailed by a system they can no longer opt out of. The operation people actually want is "stop offering a preference", which is removing its declaration: the stored rows stop resolving, the field leaves the derived form, and nothing is silently re-enabled.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Default everyone in the org to the weekly digest, but let people switch themselves to daily. _(real-product: Linear and Notion both ship workspace notification defaults that a member can override per account, with the workspace value shown as the inherited one.)_
- Add a "mention emails" toggle to account settings. _(dogfood: The old settings page in apps/web: the same three facts were written in four places (column, form input, loader mapping, action mapping), which is what made this the promotion’s first ask.)_

### `notifications` — Notifications

Declared notification types with an opt-out each, an in-app inbox, and digest or immediate email over the email bundle. How loud a message is comes from its declaration and the recipient’s preference, never from the call site: activity defaults to the digest, product news is opt-in, and only transactional mail goes out immediately. Delivery is idempotent — a redelivered event cannot become a second email — and content is filtered against the recipient’s read access at send time, in the digest as well as in the inbox.

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth`, `email`, `preferences` |
| Entitlement | — |
| Tables owned | `notification`, `notification_digest` |
| Routes owned | none |
| Owned-code routes | `/notifications`, `/unsubscribe` |
| DI bindings | `notificationService` |
| Uninstall | not supported |

**No uninstall.** The delivery table is the record of what was already sent, and its `dedupe_key` rows are what stop a redelivery becoming a second email — dropping it re-opens every suppressed duplicate at once. The op vocabulary has no drop-table op, and removing the inbox while other code still calls `notify()` would leave notifications with nowhere to land. The operation people actually want is "stop sending me this", which is a preference: it is per-type, reversible, and already the unsubscribe link’s job.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Stop emailing me on every comment — send me one summary a day instead, but keep security alerts immediate. _(real-product: GitHub, Linear and Jira all ship exactly this split: a per-type delivery choice with a digest option, and a security/account class that is excluded from it.)_
- Our worker retried after a timeout and everyone got the same email twice — make that impossible. _(issue-report: the gating clause ("delivery is at-least-once … a duplicate must never produce a duplicate email"), which is the failure the jobs primitive in `features/jobs` produces by design: it retries with backoff and cannot know whether the handler’s send got out.)_

### `billing` — Billing & entitlements

Stripe-hosted subscriptions (buy — decision d-billing-buy) plus the `hasEntitlement` primitive and usage metering. Contributes the `subscription` mirror table (kept in sync from Stripe webhooks) and a `usage_event` ledger (the source metered quota checks read), with subscriptions + usage admin pages; exposes `billing` (the hosted-checkout provider), `entitlements`, and `metering` bindings. Subjects are auth users, so it depends on the auth bundle.

| | |
| --- | --- |
| Version | `0.4.0` (first shipped `0.1.0`) |
| Prerequisites | `auth` |
| Entitlement | — |
| Tables owned | `subscription`, `usage_event` |
| Routes owned | `/subscriptions`, `/usage` |
| Owned-code routes | none |
| DI bindings | `billing`, `entitlements`, `metering` |
| Uninstall | not supported |

**No uninstall.** The `subscription` mirror is the source `hasEntitlement` reads, and the `usage_event` ledger is a financial record. Deleting either from a live app silently un-gates paid features and destroys billing history; the safe removal is to stop syncing from Stripe, which is a wiring change.

**Upgrade path.**

| From | To | Migration |
| --- | --- | --- |
| `0.1.0` | `0.2.0` | Add the `currentPeriodEnd` date field to the `subscription` mirror (0.1.0 tracked only status; 0.2.0 records when the period ends). |
| `0.3.0` | `0.4.0` | Declare both `subject` columns OPEN over `e-user` and `e-organization` . 0.3.0 shipped them as bare strings with the loss recorded as a "cannot": the billing subject is a user in a per-seat app and an organization in a per-workspace one, and a reference names exactly one. The candidates are the catalog’s to declare and the choice is the project’s — narrow with `data.setFieldReference`. Idempotent, and a no-op on a field a project has already narrowed. The emitted column is unchanged (`text` either way), so this needs no data migration. |
| `0.2.0` | `0.3.0` | Materialize the `usage_event` ledger the metered quota check totals over, and the `/usage` admin page that reads it (0.2.0 mirrored subscriptions only; 0.3.0 adds usage metering). Idempotent: a spec that already has the entity and the page is left untouched. The page half was missing at first — an upgraded 0.3.0 project had the ledger table and no way to look at it, which is a state neither version recognizes. |

**Eval asks.** The change asks this bundle is measured with:

- Show this month’s usage per subject against the plan’s allowance. _(real-product: Stripe Billing meters: the usage-vs-included-quantity view is the default screen for a metered plan.)_
- Warn a user in-app while their subscription is past_due. _(real-product: Stripe smart-retries dunning; Vercel and Linear both surface an in-app payment-failed banner rather than only emailing.)_

### `admin` — Admin metrics

The admin metrics dashboard — user/system aggregations and registration trends over the auth and audit tables. Exposes the `metrics` binding. Gated by the `analytics` entitlement: the dashboard activates at runtime only for subjects whose plan grants it (see the billing bundle).

| | |
| --- | --- |
| Version | `0.1.0` (first shipped `0.1.0`) |
| Prerequisites | `auth`, `audit` |
| Entitlement | `analytics` |
| Tables owned | none |
| Routes owned | none |
| Owned-code routes | none |
| DI bindings | `metrics` |
| Uninstall | supported |

**Uninstall.** Read-only aggregations over tables other bundles own: removing the install record and the `metrics` binding removes the dashboard and nothing else. No data is lost.

**Upgrade path.**

Still at its first release (`0.1.0`) — nothing to migrate.

**Eval asks.** The change asks this bundle is measured with:

- Chart registrations per day for the last thirty days on the dashboard. _(real-product: Plausible and PostHog both lead their default dashboard with a 30-day daily-count chart.)_
