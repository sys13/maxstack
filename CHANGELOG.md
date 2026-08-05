# Changelog

All notable changes to `maxstack` and `maxstack-runtime` (they ship in
lockstep). Generated from the commit history at release time by
`scripts/stage-npm.ts`.

Entries up to and including 0.11.11 were written before this repository was
made public, so they carry no commit links — the commits they describe are not
in this repository's history. The releases themselves are on npm.

## 0.11.10 — 2026-08-05

### Features
- **spec,web:** edit a list cell in place, through the form's write path
- **mcp:** answer a joined question in one call, over declared references
- **release:** publish from CI with npm trusted publishing
- **ui:** render the inverse references a detail page already declares

### Fixes
- **init:** pin drizzle-orm tree-wide so a reinstall can't prune the runtime
- **web:** the cookie banner is a config question, never a store question
- **release:** don't run the half-release alarm when the guard failed
- **mcp:** make the generated app's tool surface fixed-size
- **sprout:** make a spec `date` normalize a zoned value instead of letting it move
- **checks:** stop a fresh scaffold failing its own gate, and make every remedy runnable
- **runtime:** carry the entity's name to the copy that names a row
- **spec,mcp:** refuse a bad inline block at the page that declared it
- **web:** hide the describe-prefill panel when no AI provider is configured
- **mcp:** stop advertising the arg-schema paths that no host will return
- **deps:** override brace-expansion past GHSA-rgw5-rvv9-x895
- **mcp:** query_spec ops takes a filter, so arg schemas are reachable
- **ui:** the empty-state CTA names the entity, not the page

### Performance
- **ci:** shard the validate test phase across four runners

### Other changes
- more

_7 internal changes._

## 0.11.9 — 2026-08-04

### Features
- **ui,web:** close the three generated-surface gaps found dogfooding
- **cli,web:** name ANTHROPIC_API_KEY where the user can act on it
- add init mcp
- **ui:** the two status colours the theme could not name
- **web:** describe-to-prefill on edit forms, admin forms, by voice, and for references
- **ui:** the layout and feedback primitives the app surfaces kept retyping
- **cli:** tell people they are behind, without ever being in their way
- **documents:** a bound font, so a PDF can print a script the base-14 cannot
- **spec:** open references, so a project can declare what a bundle cannot
- **date-views:** window ranged calendars and timelines instead of capping them
- **documents:** a declared document is reachable, and the download flag is real
- **coordination:** one shared store for live fan-out and rate-limit budgets
- **workbench:** ask what you are building, and stop paying for panes nobody opened
- **workbench:** organise the surface around the app, not the review machinery
- **mcp:** answer mutations in the app's vocabulary, not only the spec's
- **dx:** convert owned-code knowledge into compile errors
- **cli:** init scaffolds the version control never-clobber assumes
- **cli:** make the cheap verification path an actual path
- **mcp:** give agents a place to put defects (report_defect)
- **mcp:** carry steering in every tool result, not just in descriptions

### Fixes
- **cli:** one origin across every dev path, so preferences stop resetting
- **web:** cap vitest workers — the last pglite package without one
- **features:** order-independent suites, and a real ordering bug behind one
- **web:** the cookie banner reserves its space instead of covering the form
- **ui:** numbers render plain, not thousands-grouped
- **cli:** the port probe could not see a wildcard listener
- **ui:** a date field you can type into, and that a test can drive
- **ci:** guarantee the Postgres suites positively, instead of inferring it
- **ci:** the Postgres-gated tests were still skipping — turbo stripped the variable
- **test:** typecheck the reference-rewrite assertions
- **schema:** refuse to rewrite a big table at boot, and fix the DDL splitter
- **portals:** declare the trusted-proxy assumption instead of assuming it
- **live:** refuse an undeliverable query channel where it is declared
- **ui:** a timestamp that survives hydration, and use it everywhere
- **gate:** check-boundaries reads statements, not lines, and proves it can
- **ui:** one data context for the whole app, not just for the admin
- **workbench:** key lists by identity, not by the text they happen to contain
- **docs:** document the host-gated tools instead of omitting them
- **review:** read ownership from every seam, not only from pages
- **routes:** let a page declare the app's root
- **sprout:** make every 4xx sufficient to fix the code
- **checks:** never return a green that means less than it looks
- **mcp:** refuse missing required arguments instead of defaulting them
- **core:** accept null through update for a nullable column

### Performance
- **core,features:** boot pglite from an empty-cluster snapshot, not initdb
- **features:** one pglite per test file, not one per test
- **ui:** stop 21 DOM-free test files paying for a document

_11 internal changes._

## 0.11.8 — 2026-07-31

### Features
- **spec:** the ledger records the new north star
- **spec:** give a proposed portal a review path
- **sources,schedules:** let one declaration cover every tenant
- **audit:** give the trail the two columns it was already being handed
- **sources:** give a borrowed identity a tenant, and the loop guard a type
- **sources,live:** give the two seams with no execution path one

### Fixes
- **runtime:** serve a spec page declared under /admin
- **docs:** repoint the references the ceremony deletion orphaned
- **runtime:** serve a spec page at the route it declares
- **review:** derive the undo offer instead of assuming it
- **sources:** pass the borrowed runAs in the determinism test's enqueue
- **gen:** emit the four non-page seams, and wire their registries to the runtime
- **gate:** a braceless if may not guard an empty statement
- **sprout:** a date column accepts the form it reads back as

_22 internal changes._

## 0.11.7 — 2026-07-29

### Features
- add
- **ownership:** drift derives every family, and names what an authored file was written against
- **l3:** day fifty, on a project that got there — the long-lived fixture
- **l3:** the eject tax, itemized — owned files survive install and upgrade, and you find out what you're missing
- **l3:** upgrade safety — a pinned old project, lived in, carried forward
- **l2:** live queries and bounded presence — the scope line is a type, not a paragraph
- **l2:** public and token-scoped surfaces — the outside is a projection enforced where the gate is, not a route that selects columns
- **l2:** declared importers — the dry-run is a signature, not a policy, and the bespoke half stops at parsing
- **l2:** document generation — a printed invoice is not a page you print, and the PDF is written rather than screenshotted
- **l2:** full-text search — a ranked index is a declaration, and the gate it passes is the list's
- **l2:** external data sources — a fetch is a declaration, and the spec never holds the key
- **l2:** board views — a Kanban board is three declarations, not a feature
- **l2:** calendar, heatmap and timeline views — one date primitive, not three features
- **l2:** block-level slots — make bespoke UI cost 3 instead of 5
- **catalog:** browse, preview and pick modules
- **compliance,observability:** derived export/erasure, redacted logs
- **webhooks:** signed outbound, verified inbound, SSRF-checked
- **jobs:** declared recurrence, a durable job runtime, and the jobs bundle
- **notifications:** declared types, derived opt-outs, idempotent delivery
- **bundles:** combination-safety gate over the bundle lattice
- **flags,preferences:** flags in the spec, preferences derived
- **api-keys:** scoped programmatic access that cannot escalate
- **storage:** declared file fields, signed reads, derivatives
- **features:** bundle contract v2, mechanically enforced
- **cli,runtime:** one command from a description to a populated app
- **cli,harness:** npx as the documented entry, and a preflight that names the fix
- **web,ui:** surface computed fields and rollups in the read path
- **web:** ground computed fields and rollups into runtime shapes
- **core:** evaluate computed fields and rollups at runtime
- **spec:** rollups over computed fields, multi-hop paths, and a corpus that can express relations
- **spec:** typed ops for computed fields and rollups
- add-entity --with-page — land entity + default page in one shot

### Fixes
- **cli:** declare @anthropic-ai/sdk, and fail the build on an undeclared import
- **release:** keep vitest out of the runtime graph, and derive runtime deps from every inlined package
- **ownership:** ejecting in place is not the clobber case — swap the banner
- **ci:** the lattice gate moves to two tiers — the sweep nightly, a stated sample per PR
- **deps:** pin sharp to ^0.35.3 — high-severity libvips CVEs below it
- **website,turbo:** a structural frontmatter guard, and stop caching a red gate
- **features:** declare the bundle FKs that cost no migration
- **core:** build the relation graph from columns, not drizzle FKs
- Fix the SSR hydration trap in useStore at the source; add the sanctioned gate
- **mcp:** query_spec {section:"ops"} carries per-op arg JSON schemas
- Fix zombie cookie banner via two-pass render

### Other changes
- Declare the bundle organization relations
- more harness and website
- more
- Site polish: an OG card, heading-level search, reader-facing titles, cited numbers
- Make the marketing and docs sites read as a finished product
- Comprehensive docs: generated reference pages + a docs website from the same source
- Op-log origin records the author; cookie banner only when there's a disclosure
- Make runtime bugs diagnosable from inside a project: source maps, doctor, runtime link
- page.setBlockFields — lists choose which fields they show

_50 internal changes._

## 0.11.6 — 2026-07-23

### Fixes
- **dev:** auto-select the owned dev server when owned modules exist
- **skills:** run-next-task degrades to a spec-derived backlog when TASKS.md is absent

### Other changes
- Design system as part of the spec: theme.set + list variants
- Enforce pglite's single-writer contract across processes
- Make the spec-first path actually happen: stdio MCP, a guard hook, and a build-app skill

## 0.11.5 — 2026-07-21

### Features
- **cli:** init prompts for a project name, scaffolds into./<kebab-case-name>

### Fixes
- **cli:** sanction the CLI authoring path when MCP cold-starts absent
- **cli:** aim maxstack demo at the dev server actually running, never a blind port 3000
- **web:** answer GET /mcp with a clean JSON-RPC 405 instead of an unhandled error

### Other changes
- publish update

_2 internal changes._

## 0.11.4 — 2026-07-18

### Features
- add maxstack readme

### Fixes
- **cli:** report maxstack demo success only after seeded rows are visible
- **cli:** pin dev server to IPv4 loopback so host agrees by construction
- fix mcp

### Other changes
- validate
- make init nicer

_1 internal change._

## 0.11.1 — 2026-07-18

### Fixes
- **cli:** probe both IPv4 and IPv6 in maxstack dev portInUse
- **cli:** scaffold CLAUDE.md on init + route demo seed through running dev server

### Other changes
- move docs

_1 internal change._

## 0.11.0 — 2026-07-18

### Features
- add new publish script
- security baseline + browser smoke checks in CI
- enforceable operating model + completion-evidence governance
- mechanical architecture boundary enforcement
- add doc

### Fixes
- **cli:** serve /assets in dev + add-page sugar + eject arg order
- **ci:** raise vitest timeouts for the harness eval/determinism suites
- clear noNonNullAssertion lint debt so validate gate is green
- sign-in page + bundle route-writes match from-spec table columns

### Other changes
- dogfood
- create secrets

_3 internal changes._

## 0.10.4 — 2026-07-16

### Features
- add changelog

### Fixes
- init stamps product.json with today's date, not a hardcoded literal
- quickstart shows a populated admin; init agrees with website
- reword validate's runtime-derived-app message
- propose and apply share one validator; apply never 500s
- MCP-applied spec ops land accepted, not undecided

## 0.10.3 — 2026-07-15

### Features
- add spec to admin

### Other changes
- more
- more

## 0.10.2 — 2026-07-15

### Fixes
- Fix 9 findings: runtime vendoring, CLI ops, dev server, auth, config

## 0.10.1 — 2026-07-14

### Features
- **cli:** dev --owned serves owned code from npm; unify dev on port 3000 (.mcp.json fix)
- **cli:** maxstack-runtime companion package — dev/demo/build/deploy work from npm (0.10.0)

### Fixes
- **cli:** fall back to the authenticated gh account when gitRemote is the shipped your-org placeholder

### Other changes
- revamp spec format
- docs+cli: reposition owned code as a deliberate step, not an everyday change

## 0.9.1 — 2026-07-13

- Initial release.
