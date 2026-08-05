# Scheduled work — delivery semantics

> The one page to read before writing a handler.

## Delivery is at-least-once

Between "the handler did the work" and "the store recorded that it did" there is
a window. A process that dies inside it leaves a row that looks exactly like one
whose handler never ran, and the runtime cannot tell the two apart — so it
retries. **A handler will see the same work twice.**

Exactly-once delivery is not something this system withholds pending a future
release. It is not achievable, and a job system that claims it is a job system
that will double-charge somebody.

## What you get instead: a key the database enforces

Every scheduled occurrence is enqueued with

```
idempotencyKey = schedule:<key>:<occurrence ISO instant>
```

behind a **unique index**, not an application check. So:

| Situation | What happens |
|---|---|
| Two worker processes tick at the same moment | One job. The loser reads the winner's row back. |
| A process dies mid-tick and restarts | The occurrences it already claimed are no-ops. |
| A handler throws and is retried | Same job row, same `ctx.idempotencyKey`, `ctx.attempt` incremented. |

`ctx.idempotencyKey` is the tool. Key your writes on it — a unique constraint, an
upsert, a "have I already recorded this" check — and a repeat becomes a no-op.
Ignore it and a retry becomes a duplicate email, a duplicate invoice, or a
duplicate charge.

`ctx.scheduledFor` is the instant the run was **due**, not the instant it ran. A
catch-up run after an outage still buckets into the right period.

## A run runs as somebody

`runAs` is required on every declared schedule, with no default and no admin
shorthand:

```ts
runAs: { kind: 'service', role: 'billing' }   // resolved through the same RBAC path a session is
runAs: { kind: 'user', userId: 'usr_123' }    // that user's role, org and plan
```

Scheduled work is where implicit admin creeps in. A job holding more authority
than any human caller is an authorization bypass with a cron expression in front
of it, so the identity is a declaration rather than an accident.

## Calendars have written answers

| Case | Answer |
|---|---|
| Monthly on the 31st, in a 30-day month | Fires on the **last day** of that month. Never skipped, never rolled forward. |
| Monthly on the 29th–31st in February | Same clamp — the 28th, or the 29th in a leap year. |
| A local time that does not exist (spring forward) | Fires at the **next instant that does** — 02:30 becomes 03:30. |
| A local time that happens twice (fall back) | Fires **once**, at the first occurrence. |
| `interval` recurrence across a DST change | Unaffected. An interval is elapsed absolute time. |

Every row has a test in `packages/spec/src/base/schedules.test.ts`.

## Failure is visible

- **Retries** back off exponentially (1s, 2s, 4s, …, capped at 30s) up to
  `maxAttempts`.
- **Permanent failures** — an unfilled handler slot, a run that arrived with no
  identity — skip the retry budget and dead-letter at once. Backoff exists to
  ride out a flaky downstream, not to delay a message about a decision nobody
  has made.
- **Dead-lettered** jobs are listed on `/jobs`, with a per-job retry that grants
  exactly one more attempt rather than resetting the counter.
- **Catch-up** after an outage is bounded and the dropped occurrences are
  *reported* (`ScheduleTick.skipped`). A missed run you can see is an operational
  fact; a missed run you cannot is a mystery.

## Your code goes in the slot

Each declared schedule generates `jobs/<key>.handler.ts`, written once and never
regenerated. The registry beside it (`jobs/schedules.generated.ts`) is rewritten
on every build; your handler is not. That is deliberate: bespoke scheduling logic
— an SM-2 spaced-repetition next-due computation, a dunning ladder — belongs in
code you own, and absorbing it into the op vocabulary would be the
framework-as-cage failure.
