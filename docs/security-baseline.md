# Security baseline

The minimum security control set for the monorepo and everything it
generates, and how it is enforced. The premise: most code here is written or
edited by agents, so safety checks must be automated and routine, not
best-effort.

## Check tiers

| Tier | When | What |
| --- | --- | --- |
| PR (`ci.yml`: `security`, `smoke`) | every PR + push to main | prod dependency audit (fails on high+), browser smoke over critical flows against the production build |
| Nightly (`nightly-safety.yml`) | daily + on demand | full dependency audit (all deps, JSON report artifact), full validate gate, full smoke suite — artifacts published for trend review |

## Baseline controls

1. **Dependency vulnerability scan.** `pnpm audit --prod --audit-level=high`
   blocks merges; the nightly runs the unfiltered audit and publishes the
   JSON report so severity trends are reviewable over time.
2. **Authz coverage for protected paths.** Critical-path tests that must
   always exist and pass:
   - `apps/web/e2e/smoke.spec.ts` — bad credentials are rejected with no
     session cookie; anonymous session lookup returns no principal.
   - `apps/web/app/routes/login.test.ts` — bad credentials → 401, no cookie.
   - REST writes: `requireWriteAuth` / `isAnonymousWrite`
     (`apps/web/app/sprout.server.ts`) rejects anonymous writes (401) when
     the auth bundle is installed; covered by the from-spec suite
     (`AUTHENTICATED_WRITES`).
3. **Input validation on high-risk endpoints.** Spec-driven zod schemas
   validate REST/MCP writes; form routes use Conform + zod. New endpoints
   must not accept unvalidated bodies.
4. **Session/CSRF posture.** Auth is delegated to better-auth (cookie
   sessions, CSRF protection on its endpoints, rate limiting). Do not
   hand-roll session handling next to it.
5. **Credentials for programmatic access.** API keys (
   [`api-keys.md`](api-keys.md)) are stored as a SHA-256 hash and shown once;
   nothing in the product can re-display an issued key. Their scope is
   enforced in `authorize()` / `canPerformAction()` in the permission layer,
   *not* at the route — a route-level gate is unsound here because MCP and
   the admin loaders reach the ops layer without passing one. Two invariants
   have named tests in `packages/maxstack-core/src/sprout/permissions.test.ts`:
   a key can never exceed its holder's own permissions, and a key is closed by
   default on any resource its scope does not name even when that resource has
   no access rule. A new surface that authorizes by hand rather than through
   the permission layer bypasses both.

6. **Outbound request forgery (SSRF).** Any feature that fetches a
   user-supplied URL goes through `assertPublicUrl`
   (`packages/features/src/webhooks/ssrf.ts`), which is
   default-deny: https only, no embedded credentials, a narrow port
   allowlist, and every loopback / link-local / RFC1918 / CGNAT range —
   including the decimal, octal, hex and IPv4-mapped-IPv6 spellings, which is
   how this check is normally bypassed. It runs **twice**: at subscribe time
   (so a refusal reaches the form with a reason) and immediately before every
   delivery attempt (the DNS-rebinding case). Redirects are never followed —
   a 302 to an internal address is the cheapest way around all of it.
   Covered by `webhooks/ssrf.test.ts`, organized by bypass rather than by
   range.
7. **Unauthenticated write paths are declared, never incidental.** Inbound
   webhook receivers (`webhooks/inbound.ts`) are the only sanctioned one.
   Signature verification is mandatory **by construction**: the declaration
   type has no `verify: false`, no optional secret, and a secret shorter than
   32 characters is refused at boot rather than at the first delivery. Replay
   protection is a signed timestamp (±5 min, symmetric) plus a nonce, and the
   signature is verified *before* the nonce is claimed so an unauthenticated
   caller cannot pre-burn a nonce a genuine delivery will use. Every failure —
   bad signature, unknown receiver, stale timestamp, replay — returns an
   identical bare 401: a receiver that distinguishes them is an oracle.
   A receiver produces *intent* (`ReceiverWrite[]`), which the caller applies
   through the same validated write path a form uses; it never writes rows.
8. **Third-party data egress is scoped by declared projection.** Webhook
   payloads carry the fields a subscription named and nothing else
   (`webhooks/projection.ts`), so adding a column to an entity cannot widen an
   existing subscription — the failure mode where a new `internalNotes` field
   silently starts reaching every subscriber configured a year ago. A
   secret-shaped field name (`*password*`, `*token*`, `*secret*`, `*apiKey*`,
   …) is refused at declaration and dropped again at delivery.
9. **A committed spec may never contain a credential.** Declared external data
   sources ([`external-sources.md`](external-sources.md)) reference
   a credential **by name** (`auth: {kind: "bearer", secretName:
   "MAILBOX_TOKEN"}`); the value is read from the deployment's secret store at
   request time and never returned, logged, or attached to an error. This is
   enforced at validate time (`secretLeakErrors`), not by convention, because a
   spec is committed, diffed, rendered in the workbench and passed to agents —
   one leak is every leak, and it cannot be undone. The check refuses
   credential-bearing header and query-parameter *names* outright (not merely
   their values): a value scan clever enough to recognize every credential
   format will one day meet a format it does not know. It also refuses known
   credential shapes (Bearer/Basic, `sk-`, `ghp_`, `AKIA`, `xox`, `AIza`, JWTs,
   PEM private keys), any ≥32-character mixed-class opaque run, credentials in
   the URL, and a `secretName` that is not env-var shaped. A refusal never
   echoes the rejected string back. Covered by `spec-ops.test.ts` and
   `sources.test.ts`.
10. **Every outbound source request is SSRF-checked twice, and never
   redirected.** Declaration time is pure (`sourceUrlErrors` — https, no
   credentials, ports 443/8443, no internal-address literal in any spelling),
   so it can run inside `validateOp`. Request time adds what a pure check
   cannot: the declared URL's origin **is** the allowlist, `assertPublicUrl`
   (control 6) resolves the host immediately before the request, and a 3xx is a
   failed request rather than a hop. Response size is capped at 2 MiB on both
   the declared `content-length` and the bytes read. The two host checks are
   separate functions (package-graph direction) pinned to one answer by
   `sources/ssrf.agreement.test.ts`.
11. **A third-party value is written through the app's own validated path.** A
   source run produces `SourceWrite[]` *intent*; the host applies it through
   the same path a form posts to, so the column's zod schema, the entity's
   limits and the op log all apply. The user-owned refiner slot is an extension
   point and not a bypass: its return value is re-coerced against the entity's
   declared types. Generation never makes a network call, asserted by stubbing
   `globalThis.fetch` to throw and generating anyway
   (`apps/maxstack/src/lib/source-determinism.test.ts`).
12. **Constant-time comparison for every shared-secret check.**
   `timingSafeEqualHex` (`webhooks/signing.ts`) reads every character
   regardless of where the first difference is. A `===` on a hex digest leaks,
   through timing, how many leading characters of a guess were right, which
   turns forging a signature into a few thousand requests per character. The
   non-short-circuiting property has its own test.

13. **Public surfaces are declared, projected per field, and enforced below the
   routes.** A declared portal ([`portals.md`](portals.md)) is the
   only way anything derived is reachable without a session, and every rule about
   it lives in the permission layer and the read/write ops — *never* in a route,
   because MCP and the admin loaders reach the ops layer without passing one
   (control 5's finding, applied to a much larger blast radius). The route
   modules under `apps/web/app/routes/p.$key*.tsx` contain no filtering, no
   column selection and no access check, and a test asserts they do not import
   the store.

   The non-negotiables, each with a test named after the exposure it prevents
   (`packages/maxstack-core/src/sprout/portals.test.ts`,
   `packages/spec/src/base/portals.test.ts`):

   - **Default deny.** `portalGrants` denies every resource but the portal's own
     and every action it did not declare, *including resources with no access
     rule at all* — the deliberate exception to this codebase's open-by-default
     evaluator, so "the entity had no rule yet" is never how the internet reaches
     a new table. `delete` is never grantable, by any spelling. A portal identity
     also does not satisfy the `'authenticated'` shortcut: a synthetic user built
     for a public URL is truthy, and no rule written as "authenticated" ever meant
     "or anybody who followed a link".
   - **Projection is opt-in per field, with no "all except".** An exclusion list
     silently exposes every column added after it was written. `projectForPortal`
     rebuilds each row from the declared list plus the primary key and drops
     everything else — including derived values attached after the
     store, the soft-delete column and the tenant column.
   - **No unbounded collection, and no guessable row.** A collection portal must
     declare a filter, forced after any caller filter and server-stamped on
     create; a row portal must be token-scoped, because a row id in a public URL
     is a credential that cannot be revoked.
   - **No anonymous update.** Refused at validate time for a `public` audience.
     An unauthenticated `create` is allowed under a required hourly budget capped
     at 600/hour.
   - **No undeclared-column ordering or filtering.** Refused rather than ignored:
     ordering by a hidden column is a comparison oracle that reconstructs it a
     few paged requests at a time. Ranked search is refused outright
     for a portal identity — `to_tsquery` and `ts_rank` both run over the whole
     tsvector, so projecting the rows would leave the match and the ordering as
     oracles over columns the portal cannot read.
   - **A payload naming an undeclared field is refused, not stripped.** Silent
     stripping tells the caller their value landed when it did not.
   - **Every portal write passes the limiter, at the declared rate, inside
     `opCreate`/`opUpdate`.** A context with no limiter wired **refuses** portal
     writes rather than allowing unbudgeted ones.

   Exposure is reviewable as data: `portalExposureReport` (declaration-derived,
   so it cannot drift from enforcement) is printed as a table by
   `maxstack validate`, rendered by the workbench `PortalsPane`, and returned by
   the MCP `portal_exposure_report` tool. `apps/web/app/portals.agreement.test.ts`
   pins the report to reality — it runs the real ops against a real database and
   asserts a returned row's key set equals exactly the fields the report lists.
   A deliberate-exposure suite constructs a portal misdeclared in each dangerous
   way (public update, file field, undeclared-column `orderBy`, cross-resource
   read, a resource with no access rules, a row token pointed at another row) and
   asserts each is refused.
14. **Portal tokens expire and are revocable from day one.** Opaque 32-byte
   CSPRNG values, stored as a SHA-256 hash only and returned once at mint
   (`packages/features/src/api-keys/portal-token.ts`, in the api-keys bundle
   because a portal token *is* a scoped expiring credential and the catalog is at
   its 16-bundle cap). `ttlHours` is required by the declaration and bounded to a
   year — there is no non-expiring portal token and no default that produces one.
   `verify` re-reads the row on every call and refuses on revocation, expiry and
   use cap, returning `null` indistinguishably for all three and for an unknown
   hash. Mint and revoke are audited under the new `origin: 'portal'`.
   **There is no MCP tool that mints one**, deliberately: a minted token is a
   bearer credential in plaintext, and a transcript cannot be revoked.

## Security delta

Work that touches auth, session handling, REST/MCP write paths, file
upload/serving, or dependency manifests must state its security delta in the
issue and the commit message — or explicitly state "no security delta". The
point was never the file it was written in; it is that touching these paths
silently is not an option.

## Triage / escalation policy

- **Red PR-tier `security` (audit)**: upgrade the dependency, or if no fix is
  released, record the advisory id + affected path in an issue and pin an
  override — never `--audit-level`-bump or ignore-list as a drive-by
  (the test-integrity policy applies to gates).
- **Red PR-tier `smoke`**: a critical flow broke in the production build.
  Treat as merge-blocking; the Playwright HTML report + traces are uploaded
  as artifacts on failure.
- **Red nightly**: file an issue same day with the artifact attached; a
  nightly-only failure means PR-tier coverage has a gap — extend the PR tier
  as part of the fix.

## Known gaps (tracked, not hidden)

- Dev default `BETTER_AUTH_SECRET` is low-entropy (better-auth warns at
  boot); deploys must set a real secret — `maxstack deploy` posture warnings
  cover the generated apps, the monorepo's own deploy docs cover
  apps/web.
- Response security headers (CSP, HSTS, frame-ancestors) are not yet set by
  the runtime server; owner: deploy workstream.
- **Rate limiting used to be per process, so a multi-instance deployment
  multiplied every budget by the instance count** —
  **now closed**. A declared 600/hour across four instances was 2,400/hour
  in practice, and the callers a portal budget bounds are anonymous ones, so the
  multiplier was most consequential exactly where the declaration was most
  load-bearing.

  Buckets now live in the `Coordinator` — a row per bucket in
  `maxstack_rate_bucket`, taken with one atomic `INSERT … ON CONFLICT DO UPDATE`
  so concurrent takers on the same bucket serialize. Which coordinator a
  deployment gets is decided by the store backend and nothing else: Postgres
  gets the shared one, pglite gets the in-process one, and on pglite a second
  instance cannot exist. There is
  deliberately no flag, because a flag is how a Postgres deployment runs
  un-coordinated by accident.

  Two things an operator should know. The mode is **logged at boot** —
  `RateLimiter.describe()` — because the silence was the reportable half of
  A declaration that says a number while the deployment delivers a
  multiple of it is only defensible when somebody chose it. And bucket rows are
  **swept** after four hours idle: an idle bucket is a full bucket and deleting
  it changes no verdict, but without the sweep the table would grow one row per
  distinct caller forever, which is an unbounded table where the old bug was a
  bounded memory leak.

  Proven under `MAXSTACK_TEST_POSTGRES_URL` only — two instances is the whole
  subject and pglite cannot have two. CI's `validate` job runs a Postgres
  service container so this is exercised on every PR rather than skipped into a
  green board.
- **A public portal's rate-limit bucket used to be keyed on an unverified
  forwarding header** — **closed**. `clientIdOf` read
  `x-forwarded-for`'s leftmost entry unconditionally, which is the part a caller
  fully controls: nothing required a proxy to overwrite it and nothing checked
  that one had, so rotating the header minted unbounded buckets and the declared
  budget was enforced per fabricated address.

  The trust is now declared. `MAXSTACK_TRUSTED_PROXY_HOPS` is the number of
  proxies in front of the deployment; unset means the header is ignored and every
  anonymous caller shares one bucket, and set to N means the entry N from the
  **right** — what the outermost trusted hop actually observed. The default is the
  strict direction and it costs something worth stating: with one shared bucket,
  one abusive caller can exhaust the anonymous budget for everybody. That is a
  bounded failure an operator fixes with one environment variable, against an
  unbounded one nobody could see.

  Behind CGNAT a bucket is still shared with strangers, and it still grants no
  access; the portal's own hourly ceiling remains the actual bound.
- **Webhook replay nonces are in-memory and per process**, the
  same shape of gap: with several receiver processes a replay can land on a
  process that has not seen the nonce. The signed-timestamp window still bounds
  it to five minutes. `NonceStore` is the seam for a shared implementation.
- **The DNS-rebinding window is narrowed, not closed.** `assertPublicUrl`
  resolves the host and checks every answer immediately before the delivery,
  but between that resolution and the connection the HTTP client makes, the
  answer can change. Closing it completely means pinning the resolved address
  into the socket, which is an agent-level concern in the host runtime.
