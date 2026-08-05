# Measurement

What is measured about maxstack, how, and — as importantly — what the numbers do
not say.

Every figure here is **non-comparative and self-checkable**. Nothing on this page
is a claim about being faster or better than another tool: no head-to-head has
been run with a control arm, so no such claim would be supportable. What follows
are properties of this system that you can reproduce yourself.

## Cold start

**What is measured.** Wall-clock from `npx maxstack start "<description>"` on a
machine that has never seen maxstack, to the moment the app answers on its port.

**Why it is fussy.** "Cold" is the whole measurement, and it is easy to fake by
accident. A run that reuses a warm npm cache measures almost nothing. The
method therefore forces a fresh `HOME`, a fresh npm cache and a fresh install
prefix, and refuses to call itself cold if it fetched less than a megabyte —
because a run that downloaded nothing was not a cold run, however long it took.

**What dominates it.** Dependency weight, not code. The bytes fetched over the
network are the number that moves the total; that is why the runtime tarball's
contents are treated as a budget rather than an afterthought, and why test files
are excluded from the vendored runtime snapshot.

**How to check it yourself.** Time it on a machine that has never installed
maxstack, or in a fresh container:

```sh
docker run --rm -it node:22 sh -c \
  'time npx --yes maxstack@latest start "a bug tracker" --no-dev'
```

**Caveat, stated plainly.** The last recorded figure was taken against the
`init` entry on an older release, before the runtime snapshot was pruned. It
has not been re-measured against `start` on the current version, so treat any
specific number you find in older notes as unverified for today's entry point.
Measure it yourself; that is the point of publishing the method rather than the
number.

## Regeneration safety

**What it means.** Regenerating an app from its spec must never destroy work you
own, and must never lose a manually added item.

**How it is enforced.** Not as a target — as a gate. Every regeneration in the
test suite is bracketed by a safety check, and a run that is not 100% safe fails
rather than reporting a percentage. Three invariants carry it:

- regeneration never deletes manually added items;
- generation grounds only on *accepted* items;
- eject copies with a banner and never overwrites an existing file.

**How to check it yourself.** `maxstack validate` in any project reports spec
validity, manifest integrity and regeneration safety. Eject a route, edit it,
regenerate, and confirm your edit survives.

## Combination safety

**What it means.** Feature bundles compose. Any subset of the catalog that a
user could install must produce a valid spec and a working app.

**How it is checked.** By sweeping bundle subsets rather than sampling the ones
that seemed likely — order-dependence between bundles is exactly the class of
bug that a hand-picked sample misses. The sweep is expensive, so it runs in the
maintainer's own CI rather than on every pull request here.

**What it does not prove.** That every *combination of user specs* works — only
that catalog bundles compose. Your own entities and pages are outside its
reach.

## Upgrade safety

**What it means.** Upgrading a project to newer framework generators must not
silently change or drop things the user added by hand.

**How it is checked.** Against pinned fixtures captured at an older bundle
version — including hand-added spec items an upgrade must not touch — then
regenerated forward and compared.

## What is deliberately not measured here

- **Any comparison to another framework or stack.** A comparison needs a control
  arm run under a pre-registered protocol. That has not happened, so there is no
  number, and an unqualified "faster than" would be unsupported.
- **Leverage ratios** (application produced per line of declaration). The
  measurement apparatus for this exists but its results depend heavily on how the
  denominator is defined, and a ratio does not license a claim in units.
- **Time-to-Nth-safe-change** over a long-lived project. Interesting, and
  instrumented, but it takes months of real use to say anything honest.

If you want to argue with a number here, the method is the argument surface. Open
an issue with what you measured and how.
