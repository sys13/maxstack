# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue.

Use GitHub's [private vulnerability
reporting](https://github.com/sys13/maxstack/security/advisories/new) on this
repository. If that is unavailable to you, email **daniel.arrizza@gmail.com**
with `maxstack security` in the subject.

Please include:

- what an attacker can do, and what access they need to start;
- the affected version (`maxstack --version`) and, if relevant, the store
  backend (pglite or Postgres);
- a minimal reproduction — a spec plus the requests that exercise it is ideal.

**Response expectations.** This project is maintained by one person, so please
allow up to 7 days for an initial reply and treat any timeline as best-effort
rather than a guarantee. You will get an acknowledgement, an assessment, and a
note when a fix ships. If you plan to disclose publicly, tell us when — we would
rather coordinate than be surprised, and we will not ask you to delay
indefinitely.

## Supported versions

Fixes land on the latest released version of `maxstack` and `maxstack-runtime`,
which ship in lockstep. There are no long-term support branches while the
project is pre-1.0.

## What is in scope

The framework and what it generates: the CLI, the runtime app (admin UI, REST
API, MCP transport), the permission and validation layers, the feature bundles,
and the code the generators emit into a user's project.

Particularly interesting areas, because they are where a spec becomes an
externally reachable surface:

- **Portals** — declared public endpoints. Field projection, write budgets and
  rate limits are the boundary.
- **The permission layer** — authorization is enforced there rather than at a
  route, precisely because `/mcp` and admin loaders do not pass through route
  gates. A path that reaches data without passing the permission layer is a bug
  worth reporting.
- **External sources** — outbound fetches, which carry SSRF protection.
- **API keys and scopes**.

## What is out of scope

- The dev-mode admin fallback. With no auth bundle installed and
  `MAXSTACK_AUTH_STRICT` unset, the runtime deliberately grants local admin
  access so a fresh project is usable. That is documented behaviour, not a
  vulnerability — see `docs/security-baseline.md`.
- Anything requiring an attacker to already control the spec, the data
  directory, or the machine. The spec is trusted input: it is code.
- Denial of service by supplying a deliberately enormous spec.
- Vulnerabilities in dependencies with no exploitable path through maxstack.
  Report those upstream; tell us if we can shorten the exposure.

## Handling of secrets

Credentials are referenced by **name** in a spec and resolved from the
environment at runtime — a spec never carries a secret value, and the codec
drops any value that reaches it. If you find a path where a secret value is
persisted into a spec, a log or a generated file, that is in scope.
