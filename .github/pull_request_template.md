<!-- Thanks for the patch. Keep this short — the diff says most of it. -->

## What this changes

## Why

<!-- If it fixes a bug, what was the failure? A change whose reason is in the
     commit and not in the code tends to lose the reason. Consider leaving the
     explanation as a comment at the site too. -->

## How you verified it

<!-- `pnpm validate` green is the baseline, not the whole answer. If this
     touches the runtime, say whether you drove it in a real project
     (`maxstack runtime link`) and what you saw. -->

- [ ] `pnpm validate` passes
- [ ] Added or updated a test that fails without this change
- [ ] Ran `pnpm docs:reference` if this adds a CLI flag or a spec-op

<!-- Reminder from CONTRIBUTING.md: never make a gate pass by weakening it. If
     a test or check is genuinely wrong, change it in its own commit with the
     reasoning, not as part of a feature. -->
