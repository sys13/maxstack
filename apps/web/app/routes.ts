import {
	index,
	prefix,
	type RouteConfig,
	route,
} from '@react-router/dev/routes'

export default [
	index('routes/home.tsx'),

	// Health check (task 61): pings the store backend, 200/503 JSON. Static,
	// so it wins over the project catch-all below — no auth, no UI, the shape
	// a load balancer / orchestrator expects.
	route('health', 'routes/health.ts'),

	// The review-first workbench: suggest→accept queue, spec zoom, decision
	// ledger, all driven off the spec's provenance flags (§3-L4B, Phase 5).
	route('workbench', 'routes/workbench.tsx'),

	// JSON-RPC MCP transport — the same Sprout tools the admin UI drives, over
	// the wire for agents (§3-L2, sprout.md §6).
	route('mcp', 'routes/mcp.ts'),

	// Framework-agnostic REST handlers wrapped as RR7 resource routes.
	...prefix('api', [
		// better-auth owns everything under /api/auth/* (sign-in/up, session,
		// callbacks). Static `auth` segment ranks above the `:resource` catch.
		route('auth/*', 'routes/api.auth.$.tsx'),
		// File/image uploads (task 60), behind the task-39 upload components.
		// Static, so it wins over the `:resource` catch below.
		route('upload', 'routes/api.upload.tsx'),
		// Inbound webhook receivers. Static `webhooks` segment, so it
		// ranks above the `:resource` catch below — otherwise an inbound delivery
		// would be routed as a REST write against a resource named "webhooks",
		// which is an unauthenticated write path by accident rather than by
		// design.
		route('webhooks/:receiver', 'routes/api.webhooks.$receiver.tsx'),
		// `GET /api/live/:key` — a declared live channel as Server-Sent Events, and
		// `?poll=1` for the fallback served by the same route through the same op
		//. Static `live` segment, so it ranks above the `:resource`
		// catch below — otherwise `/api/live/board` would be routed as a REST read
		// of a resource named "live", which is a 404 that looks like a bug.
		//
		// The route module contains no filtering, no column selection and no access
		// check; a test asserts it does not import the store. Everything is enforced
		// in the permission layer and the ops, per message.
		route('live/:key', 'routes/api.live.$key.tsx'),
		route(':resource', 'routes/api.resource.tsx'),
		// `GET /api/:resource/count` — the list query's cardinality. Static
		// `count` segment, so it ranks above the `:resource/:id` catch below;
		// without it `/api/task/count` fell through as a row id.
		route(':resource/count', 'routes/api.resource.count.tsx'),
		// `GET /api/:resource/search?q=` — ranked full-text search.
		// Static `search` segment for the same reason `count` is one: otherwise
		// `/api/task/search` falls through as `opGet('search')`.
		route(':resource/search', 'routes/api.resource.search.tsx'),
		route(':resource/:id', 'routes/api.resource.$id.tsx'),
		// `POST /api/:resource/:id/restore` — undo a soft delete.
		route(':resource/:id/restore', 'routes/api.resource.$id.restore.tsx'),
	]),

	// `GET /documents/:key/:id.html|.pdf` — a declared document rendered for one
	// row. Static `documents` prefix, so it wins over the project
	// catch-all; the format is the extension rather than a query parameter, so a
	// saved file is named after the document and not after the route segment.
	route('documents/:key/:id', 'routes/documents.$key.$id.tsx'),

	// `/p/:key` and `/p/:key/:id` — declared public/token/role-scoped surfaces
	//. A static `p` prefix ahead of the project catch-all, for the
	// reason `documents` and `imports` are static: a project page named "p" would
	// otherwise shadow every public surface in the app. Short on purpose — these
	// URLs get pasted into emails and printed on invoices.
	//
	// Both route modules contain no filtering, no column selection and no access
	// check; a test asserts neither imports the store. Everything is enforced in
	// the permission layer and the ops.
	route('p/:key', 'routes/p.$key.tsx'),
	route('p/:key/:id', 'routes/p.$key.$id.tsx'),

	// `/imports/:key` — a declared importer's upload → dry-run → confirm surface
	//. Static `imports` prefix for the same reason `documents` is
	// one: it has to win over the project catch-all, or a project page named
	// "imports" would shadow the one route in the app that can overwrite rows in
	// bulk. The confirm re-plans server-side rather than trusting a plan the
	// client sends back.
	route('imports/:key', 'routes/imports.$key.tsx'),

	// Local-disk blob delivery for `api/upload` (task 60) — a signed, expiring
	// URL that streams the bytes back. Only reachable when local disk is the
	// active storage provider (an S3-backed deploy points signed URLs
	// straight at the bucket/CDN instead). Static, so it wins over the project catch-all.
	route('files/:key', 'routes/files.$key.tsx'),

	// The admin metrics dashboard (the `admin` bundle): aggregations over the
	// auth + audit tables. Static, so it ranks above the project catch below.
	route('metrics', 'routes/metrics.tsx'),

	// Team settings: an owned-code page wrapping the extracted `MemberService`
	// (roles, last-owner guard, invitations). Static, so it wins over the project catch-all.
	route('team', 'routes/team.tsx'),

	// Billing & usage: an owned-code page over the billing feature (plans +
	// entitlements, Stripe hosted checkout/portal, usage metering + quota walls).
	// Static, so it wins over the project catch-all.
	route('billing', 'routes/billing.tsx'),

	// Usage-CSV download (task 54, entitlement + flag gated) — a plain-GET
	// resource route so the browser handles it as a file download, not data
	// `useActionData` reads as JSON.
	route('billing/export-csv', 'routes/billing.export-csv.tsx'),

	// Sign in / sign up: the user-facing auth surface over the
	// already-live better-auth server instance — signs a session cookie and
	// redirects home. Static, so it wins over the project catch-all.
	route('login', 'routes/login.tsx'),

	// Account settings: an owned-code page over auth (task 50) — profile,
	// password, sessions/devices, notification prefs, danger zone. Static, so
	// it wins over the project catch-all.
	route('settings', 'routes/settings.tsx'),

	// GDPR data export — a plain-GET download, same reasoning as
	// `billing/export-csv` above. Static, so it wins over the project catch-all.
	route('settings/export-data', 'routes/settings.export-data.tsx'),

	// Consent recording — the cookie-consent banner (mounted at the
	// root layout, every page) POSTs here; a plain resource action, not
	// `settings.tsx`'s. Static, so it wins over the project catch-all.
	route('settings/consent', 'routes/settings.consent.tsx'),

	// Notifications inbox (task 56): in-app + transactional/digest email over
	// NotificationService, gated by the settings page's channel prefs. Static,
	// so it wins over the project catch-all.
	route('notifications', 'routes/notifications.tsx'),

	// One-click unsubscribe — the target of every opt-out-able
	// email's footer. No session required by design; the signed token is the
	// authorization. Static, so it wins over the project catch-all.
	route('unsubscribe', 'routes/unsubscribe.tsx'),

	// API keys (task 57): issue/rotate/revoke scoped personal access tokens
	// over the REST surface, + generated docs. Static, so they win over the project catch-all.
	route('api-keys', 'routes/api-keys.tsx'),
	route('api-docs', 'routes/api-docs.tsx'),

	// Webhooks (task 58): outbound event-bus subscriptions over every
	// create/update/delete, signed + retried + logged. Static, so it wins
	// over the project catch-all.
	route('webhooks', 'routes/webhooks.tsx'),

	// Background jobs (task 59): the queue webhook delivery (above) enqueues
	// onto, plus a server-side bulk CSV export — status/retry visibility for
	// both. Static, so it wins over the project catch-all.
	route('jobs', 'routes/jobs.tsx'),

	// The first-run setup wizard: workspace → invite → demo data.
	// Static, so it wins over the project catch-all.
	route('onboarding', 'routes/onboarding.tsx'),

	// "Load demo data" — the onboarding wizard's / empty-state's
	// CTA posts here, then redirects back. Static, so it wins over the project catch-all.
	route('onboarding/seed', 'routes/onboarding.seed.tsx'),

	// Its mirror (closes #101): remove exactly the rows a seed
	// created. `maxstack demo --clear` and the in-app demo notice both post here.
	route('onboarding/clear', 'routes/onboarding.clear.tsx'),

	// The generic admin: one CRUD surface derived from the registry. Only the
	// statically-addressed surfaces are children of the layout — `/admin` itself
	// and the read-only spec views (the product brief, the page/UX layer and the
	// pricing tiers all live in the same `SpecSystem` as the data entities but
	// have no CRUD resource).
	route('admin', 'routes/admin.tsx', [
		index('routes/admin.home.tsx'),
		route('spec/product', 'routes/admin.spec.product.tsx'),
		route('spec/pages', 'routes/admin.spec.pages.tsx'),
		route('spec/pricing', 'routes/admin.spec.pricing.tsx'),
	]),

	// Everything else under `/admin`. This used to be four dynamic
	// children of the layout above — `:resource`, `:resource/new`,
	// `:resource/trash`, `:resource/:id` — and a dynamic segment outranks the
	// project splat at the bottom of this file, so `/admin` did not merely rank
	// above that splat, it swallowed the entire namespace below it: a spec page
	// declared at `/admin/posts` was routed as the generic CRUD for a resource
	// named `posts`, missed the registry (the entity is `post`) and 404'd, and
	// `/admin/posts/new` collided with `:resource/:id` the same way.
	//
	// The patterns cannot be widened — `/admin/posts` and `/admin/post/42` are
	// the same shape, and only the spec knows which is which — so this is #251's
	// shape one level out: one splat that resolves the path after the spec is
	// loaded, asking the spec first (a declared page beats an interpretation of
	// one) and reading the remainder as the generic admin otherwise.
	//
	// A sibling of the layout rather than a child of it, so a spec page served
	// under `/admin` renders in its own frame instead of inside the platform's
	// admin chrome; `routes/admin.$.tsx` explains that call. The static children
	// above still outrank it, as do `/admin`'s own index and the spec views.
	route('admin/*', 'routes/admin.$.tsx'),

	// Runtime-composed project pages (§3-L2, task 21): every accepted spec page
	// is a real navigable route, resolved to a Sprout resource per request by
	// `getRoutes(spec)`.
	//
	// One splat rather than the four patterns this used to be (`:page`,
	// `:page/new`, `:page/parse`, `:page/:id`), because a page declares its own
	// URL and that URL can be more than one segment: each of those patterns binds
	// exactly one segment to the page, so a page declared at `/app/decks` matched
	// `:page/:id` as page `app` + record `decks` and 404'd. Widening
	// them is not possible — `/app/decks` and `/decks/42` are the same shape, and
	// only the spec knows which is which — so the split is decided inside the
	// module, after the spec is loaded.
	//
	// A splat ranks below every static route above it, so `/admin`, `/workbench`,
	// `/mcp`, `/api/*` and `/health` still win.
	route('*', 'routes/project.$.tsx'),
] satisfies RouteConfig
