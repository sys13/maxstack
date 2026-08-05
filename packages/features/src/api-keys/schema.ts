/**
 * API-key schema (task 57; promoted to a catalog bundle in issue #186) — a
 * personal access token per row. Only a SHA-256 hash of the token is stored,
 * never the plaintext; `prefix` is the first chars of the token, kept so a user
 * can tell keys apart in the list without ever re-displaying the secret.
 * `scope` reuses task 35's `SproutAction` vocabulary
 * (`read`/`create`/`update`/`delete`) keyed by resource name, the same
 * identifiers the REST layer and `ResourceCapabilities` already use.
 *
 * Three columns arrived with the bundle promotion, all nullable so an existing
 * `api_key` table upgrades with `ADD COLUMN IF NOT EXISTS` and no data
 * migration:
 *
 *   - `organizationId` — a key may be pinned to one org. An api-key request
 *     carries no cookie worth trusting, so this is the *only* source of an
 *     active org for a key identity (see `resolveActiveOrg` in the app). Null
 *     means the key is not org-pinned and reaches no tenant-scoped resource.
 *   - `rateLimitPerMinute` — a per-key budget, overriding the deployment
 *     default. Null means "use the deployment default".
 *   - `expiresAt` — an optional hard expiry, checked at verify time alongside
 *     revocation.
 */

import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const apiKey = pgTable('api_key', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	name: text('name').notNull(),
	prefix: text('prefix').notNull(),
	tokenHash: text('token_hash').notNull().unique(),
	scope: jsonb('scope').notNull().$type<Record<string, string[]>>(),
	organizationId: text('organization_id'),
	rateLimitPerMinute: integer('rate_limit_per_minute'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	expiresAt: timestamp('expires_at'),
	lastUsedAt: timestamp('last_used_at'),
	revokedAt: timestamp('revoked_at'),
})

/**
 * Idempotent DDL for the `api_key` table. Safe to run on every boot, which is
 * what the bundle's composition-root install and the app's lazy first-use
 * guard both do — `api_key` is a text-id table this feature manages directly,
 * not a uuid table `from-spec` derives, so it travels as raw `ddl` exactly like
 * better-auth's tables do.
 */
export const API_KEYS_DDL = `
CREATE TABLE IF NOT EXISTS api_key (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scope jsonb NOT NULL,
  organization_id text,
  rate_limit_per_minute integer,
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp,
  last_used_at timestamp,
  revoked_at timestamp
);
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS organization_id text;
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer;
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS expires_at timestamp;
`

/**
 * Portal tokens — the credential behind a `token`-audience portal.
 *
 * A second table rather than nullable columns on `api_key`, and that is a
 * safety property rather than tidiness: the permission layer reads an *absent*
 * `apiKeyScope` as "an unrestricted session", so a key row that could exist with
 * no scope would be a credential that widens by omission. Nothing can mistake a
 * row in this table for an api key.
 *
 * It stores three facts and no permissions: which portal, which row, and the
 * hash. **What the portal may see is read from the declaration**, so a token can
 * never carry a projection the exposure report does not know about.
 */
export const portalToken = pgTable('portal_token', {
	id: text('id').primaryKey(),
	/** The declared portal this token opens. Not a foreign key: the spec is not a table. */
	portalKey: text('portal_key').notNull(),
	/** The one row a `row`-scoped portal's token opens; null for a collection. */
	rowId: text('row_id'),
	/** SHA-256 of the token. The plaintext is shown once at mint and never stored. */
	tokenHash: text('token_hash').notNull().unique(),
	/** Hard use cap; null = unlimited opens within the TTL. */
	maxUses: integer('max_uses'),
	/** Opens so far, incremented on every successful verify. */
	uses: integer('uses').notNull().default(0),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	/** Required, never null — there is no non-expiring portal token. */
	expiresAt: timestamp('expires_at').notNull(),
	lastUsedAt: timestamp('last_used_at'),
	revokedAt: timestamp('revoked_at'),
})

/**
 * Idempotent DDL for `portal_token`, run on every boot beside {@link API_KEYS_DDL}.
 *
 * **The `CREATE TABLE IF NOT EXISTS` trap is the reason the `ALTER TABLE` lines
 * exist**, and it has bitten this repo twice: `CREATE TABLE IF NOT EXISTS` does
 * exactly nothing on a database that already has the table, so a column added to
 * an existing table is never created and the failure shows up as a missing
 * column at the first write rather than at boot. Every column that could ever
 * arrive after the first release gets its own explicit
 * `ADD COLUMN IF NOT EXISTS`, including the ones present in the CREATE today —
 * the cost is one statement and the alternative is a broken upgrade.
 *
 * `expires_at` is the one exception that cannot be added blind: it is `NOT NULL`
 * with no default, so it is emitted nullable in the ALTER and left to the CREATE
 * to constrain. A pre-existing table without it has no tokens worth keeping.
 */
export const PORTAL_TOKENS_DDL = `
CREATE TABLE IF NOT EXISTS portal_token (
  id text PRIMARY KEY,
  portal_key text NOT NULL,
  row_id text,
  token_hash text NOT NULL UNIQUE,
  max_uses integer,
  uses integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL,
  last_used_at timestamp,
  revoked_at timestamp
);
ALTER TABLE portal_token ADD COLUMN IF NOT EXISTS row_id text;
ALTER TABLE portal_token ADD COLUMN IF NOT EXISTS max_uses integer;
ALTER TABLE portal_token ADD COLUMN IF NOT EXISTS uses integer NOT NULL DEFAULT 0;
ALTER TABLE portal_token ADD COLUMN IF NOT EXISTS expires_at timestamp;
ALTER TABLE portal_token ADD COLUMN IF NOT EXISTS last_used_at timestamp;
ALTER TABLE portal_token ADD COLUMN IF NOT EXISTS revoked_at timestamp;
CREATE INDEX IF NOT EXISTS portal_token_portal_key_idx ON portal_token (portal_key);
`
