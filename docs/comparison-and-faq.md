# How this compares, and the questions that follow

The two questions people ask first: *how is this different from the AI app
builders?* and *what actually happens when I eject?* Both are answered here in
full, including the parts that don't favour us.

The rule this page is written under is the same one
[`measurement.md`](measurement.md) states: **nothing here is a claim about being
faster or better than another tool.** No head-to-head with a control arm has
been run, so no such claim would be supportable. What follows is a description
of a different shape, and what that shape costs.

## What the builders do well, said plainly

v0, Lovable, Bolt and Replit Agent get you from a sentence to a working thing in
a browser tab, with no local toolchain, in a few minutes. That is a genuinely
hard problem and they have solved it. If what you need is a prototype by
lunchtime, or a UI to show someone this afternoon, they are the better choice
and this page is not going to argue otherwise.

**They also do not trap your code.** All four export to GitHub — that was true
when this page was written (verified August 2026) and it is worth saying
outright, because "they lock you in" is the lazy version of this comparison and
it is not accurate. What varies between them is the surrounding coupling —
managed hosting, a bundled backend, a particular deploy target — not whether you
can take the repository with you.

So the difference is not *whether you get the code*. It is **what you have after
you get it.**

## The actual difference

Export from a builder and you have a conventional application: migrations,
forms, validators, list pages, API routes, permission checks — all as files, all
now yours. That is a completely normal way to own software, and it is what most
of the industry does. The cost is that every one of those files is something you
maintain by hand from that point on, and that the next feature means writing the
same categories of file again.

Here, those things are **derived from a typed spec at runtime** rather than
written out as files. Declare an entity and you get its admin screens, its REST
endpoints and its agent tools without a file appearing in your repository for
you to review — and without one falling behind when the framework improves. Add
the sixteenth entity and it costs what the first one did, because you are
declaring, not writing.

That is a bet about the *shape* of the cost curve, not about the starting point.
It is measured over one project's own life in
[`long-lived-fixture.md`](long-lived-fixture.md), and it is measured
non-comparatively — that page says what the number is and what it is not.

**When the bet does not pay.** If your app has three entities and one screen,
the machinery genuinely does not earn its keep, and a starter kit plus an agent
is the sensible choice. The design targets applications that keep growing, which
is a narrower claim than "use this for everything."

## What about a starter kit, or Rails, or a CMS-shaped framework?

This is the sharper version of the question and it deserves a straight answer.

A starter kit gives you a fixed set of features wired on day one, and from day
two they are yours — you delete what you don't want and hand-write what wasn't
included. Kits do move forward: MakerKit's CLI merges its upstream and hands the
conflicts to an AI assistant, Wasp recompiles on a new framework version and
ships a prose guide for the code it didn't write. So the claim here is about the
*shape* of the upgrade, not its absence. The [feature
bundles](bundle-reference.md) install into a *live* app rather than at scaffold
time, know about each other, and move forward under an app that already exists
as a versioned install record plus a typed codemod, through the same validated
spec-op path as `maxstack add` — deterministic, and `checkBundleContract` fails
the build on a gap rather than leaving one for you to find. Every
prerequisite-closed combination of them is proved by a gate rather than assumed:
all 4047 nightly, an adversarially-ranked 256 of them on every PR; see
[`combination-safety.md`](combination-safety.md).

A CMS-shaped framework that derives an admin from a schema is the closest
relative to what happens here, and the resemblance is real. The difference being
attempted is scope: not a content admin generalized, but the whole application
surface — API, permissions, audit, imports, agent tools — with the same
derivation, and with the agent surface at the framework level rather than bolted
on.

## Model-driven development tried this and died. Why is this different?

The honest answer starts by agreeing with the objection. Model-driven
development failed on the round-trip problem: the model expressed most of the
app, the rest went into generated code, and the next generation ate it. That is
the correct thing to be afraid of, and any tool in this shape should be judged
on it before anything else.

Two differences are offered, and both are checkable rather than promised:

1. **The remainder has somewhere to live that regeneration may not touch.**
   Three places, in escalating order — see the next section. This is enforced by
   a regeneration-safety suite that fails the build, not by a comment asking
   politely. [`ownership.md`](ownership.md) is the contract.
2. **The ceiling is not fixed by what we hand-author.** Templates are starting
   points a model specializes, so what the system can express moves with model
   capability rather than with one team's authoring throughput.

The check that settles it takes about a minute: run the generator twice over a
tree you have hand-edited, and see what happens to your edits.

## What happens when I eject?

Three rungs, and you should always take the lowest one that expresses the
change:

1. **Change the spec.** Most changes are this. Adding a field, a page, a
   permission, a relationship.
2. **Fill a slot.** When the spec can't express something *inside* an otherwise
   ordinary page, a [block slot](block-slots.md) takes your component and the
   rest of the page stays derived.
3. **Eject the file.** It becomes ordinary React Router, Drizzle and Postgres
   code, in your repository, and the framework never writes to it again.

**The trade, stated flatly: an ejected file stops receiving improvements.**
Permanently. If the framework later generates that page better — a new list
capability, a fix, a performance change — your ejected copy does not get it, in
exactly the way a file you wrote yourself does not get it. That is the deal, and
nobody should find it out after they have committed.

Two things make it survivable. Eject is **per file**, so the blast radius is one
page rather than the application. And the ladder exists so that most change
never reaches rung three — which is a claim you can check against
[`ownership.md`](ownership.md) rather than take on faith.

Everything below the spec layer is stock: React Router, Drizzle, Postgres, Zod,
better-auth, Tailwind, shadcn. There is no proprietary runtime to be stranded
on, and an ejected tree is an ordinary application on ordinary libraries.

## What the spec cannot express today

Known and named, because finding these out yourself is worse:

- a reference that names more than one entity (many-to-many, polymorphic)
- permissions below resource granularity — per-record grants, field-level access
- viewer-relative filters, for "whichever tenant is looking"
- one ranked search across several tables
- composite import keys, where a row is identified by more than one field
- nightly files arriving from object storage
- declarable condition→action rules

Four of those were only discovered by building an application large enough to
hit them. Each is a filed issue rather than a roadmap adjective, and each one is
reachable today through eject — that is what the ladder is for.

## Is any of this measured?

Some of it, and the page that says what is *not* measured is the same page that
says what is: [`measurement.md`](measurement.md). Two things worth reading
before you believe anything else here:

- [`long-lived-fixture.md`](long-lived-fixture.md) — a replay of one project's
  real change history, and what the cost per safe change did across it.
- [`harness-metrics.md`](harness-metrics.md) — how first-build cost is measured,
  including the ratio that is deliberately *not* given a unit word.

There is no comparative benchmark. When one is run, it will be published with
its configuration and its losses.

## Related

- [`ownership.md`](ownership.md) — the full contract for what regeneration may
  touch
- [`write-paths.md`](write-paths.md) — every path that can change the spec, and
  who may accept
- [`quickstart.md`](quickstart.md) — the fastest way to stop reading and check
